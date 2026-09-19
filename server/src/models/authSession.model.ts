/**
 * AuthSession — one signed-in device.
 *
 * Signing out has to end the session on the server, not just forget the tokens
 * on the phone. Before this existed a refresh token copied off a device kept
 * minting access tokens for its full thirty days after the owner signed out;
 * only a password change or deactivation could stop it, and both of those end
 * *every* device at once.
 *
 * So each sign-in creates one of these, and both tokens it issues carry the
 * record's id as their `sid` claim. `POST /auth/refresh` refuses a token whose
 * session is gone, and `POST /auth/logout` deletes the one session the token
 * names — the person's other devices are untouched.
 *
 * Named `AuthSession`, not `Session`, because "session" already means a
 * MongoDB transaction session throughout this codebase.
 *
 * ## What it deliberately does not do
 *
 * - **It is not consulted on every request.** `authenticate` still re-reads the
 *   user, but not this, so an access token already copied keeps working for
 *   the rest of its fifteen minutes after sign-out. Password change and
 *   deactivation remain immediate, because those are checked on the user.
 * - **No refresh-token rotation.** Every refresh keeps the same `sid`, and an
 *   older refresh token of a live session still works. Rotation with reuse
 *   detection would catch a copied token being used alongside the real one,
 *   but two tabs renewing at the same moment look exactly like that theft and
 *   would sign the person out. Possible later hardening.
 *
 * ## Why rows are deleted
 *
 * Section 17's "no hard delete" covers operational records. A session is a
 * credential, not a record of work: keeping a revoked one would only keep
 * something alive that must never work again. Sign-ins and sign-outs are
 * recorded in the audit log, which is where that history belongs.
 */
import { randomBytes } from 'node:crypto';
import { Schema, type Types } from 'mongoose';
import { baseSchemaOptions, defineModel } from './common/base.js';

export interface AuthSessionDoc {
  /** Random id, carried by the session's tokens as the `sid` claim. */
  _id: string;
  userId: Types.ObjectId;

  /**
   * When the session's newest refresh token expires.
   *
   * Pushed forward on every refresh, so a device in daily use stays signed in
   * exactly as it did before sessions were stored, while one left in a drawer
   * lapses thirty days after it was last used.
   */
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Sign-ins one person can hold at once.
 *
 * Without a ceiling, every sign-in that is never signed out — a cleared
 * browser, a phone replaced — would leave a row behind, and a script signing
 * in over and over could grow the collection as fast as it liked. Ten covers a
 * desk, a laptop and a phone with room to spare. Past it, the session used
 * least recently is ended; `expiresAt` is what orders them, since every
 * refresh moves it.
 */
export const MAX_SESSIONS_PER_USER = 10;

/** A new, unguessable session id. */
export function newSessionId(): string {
  return randomBytes(16).toString('base64url');
}

const authSessionSchema = new Schema<AuthSessionDoc>(
  {
    _id: { type: String, required: true },
    /* Not `refActive`: a deactivated user's sessions are refused by the auth
       checks, and reactivating the account must not need them recreated. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);

/**
 * MongoDB removes a session once its refresh token has expired.
 *
 * The TTL monitor runs about once a minute, so an expired row can linger
 * briefly — every read also filters on `expiresAt`, and never trusts the row
 * merely for existing.
 */
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/* One person's sessions, newest first: the per-user ceiling, and ending all
   of them when the password changes. */
authSessionSchema.index({ userId: 1, expiresAt: -1 });

export const AuthSession = defineModel<AuthSessionDoc>('AuthSession', authSessionSchema);
