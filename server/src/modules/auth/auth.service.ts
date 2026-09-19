/**
 * Auth business rules.
 *
 * All of the actual decisions live here, not in the controller — spec section
 * 19: "Keep business rules in backend services."
 *
 * Properties this file is written to preserve:
 *
 * **No user enumeration.** A wrong mobile number and a wrong password produce
 * the same message, the same status code, and — via `dummyVerify` — roughly
 * the same response time. Any of those three differing would let someone map
 * which numbers have accounts.
 *
 * **Lockout counted per account, not just per IP.** Section 19 makes the
 * backend the real gate. Per-IP limits are defeated by rotating addresses, so
 * failures accumulate on the user record too — and each attempt is counted
 * *before* its password is checked, in one atomic update, so a burst of
 * guesses sent at once gets no more tries than guesses sent one by one.
 *
 * **Each sign-in is a session the server can end.** Signing out deletes that
 * device's `AuthSession`, and `refresh` refuses a token whose session is gone.
 *
 * **Every attempt audited.** Section 17 wants actor, action and time recorded;
 * failed logins are exactly the events worth having later.
 */
import type { Request } from 'express';
import type { Types } from 'mongoose';
import { config } from '../../config/env.js';
import { recordAudit } from '../../core/audit.js';
import {
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../../core/password.js';
import {
  invalidToken,
  issueTokens,
  verifyToken,
  type IssuedTokens,
} from '../../core/tokens.js';
import { AppError, badRequest, unauthenticated } from '../../http/errors.js';
import {
  SERVICE_CENTER_DEACTIVATED,
  serviceCenterDeactivated,
} from '../../middleware/authenticate.js';
import {
  AuthSession,
  MAX_SESSIONS_PER_USER,
  User,
  newSessionId,
  type UserDoc,
} from '../../models/index.js';
import type { ChangePasswordInput, LoginInput } from './auth.validation.js';

/** What the client gets back after a successful login or refresh. */
export interface SessionResponse extends IssuedTokens {
  user: {
    id: string;
    name: string;
    role: UserDoc['role'];
    mobile: string;
    serviceCenterId?: string;
    mustChangePassword: boolean;
  };
}

/** The single message used for every credential failure. */
const CREDENTIALS_REJECTED = 'Mobile number or password is incorrect';

/** The identity a token pair carries, read from the user record. */
function tokenIdentity(user: UserDoc) {
  return {
    userId: String(user._id),
    role: user.role,
    ...(user.serviceCenterId ? { serviceCenterId: String(user.serviceCenterId) } : {}),
  };
}

/* Tokens and identity only: the session's expiry is server bookkeeping, not
   something to hand the client. */
function sessionFor(user: UserDoc, tokens: IssuedTokens): SessionResponse {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    user: {
      id: String(user._id),
      name: user.name,
      role: user.role,
      mobile: user.mobile,
      ...(user.serviceCenterId
        ? { serviceCenterId: String(user.serviceCenterId) }
        : {}),
      mustChangePassword: user.mustChangePassword,
    },
  };
}

/* ---- Lockout ------------------------------------------------------------ */

/**
 * Counts one sign-in attempt against the account, before its password is
 * checked. Returns null when the account is locked.
 *
 * Why before, and why in one update: the previous version checked the lock,
 * verified the password (~60ms of scrypt), then saved `failedLoginAttempts + 1`
 * from the copy it had read. Twenty wrong passwords sent at once all passed
 * the lock check, all took their guess, and all saved the same count of 1 —
 * so the account never locked at all.
 *
 * Now a single `findOneAndUpdate` on the one document does the check and the
 * count together, and MongoDB applies those one at a time: with a limit of
 * five, only five attempts can be under way per lockout, however many arrive.
 * The fifth locks the account in that same update — before its password is
 * even looked at — so no attempt is ever let through in the gap between
 * "counted" and "locked". If the fifth password turns out to be right,
 * `login` clears the lock again.
 *
 * Counting a successful attempt too is harmless: success resets the count.
 */
