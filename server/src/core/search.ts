/**
 * Turning what someone typed into a query.
 *
 * Shared so every search box treats a term the same way — above all a mobile
 * number, which the screens show grouped ("98765 43210") and which people
 * therefore type grouped, or with +91 in front. Stored numbers are ten bare
 * digits, so those terms matched nothing until they were reduced to digits.
 */

/** A term as a literal, case-insensitive pattern: no regex syntax gets through. */
export function searchPattern(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The digits of a term typed as a phone number, or null when it is not one.
 *
 * "98765 43210", "+91 98765-43210" and "098765 43210" all give "9876543210";
 * a partial "98765 4" gives "987654". Letters mean it is a name, not a number.
 */
export function mobileSearchDigits(term: string): string | null {
  const trimmed = term.trim();
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;

  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+91') || (digits.length === 12 && digits.startsWith('91'))) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  return digits.length > 0 ? digits : null;
}

/**
 * The pattern for a mobile field: the typed digits when the term is a number,
 * otherwise the term itself.
 */
export function mobilePattern(term: string): RegExp {
  const digits = mobileSearchDigits(term);
  return digits ? new RegExp(escapeRegex(digits)) : searchPattern(term);
}
