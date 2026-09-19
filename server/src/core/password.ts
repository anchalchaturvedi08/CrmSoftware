/**
 * Password hashing (spec section 19: "Passwords must be securely hashed").
 *
 * Uses scrypt from Node's standard library. Argon2id would be the first
 * choice, but the `argon2` package needs a native toolchain that is not
 * present on the development machine (DECISIONS.md section 7.1). scrypt is
 * memory-hard, is in the standard library, and is an accepted choice
 * alongside Argon2id and bcrypt — so this costs nothing but the swap.
 *
 * Stored format is self-describing:
 *
 *     scrypt$N$r$p$keylen$<salt-base64url>$<hash-base64url>
 *
 * Carrying the parameters in the string is what makes them upgradable. Raising
 * the cost later does not invalidate existing hashes: each one still verifies
 * against the parameters it was created with, and `needsRehash` reports which
 * ones should be re-derived the next time their owner logs in successfully.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Promisified scrypt.
 *
 * Written out rather than using `promisify`, which resolves to the
 * three-argument overload and silently discards the options object — meaning
 * the cost parameters below would be ignored and every hash would be derived
 * at Node's defaults.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/**
 * Current cost parameters.
 *
 * N = 2^15 puts memory use at 128 * N * r = 32 MiB per hash, which is a
 * meaningful brute-force cost while staying comfortable for an internal tool
 * whose login volume is a few dozen people a day.
 */
const CURRENT = {
  N: 32_768,
  r: 8,
  p: 1,
  keylen: 64,
} as const;

/** Node's default maxmem is 32 MiB, which our own N and r sit exactly at. */
const MAXMEM = 96 * 1024 * 1024;

const SALT_BYTES = 16;
const ALGORITHM = 'scrypt';

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  keylen: number;
  salt: Buffer;
  hash: Buffer;
}

function encode(params: ParsedHash): string {
  return [
    ALGORITHM,
    params.N,
    params.r,
    params.p,
    params.keylen,
    params.salt.toString('base64url'),
    params.hash.toString('base64url'),
  ].join('$');
}

/** Parses a stored hash, returning null when it is not one we can read. */
function decode(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 7) return null;

  const [algorithm, rawN, rawR, rawP, rawKeylen, rawSalt, rawHash] = parts;
  if (algorithm !== ALGORITHM) return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  const keylen = Number(rawKeylen);

  if (![N, r, p, keylen].every((n) => Number.isInteger(n) && n > 0)) return null;
  if (!rawSalt || !rawHash) return null;

  return {
    N,
    r,
    p,
    keylen,
    salt: Buffer.from(rawSalt, 'base64url'),
    hash: Buffer.from(rawHash, 'base64url'),
  };
}

/** Derives a key with explicit parameters. */
async function derive(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> {
  /* Normalizing to NFC means a password typed with a composed accent verifies
     against one stored decomposed. Without it, the same keystrokes on a
     different keyboard can fail to match. */
  const normalized = password.normalize('NFC');

  return scrypt(normalized, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAXMEM,
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, CURRENT);
  return encode({ ...CURRENT, salt, hash });
}

/**
 * Verifies a password against a stored hash.
 *
 * Comparison is timing-safe. A byte-by-byte early return would leak how much
 * of a guess was correct, which over enough attempts reconstructs the hash.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = decode(stored);
  if (!parsed) return false;

  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed);
  } catch {
    /* Malformed parameters in the stored hash — treat as a failed verify
       rather than a server error, and let `needsRehash` flag it. */
    return false;
  }

  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

/** True when a stored hash was made with parameters weaker than current. */
export function needsRehash(stored: string): boolean {
  const parsed = decode(stored);
  if (!parsed) return true;

  return (
    parsed.N < CURRENT.N ||
    parsed.r < CURRENT.r ||
    parsed.p < CURRENT.p ||
    parsed.keylen < CURRENT.keylen
  );
}

/**
 * Burns roughly the same time as a real verification.
 *
 * Called on the login path when no account matches the mobile number. Without
 * it, a missing user returns markedly faster than a wrong password, and that
 * difference alone tells an attacker which numbers are registered.
 */
export async function dummyVerify(): Promise<void> {
  await derive('timing-equalizer', Buffer.alloc(SALT_BYTES), CURRENT);
}