async function claimAttempt(
  userId: Types.ObjectId,
): Promise<{ lockedAccount: boolean } | null> {
  const now = new Date();
  const lockUntil = new Date(now.getTime() + config.LOGIN_LOCKOUT_MINUTES * 60_000);
  /* Evaluated against the count after this attempt was added. */
  const reachedLimit = { $gte: ['$failedLoginAttempts', config.LOGIN_MAX_ATTEMPTS] };

  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      /* Not locked: never locked, or the lock has run out. */
      $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
    },
    [
      {
        $set: {
          failedLoginAttempts: { $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1] },
        },
      },
      {
        $set: {
          /* An expired lock is removed rather than left lying around. */
          lockedUntil: { $cond: [reachedLimit, lockUntil, '$$REMOVE'] },
          /* The count restarts with the lock, as it always has: once the
             lockout ends, the next person to try gets the full allowance. */
          failedLoginAttempts: { $cond: [reachedLimit, 0, '$failedLoginAttempts'] },
        },
      },
    ],
    { new: true },
  )
    .select('lockedUntil')
    .lean()
    .exec();

  if (!claimed) return null;
  return { lockedAccount: claimed.lockedUntil !== undefined };
}

/** Whole minutes left on a lock, for the message. Read fresh: it may be new. */
async function minutesUntilUnlocked(userId: Types.ObjectId): Promise<number> {
  const current = await User.findById(userId).select('lockedUntil').lean().exec();
  const until = current?.lockedUntil?.getTime() ?? Date.now();
  return Math.max(1, Math.ceil((until - Date.now()) / 60_000));
}

/* ---- Sessions ----------------------------------------------------------- */

/**
 * Records a new sign-in and issues its tokens.
 *
 * Then trims the person's sessions to `MAX_SESSIONS_PER_USER`, ending the ones
 * used least recently, so sign-ins that are never signed out cannot pile up.
 */
async function startSession(user: UserDoc): Promise<SessionResponse> {
  const sessionId = newSessionId();
  const tokens = issueTokens({ ...tokenIdentity(user), sessionId });

  await AuthSession.create({
    _id: sessionId,
    userId: user._id,
    expiresAt: tokens.refreshExpiresAt,
  });

  const surplus = await AuthSession.find({ userId: user._id })
    .sort({ expiresAt: -1 })
    .skip(MAX_SESSIONS_PER_USER)
    .select('_id')
    .lean()
    .exec();

  if (surplus.length > 0) {
    await AuthSession.deleteMany({ _id: { $in: surplus.map((s) => s._id) } }).exec();
  }

  return sessionFor(user, tokens);
}

/* ---- Login -------------------------------------------------------------- */

/**
 * Authenticates a mobile number and password.
 */
