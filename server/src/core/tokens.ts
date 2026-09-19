/**
 * JWT issuing and verification.
 *
 * Access and refresh tokens are signed with **different secrets**. If one
 * secret leaked, an attacker holding it could otherwise mint refresh tokens
 * and keep access indefinitely; with separate keys the blast radius of an
 * access-secret leak is one token lifetime.
 *
 * A token carries the role and service-center scope so ordinary requests do
 * not need a database round trip to know what the caller may do. It is still
 * only a *claim*: `authenticate` re-loads the user and re-checks activity and
 * revocation on every request, because a token minted before someone was
 * deactivated would otherwise keep working for its full lifetime.
 *
 * Both tokens also name the sign-in they belong to (`sid`), which is what lets
 * signing out on one device end that device's session and no other — see
 * `models/authSession.model.ts`.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config/env.js';
import { unauthenticated } from '../http/errors.js';
import type { Role } from '../models/enums.js';

export type TokenKind = 'access' | 'refresh';

/** Claims we put in a token beyond the registered JWT ones. */
export interface TokenClaims {
  /** User id. */
  sub: string;
  role: Role;
  /** Present for Owner and Technician; absent for the global Admin. */
  serviceCenterId?: string;
  kind: TokenKind;

  /**
   * Session id: the `AuthSession` this sign-in created.
   *
   * Every token issued now carries one. It is optional here only because a
   * token minted before sessions were stored has none — and `refresh` refuses
   * such a token, since there is nothing on the server that could revoke it.
   */
  sid?: string;

  /**
   * Issue time in **milliseconds**.
   *
   * The registered `iat` claim has one-second resolution, which is too coarse
   * to decide revocation. Changing a password and signing straight back in
   * produces a token stamped in the same second as the change, so a
   * second-resolution comparison must either reject that legitimate token or
   * honour genuinely revoked ones — and which one happens depends on whether
   * the two calls straddle a second boundary, so it fails intermittently
   * either way.
   *
   * This claim makes the comparison exact.
   */
  ims: number;
}

/** A verified token, including the registered claims we care about. */
export interface VerifiedToken extends TokenClaims {
  /** Issued-at, in seconds, from the JWT standard claim. */
  iat: number;
  exp: number;
  /** Issue time in milliseconds, for revocation. See `ims` above. */
  issuedAtMs: number;
}

const ISSUER = 'cooler-crm';

function secretFor(kind: TokenKind): string {
  return kind === 'access' ? config.JWT_ACCESS_SECRET : config.JWT_REFRESH_SECRET;
}

function ttlFor(kind: TokenKind): string {
  return kind === 'access' ? config.JWT_ACCESS_TTL : config.JWT_REFRESH_TTL;
}

function sign(claims: TokenClaims): string {
  const options: SignOptions = {
    issuer: ISSUER,
    expiresIn: ttlFor(claims.kind) as SignOptions['expiresIn'],
  };

  return jwt.sign(claims, secretFor(claims.kind), options);
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/** Issued tokens, plus what the server needs to keep the session in step. */
export interface IssuedSessionTokens extends IssuedTokens {
  /**
   * When the refresh token expires. The stored session is kept exactly this
   * long. Read back from the signed token rather than recomputed, so the two
   * cannot disagree however `JWT_REFRESH_TTL` is written.
   */
  refreshExpiresAt: Date;
}

/**
 * The rejection for a token that cannot be used: forged, malformed, the wrong
 * kind — or, from `refresh`, one whose session was signed out. They share one
 * answer so a revoked token is indistinguishable from an invalid one.
 */
export const invalidToken = () => unauthenticated('Invalid authentication token');

export function issueTokens(
  input: { userId: string; role: Role; serviceCenterId?: string; sessionId: string },
): IssuedSessionTokens {
  /* One timestamp for both tokens, so a refresh issued alongside an access
     token cannot be judged differently by a millisecond. */
  const ims = Date.now();

  const base = {
    sub: input.userId,
    role: input.role,
    ...(input.serviceCenterId ? { serviceCenterId: input.serviceCenterId } : {}),
    sid: input.sessionId,
    ims,
  };

  const refreshToken = sign({ ...base, kind: 'refresh' });
  const { exp } = jwt.decode(refreshToken) as { exp: number };

  return {
    accessToken: sign({ ...base, kind: 'access' }),
    refreshToken,
    refreshExpiresAt: new Date(exp * 1000),
  };
}

/**
 * Verifies a token and confirms it is the kind expected.
 *
 * The `kind` check is not ceremony. Both token types carry the same claims, so
 * without it a long-lived refresh token would be accepted as an access token —
 * silently turning a 15-minute window into 30 days.
 */
export function verifyToken(token: string, expected: TokenKind): VerifiedToken {
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, secretFor(expected), { issuer: ISSUER });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw unauthenticated('Your session has expired. Please sign in again.');
    }
    throw invalidToken();
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw invalidToken();
  }

  const claims = decoded as Partial<VerifiedToken>;

  if (
    typeof claims.sub !== 'string' ||
    typeof claims.role !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    throw invalidToken();
  }

  if (claims.kind !== expected) {
    throw invalidToken();
  }

  /* Fall back to the second-resolution claim for any token minted before
     `ims` existed, so an in-flight session is not invalidated by a deploy. */
  const issuedAtMs =
    typeof claims.ims === 'number' ? claims.ims : claims.iat * 1000;

  return {
    sub: claims.sub,
    role: claims.role as Role,
    ...(claims.serviceCenterId ? { serviceCenterId: claims.serviceCenterId } : {}),
    kind: expected,
    ...(typeof claims.sid === 'string' && claims.sid ? { sid: claims.sid } : {}),
    iat: claims.iat,
    exp: claims.exp,
    ims: issuedAtMs,
    issuedAtMs,
  };
}

/** Reads a bearer token out of an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;

  return value.trim() || null;
}
