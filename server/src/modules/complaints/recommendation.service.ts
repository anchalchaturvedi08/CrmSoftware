/**
 * Service center recommendation (spec section 8).
 *
 * Section 8 calls this a "Hybrid Recommendation Model" and then states the
 * constraint that governs the whole file, twice:
 *
 *   "Admin must manually select the final service center."
 *   "Never automatically assign."
 *
 * So this module **ranks and explains**. It returns an ordered list with a
 * reason against each entry. It never picks, never returns a single value that
 * a caller could mistake for a decision, and the complaint service does not
 * consult it when writing — the centre on a complaint is always the one the
 * Admin sent.
 *
 * Matching is by pincode, then city, then territory, in that order of
 * specificity. When nothing matches, section 22 requires every active centre
 * to be offered anyway, so manual selection is always possible.
 */
import { ServiceCenter, type ServiceCenterDoc } from '../../models/index.js';
import { findCityReadOnly } from '../masters/geography.resolve.js';
import type { Types } from 'mongoose';

/** Why a centre appears where it does, shown to Admin in the picker. */
export type MatchReason =
  | 'SERVES_PINCODE'
  | 'SERVES_CITY'
  | 'SAME_TERRITORY'
  | 'LOCATED_IN_CITY'
  | 'NO_MATCH';

export interface CenterRecommendation {
  center: ServiceCenterDoc;
  reason: MatchReason;
  /** Higher is a closer match. Exposed so the UI can group rather than guess. */
  score: number;
  /** One line explaining the match, for display next to the centre's name. */
  explanation: string;
}

/**
 * Ranking weights.
 *
 * Pincode beats city because a city can span many centres, and the pincode is
 * the finest granularity the spec gives us without coordinates.
 */
const SCORES: Record<MatchReason, number> = {
  SERVES_PINCODE: 100,
  SERVES_CITY: 70,
  LOCATED_IN_CITY: 60,
  SAME_TERRITORY: 30,
  NO_MATCH: 0,
};

const EXPLANATIONS: Record<MatchReason, string> = {
  SERVES_PINCODE: 'Covers this pincode',
  SERVES_CITY: 'Covers this city',
  LOCATED_IN_CITY: 'Located in this city',
  SAME_TERRITORY: 'In the same territory',
  NO_MATCH: 'No coverage match - manual selection',
};

export interface RecommendationQuery {
  pincode?: string | undefined;
  cityId?: Types.ObjectId | string | undefined;
  /**
   * A typed city name and state, in place of `cityId`, for the
   * create-complaint screen when it does not have a saved city id yet.
   * Resolved to a `cityId` read-only — see `resolveQueryCityId` below.
   */
  cityName?: string | undefined;
  state?: string | undefined;
  territoryId?: Types.ObjectId | string | undefined;
}

/** Best (most specific) reason a centre matches the query. */
function classify(
  center: ServiceCenterDoc,
  query: RecommendationQuery,
): MatchReason {
  /* A centre always covers its own pincode, whether or not the coverage list
     repeats it — otherwise the local centre would rank below any centre that
     merely listed the pincode. */
  if (
    query.pincode &&
    (center.pincode === query.pincode || center.servedPincodes.includes(query.pincode))
  ) {
    return 'SERVES_PINCODE';
  }

  if (query.cityId) {
    const cityId = String(query.cityId);
    if (center.servedCityIds.some((id) => String(id) === cityId)) {
      return 'SERVES_CITY';
    }
    /* A centre physically in the city is a sensible fallback even when its
       coverage list was never filled in — which, in practice, is most of them
       early on. */
    if (String(center.cityId) === cityId) {
      return 'LOCATED_IN_CITY';
    }
  }

  if (query.territoryId && String(center.territoryId) === String(query.territoryId)) {
    return 'SAME_TERRITORY';
  }

  return 'NO_MATCH';
}

export interface RecommendationResult {
  /** Centres that matched, best first. */
  recommended: CenterRecommendation[];
  /** Every other active centre, so manual selection is always possible. */
  others: CenterRecommendation[];
  /**
   * True when nothing matched and the full list is being offered instead —
   * the section 22 case. The UI should say so rather than implying these are
   * recommendations.
   */
  fellBackToAll: boolean;
}

/**
 * Resolves `cityName`+`state` to an existing city's id, read-only.
 *
 * The create-complaint screen may only have a typed name and state at this
 * point in the flow, not yet a saved `cityId`. A city that has never been
 * used before simply matches nothing here — this never creates one, since a
 * recommendation query is a read and section 22's "offer every active centre"
 * fallback already covers "no match".
 */
async function resolveQueryCityId(query: RecommendationQuery): Promise<string | undefined> {
  if (query.cityId) return String(query.cityId);
  if (!query.cityName || !query.state) return undefined;

  const city = await findCityReadOnly(query.cityName, query.state);
  return city ? String(city._id) : undefined;
}

/**
 * Ranks active service centers against a location.
 *
 * Only active centres are considered: section 8 says a deactivated centre
 * keeps its history but its open complaints must be reassigned, so it must not
 * be offered for new work. The `refActive` guard on `Complaint.serviceCenterId`
 * enforces the same thing at write time, independently of this list.
 */
export async function recommendServiceCenters(
  input: RecommendationQuery,
): Promise<RecommendationResult> {
  const query: RecommendationQuery = { ...input, cityId: await resolveQueryCityId(input) };

  const centers = await ServiceCenter.find({ isActive: true })
    .sort({ name: 1 })
    .exec();

  const classified = centers.map((center) => {
    const reason = classify(center, query);
    return {
      center,
      reason,
      score: SCORES[reason],
      explanation: EXPLANATIONS[reason],
    };
  });

  const recommended = classified
    .filter((entry) => entry.reason !== 'NO_MATCH')
    /* Score descending, then name ascending so the order is stable rather
       than dependent on insertion order. */
    .sort((a, b) => b.score - a.score || a.center.name.localeCompare(b.center.name));

  const others = classified.filter((entry) => entry.reason === 'NO_MATCH');

  return {
    recommended,
    others,
    fellBackToAll: recommended.length === 0,
  };
}