export async function login(
  input: LoginInput,
  request?: Request,
): Promise<SessionResponse> {
  const user = await User.findOne({ mobile: input.mobile })
    .select('+passwordHash')
    .exec();

  if (!user) {
    /* Burn comparable time so a missing account is not detectably faster
       than a wrong password. */
    await dummyVerify();
    await recordAudit({
      entityType: 'User',
      action: 'LOGIN_FAILED_NO_ACCOUNT',
      note: `No account for mobile ending ${input.mobile.slice(-4)}`,
      ...(request ? { request } : {}),
    });
    throw unauthenticated(CREDENTIALS_REJECTED);
  }

  const actor = { userId: String(user._id), role: user.role, name: user.name };

  /* Deactivated accounts are told plainly. This does reveal that the account
     exists — but the person is a real member of staff who needs to know why
     they cannot get in, and they have already proved nothing either way at
     this point. The alternative is a support call for every offboarded user. */
  if (!user.isActive) {
    await recordAudit({
      entityType: 'User',
      entityId: String(user._id),
      action: 'LOGIN_BLOCKED_INACTIVE',
      actor,
      ...(request ? { request } : {}),
    });
    throw new AppError(403, 'FORBIDDEN', 'This account has been deactivated');
  }

  /* The same for a deactivated service center, for the same reason. Checked
     before the password on purpose: an account that cannot sign in anyway
     must not be usable to test guesses, and a "right password" answer here
     would be exactly that. */
  if (await serviceCenterDeactivated(user)) {
    await recordAudit({
      entityType: 'User',
      entityId: String(user._id),
      action: 'LOGIN_BLOCKED_CENTER_INACTIVE',
      actor,
      ...(request ? { request } : {}),
    });
    throw new AppError(403, 'FORBIDDEN', SERVICE_CENTER_DEACTIVATED);
  }

  const attempt = await claimAttempt(user._id);

  if (!attempt) {
    /* Known, accepted gap in "no user enumeration": this 429 only fires for a
       mobile number that has an account (a missing one never reaches here —
       it returned 401 above), so a locked-out response does confirm the
       number is registered. Narrowing that would mean locking out guesses
       against numbers with no account either, which has no account to
       protect and would only let an attacker lock a real one out by name.
       Left as is; not a redesign for this pass. */
    const minutes = await minutesUntilUnlocked(user._id);
    await recordAudit({
      entityType: 'User',
      entityId: String(user._id),
      action: 'LOGIN_BLOCKED_LOCKED',
      actor,
      ...(request ? { request } : {}),
    });
    throw new AppError(
      429,
      'RATE_LIMITED',
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const ok = await verifyPassword(input.password, user.passwordHash);

  if (!ok) {
    /* Already counted, and the lock already applied if this was the last
       try — `claimAttempt` did both before the password was checked. */
    await recordAudit({
      entityType: 'User',
      entityId: String(user._id),
      action: attempt.lockedAccount ? 'LOGIN_FAILED_ACCOUNT_LOCKED' : 'LOGIN_FAILED_BAD_PASSWORD',
      actor,
      ...(request ? { request } : {}),
    });

    throw unauthenticated(CREDENTIALS_REJECTED);
  }

  /**
   * Success: clear the failure state and note the login.
   *
   * An explicit update, not `user.save()`: the count was raised in the
   * database by `claimAttempt`, so the copy loaded above is stale, and saving
   * "0" over a loaded 0 would be seen as no change and never written.
   *
   * Opportunistic rehash rides along. This is the only moment the plaintext
   * password is available, so raising the scrypt cost parameters later can be
   * applied gradually as people sign in, rather than requiring a mass reset.
   */
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        failedLoginAttempts: 0,
        lastLoginAt: new Date(),
        ...(needsRehash(user.passwordHash)
          ? { passwordHash: await hashPassword(input.password) }
          : {}),
      },
      $unset: { lockedUntil: 1 },
    },
  ).exec();

  const session = await startSession(user);

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: 'LOGIN_SUCCESS',
    actor,
    ...(request ? { request } : {}),
  });

  return session;
}

/* ---- Refresh ------------------------------------------------------------ */

/**
 * Exchanges a refresh token for a new pair.
 *
 * Re-checks the account rather than trusting the token: a refresh token issued
 * before someone was deactivated, before their password changed, or before
 * their service center was deactivated must not mint fresh access. And the
 * token's session must still exist — signing out deletes it.
 */
