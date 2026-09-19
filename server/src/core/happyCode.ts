/**
 * Happy Code generation, encryption and verification (spec sections 6.3, 22).
 *
 * The Happy Code is the customer's confirmation that the job was actually
 * done. Admin reads it back from them on the phone and enters it, and only a
 * match permits closure — it is the last gate in the whole workflow.
 *
 * ## Encrypted, not hashed
 *
 * Section 18 suggests storing `happy_code_hash`. We encrypt instead, because a
 * hash cannot be read back — and the code reaches the customer only through a
 * WhatsApp message Admin sends by hand (section 6.4), which section 6.4 itself
 * *disables* when the phone number is invalid, while section 15 forbids every
 * other channel. A hash would therefore turn one bad phone number into a
 * complaint that can never be closed. Admin can re-read and re-send.
 * Full reasoning in DECISIONS.md section 4.2.
 *
 * AES-256-GCM is authenticated encryption: tampering with the stored
 * ciphertext is detected on decryption rather than silently yielding a
 * different code.
 *
 * ## Why attempts are capped
 *
 * A 6-digit numeric code is one million possibilities. Unlimited attempts
 * would let anyone with access to the confirmation screen walk the space in an
 * afternoon, which would make the control decorative. `HAPPY_CODE_MAX_ATTEMPTS`
 * caps it; exhausting the cap locks the code until Admin regenerates it.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '../config/env.js';
import { AppError } from '../http/errors.js';
import type { HappyCodeMeta, HappyCodeSecret } from '../models/index.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
/** Digits in a Happy Code; exported so the Settings page states the real rule. */
export const HAPPY_CODE_DIGITS = 6;

function key(): Buffer {
  /* Validated as 64 hex characters at startup by config/env.ts. */
  return Buffer.from(config.HAPPY_CODE_KEY, 'hex');
}

/**
 * Generates a uniformly random 6-digit code.
 *
 * `randomInt` is used rather than `randomBytes(n) % 1000000`: the modulo
 * approach biases toward lower values because 2^k is not a multiple of 10^6,
 * which would make some codes measurably likelier to guess.
 */
export function generateHappyCode(): string {
  return String(randomInt(0, 10 ** HAPPY_CODE_DIGITS)).padStart(HAPPY_CODE_DIGITS, '0');
}

/** Encrypts a code for storage. A fresh IV per call — never reused. */
export function encryptHappyCode(code: string): HappyCodeSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);

  const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypts a stored code.
 *
 * Throws if the ciphertext or tag has been altered, or if the key has changed
 * — GCM authenticates as it decrypts, so a corrupted record cannot quietly
 * produce a wrong-but-plausible code.
 */
export function decryptHappyCode(secret: HappyCodeSecret): string {
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(secret.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));

    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError(
      500,
      'INTERNAL_ERROR',
      'The stored Happy Code could not be read. It may need to be regenerated.',
    );
  }
}

/** A freshly issued code plus the metadata that tracks its use. */
export interface IssuedHappyCode {
  /** Plaintext — for the WhatsApp message only. Never persist this. */
  code: string;
  secret: HappyCodeSecret;
  meta: HappyCodeMeta;
}

export function issueHappyCode(): IssuedHappyCode {
  const code = generateHappyCode();

  return {
    code,
    secret: encryptHappyCode(code),
    meta: {
      issuedAt: new Date(),
      attempts: 0,
      regenerationCount: 0,
    },
  };
}

/** Re-issues a code, carrying the regeneration count forward. */
export function regenerateHappyCode(previous: HappyCodeMeta): IssuedHappyCode {
  const code = generateHappyCode();

  return {
    code,
    secret: encryptHappyCode(code),
    meta: {
      issuedAt: new Date(),
      attempts: 0,
      regenerationCount: previous.regenerationCount + 1,
    },
  };
}

export interface VerificationResult {
  ok: boolean;
  /** Metadata to persist, whichever way it went. */
  meta: HappyCodeMeta;
}

/**
 * Checks a code the Admin typed against the stored one.
 *
 * Comparison is timing-safe. Returns a result rather than throwing on
 * mismatch, because the caller must persist the incremented attempt count
 * either way — an attempt that is not recorded is an attempt that does not
 * count toward the cap.
 */
export function verifyHappyCode(
  input: string,
  secret: HappyCodeSecret,
  meta: HappyCodeMeta,
): VerificationResult {
  if (meta.verifiedAt) {
    /* Already verified — re-verifying is a no-op, not a spent attempt. */
    return { ok: true, meta };
  }

  if (meta.lockedAt) {
    throw new AppError(
      423,
      'HAPPY_CODE_LOCKED',
      'Too many incorrect attempts. Regenerate the Happy Code and send it to the customer again.',
    );
  }

  const expected = decryptHappyCode(secret);
  const candidate = input.trim();

  /* Length is checked first because timingSafeEqual throws on a mismatch.
     Code length is fixed and public, so this leaks nothing. */
  const matches =
    candidate.length === expected.length &&
    timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));

  if (matches) {
    return { ok: true, meta: { ...meta, verifiedAt: new Date(), attempts: 0 } };
  }

  const attempts = meta.attempts + 1;
  const exhausted = attempts >= config.HAPPY_CODE_MAX_ATTEMPTS;

  return {
    ok: false,
    meta: {
      ...meta,
      attempts,
      ...(exhausted ? { lockedAt: new Date() } : {}),
    },
  };
}

/** Attempts left before the code locks. */
export function attemptsRemaining(meta: HappyCodeMeta): number {
  if (meta.lockedAt) return 0;
  return Math.max(0, config.HAPPY_CODE_MAX_ATTEMPTS - meta.attempts);
}
