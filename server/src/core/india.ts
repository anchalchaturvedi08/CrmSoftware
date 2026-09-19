/**
 * Indian states and union territories (DECISIONS.md section 32).
 *
 * The customer base is domestic, so a state is a choice from a list rather
 * than free text: "UP", "U.P." and "Uttar pradesh" typed into three complaints
 * are three different places to every report and every service-center match.
 * Cities are typed — there are thousands, and the client should not have to
 * maintain a list — but each one is filed under a state from here.
 *
 * Kept on the server as well as the client because the server is where it is
 * enforced: a form is a convenience, not a guarantee.
 */

/** The 28 states, then the 8 union territories, each in its official spelling. */
export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Andaman and Nicobar Islands',
  'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Lakshadweep',
  'Puducherry',
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];

/** Older or shorter names people still type, and what they mean here. */
const ALSO_KNOWN_AS: Record<string, IndianState> = {
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  uttaranchal: 'Uttarakhand',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  'jammu & kashmir': 'Jammu and Kashmir',
  'andaman & nicobar islands': 'Andaman and Nicobar Islands',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
};

const key = (value: string): string =>
  value.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');

const BY_KEY = new Map<string, IndianState>(INDIAN_STATES.map((state) => [key(state), state]));

/**
 * The official name for what someone typed, or null when it is not a state.
 *
 * Case and spacing are ignored, and a few familiar older names are accepted,
 * so data typed before this list existed still resolves.
 */
export function canonicalState(value: string | null | undefined): IndianState | null {
  if (!value) return null;
  const lookup = key(value);
  return BY_KEY.get(lookup) ?? ALSO_KNOWN_AS[lookup] ?? null;
}

/**
 * A city name as it is stored and compared: trimmed, inner spaces collapsed.
 *
 * Capitals are left as typed — "New Delhi" should read as the person wrote it
 * — but matching is case-insensitive, so one city never becomes two.
 */
export function cleanCityName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