export async function refresh(
  refreshToken: string,
  request?: Request,
): Promise<SessionResponse> {
  const claims = verifyToken(refreshToken, 'refresh');

  /* A token minted before sessions were stored names none, so signing out
     could never revoke it. Refused like any other unusable token; the person
     signs in once and carries on. */
  if (!claims.sid) {
    throw invalidToken();
  }

  const user = await User.findById(claims.sub).exec();
  if (!user || !user.isActive) {
    throw unauthenticated('Your session is no longer valid. Please sign in again.');
  }

  /* Millisecond comparison, for the reason explained in `authenticate`: JWT
     `iat` is too coarse to tell a fresh sign-in from a revoked token. */
  if (user.passwordChangedAt) {
    if (claims.issuedAtMs < user.passwordChangedAt.getTime()) {
      throw unauthenticated('Your password was changed. Please sign in again.');
    }
  }

  if (await serviceCenterDeactivated(user)) {
    throw unauthenticated(SERVICE_CENTER_DEACTIVATED);
  }

  const tokens = issueTokens({ ...tokenIdentity(user), sessionId: claims.sid });

  /**
   * Confirm the session is still live and extend it, in one step.
   *
   * Extending keeps a device in daily use signed in indefinitely, as before;
   * the new refresh token's expiry becomes the session's. Doing both in one
   * conditional update means a sign-out landing at the same moment either
   * happens first — and this refuses — or happens after, and deletes the
   * session this just extended. Either way the session ends.
   *
   * A signed-out session gets exactly the rejection a forged token does.
   */
  const { matchedCount } = await AuthSession.updateOne(
    { _id: claims.sid, userId: user._id, expiresAt: { $gt: new Date() } },
    { $set: { expiresAt: tokens.refreshExpiresAt } },
  ).exec();

  if (matchedCount === 0) {
    throw invalidToken();
  }

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: 'TOKEN_REFRESHED',
    actor: { userId: String(user._id), role: user.role, name: user.name },
    ...(request ? { request } : {}),
  });

  return sessionFor(user, tokens);
}

/* ---- Logout ------------------------------------------------------------- */

/**
 * Ends the session a refresh token belongs to — that device only.
 *
 * Identified by the refresh token rather than the access token, because the
 * access token has often expired by the time someone signs out, and signing
 * out must still work then.
 *
 * Idempotent: a session already ended is not an error, so a retried request
 * or a second tap is harmless, and the answer does not reveal whether the
 * token had been revoked before. Anything that is not a valid refresh token
 * is refused as usual.
 *
 * The access token issued alongside stays usable for the rest of its fifteen
 * minutes; the client discards both tokens as it signs out.
 */
export async function logout(refreshToken: string, request?: Request): Promise<void> {
  const claims = verifyToken(refreshToken, 'refresh');

  /* A token from before sessions were stored has nothing to end, and
     `refresh` refuses it already. */
  if (!claims.sid) return;

  const { deletedCount } = await AuthSession.deleteOne({
    _id: claims.sid,
    userId: claims.sub,
  }).exec();

  if (deletedCount === 0) return;

  const user = await User.findById(claims.sub).select('role name').lean().exec();

  await recordAudit({
    entityType: 'User',
    entityId: claims.sub,
    action: 'LOGOUT',
    ...(user ? { actor: { userId: claims.sub, role: user.role, name: user.name } } : {}),
    ...(request ? { request } : {}),
  });
}

/* ---- Change password ---------------------------------------------------- */

/**
 * Changes the caller's own password.
 *
 * Setting `passwordChangedAt` is what revokes tokens already in circulation —
 * both middleware and `refresh` refuse anything minted at or before it. Without
 * that, changing a compromised password would leave the attacker's refresh
 * token working for its full thirty days. The person's stored sessions are
 * deleted too: they can never be used again, and would otherwise count against
 * the per-person session limit until they expired.
 *
 * This also clears `mustChangePassword`, which is how a technician created with
 * a temporary password by their Owner (DECISIONS.md section 4.5) gains access
 * to the rest of the application.
 */
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
  request?: Request,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash').exec();
  if (!user) {
    throw unauthenticated('Authentication required');
  }

  const ok = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!ok) {
    await recordAudit({
      entityType: 'User',
      entityId: String(user._id),
      action: 'PASSWORD_CHANGE_FAILED',
      actor: { userId: String(user._id), role: user.role, name: user.name },
      ...(request ? { request } : {}),
    });
    throw badRequest('Current password is incorrect', [
      { field: 'currentPassword', message: 'Current password is incorrect' },
    ]);
  }

  user.passwordHash = await hashPassword(input.newPassword);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;

  await user.save();
  await AuthSession.deleteMany({ userId: user._id }).exec();

  await recordAudit({
    entityType: 'User',
    entityId: String(user._id),
    action: 'PASSWORD_CHANGED',
    actor: { userId: String(user._id), role: user.role, name: user.name },
    note: 'All existing sessions were revoked',
    ...(request ? { request } : {}),
  });
}
