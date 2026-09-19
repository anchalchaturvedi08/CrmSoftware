/**
 * Model registry.
 *
 * Importing this module registers every schema with Mongoose. That ordering
 * matters: the referential-integrity plugin resolves a reference by looking up
 * `mongoose.models[name]` at write time, so a model that has never been
 * imported would make its references unverifiable. Importing the barrel once
 * at startup removes that whole class of problem.
 */
export * from './enums.js';
export * from './common/base.js';
export * from './common/referentialIntegrity.js';

export { Counter, nextSequence } from './counter.model.js';
export { Territory, City } from './geography.model.js';
export type { TerritoryDoc, CityDoc } from './geography.model.js';
export { Product, ProductModel } from './catalog.model.js';
export type { ProductDoc, ProductModelDoc } from './catalog.model.js';
export { User } from './user.model.js';
export type { UserDoc } from './user.model.js';
export { AuthSession, MAX_SESSIONS_PER_USER, newSessionId } from './authSession.model.js';
export type { AuthSessionDoc } from './authSession.model.js';
export { ServiceCenter } from './serviceCenter.model.js';
export type { ServiceCenterDoc } from './serviceCenter.model.js';
export { Customer } from './customer.model.js';
export type { CustomerDoc } from './customer.model.js';
export { Complaint } from './complaint.model.js';
export type {
  ComplaintDoc,
  ClosureRecord,
  CustomerSnapshot,
  HappyCodeMeta,
  HappyCodeSecret,
  ProductSnapshot,
  ResolutionReview,
  ServiceAddressSnapshot,
  SlaTracking,
} from './complaint.model.js';
export { Visit } from './visit.model.js';
export type {
  VisitDoc,
  Diagnosis,
  RescheduleRecord,
  VisitResolution,
  WorkPerformed,
} from './visit.model.js';
export { Part, PartStock, PartRequest, PartUsage, PART_UNITS } from './parts.model.js';
export type {
  PartDoc,
  PartStockDoc,
  PartRequestDoc,
  PartUsageDoc,
  PartUnit,
} from './parts.model.js';
export { ComplaintActivity, AuditLog } from './activity.model.js';
export type {
  ComplaintActivityDoc,
  AuditLogDoc,
  AuditChange,
} from './activity.model.js';
export { Attachment } from './attachment.model.js';
export type { AttachmentDoc } from './attachment.model.js';
export { SlaRule, DEFAULT_SLA_RULES } from './slaRule.model.js';
export type { SlaRuleDoc } from './slaRule.model.js';

/**
 * The 17 entities from spec section 18, in that section's order, with what
 * each maps to here. Kept as a comment rather than code so the mapping can be
 * checked against the spec without reading every file.
 *
 *   1. Admin User          -> User (role ADMIN)
 *   2. Service Center      -> ServiceCenter
 *   3. City                -> City
 *   4. Territory           -> Territory
 *   5. Technician          -> User (role TECHNICIAN)
 *   6. Customer            -> Customer
 *   7. Product             -> Product + ProductModel (DECISIONS.md 4.4)
 *   8. Complaint           -> Complaint
 *   9. Complaint Activity  -> ComplaintActivity
 *  10. Visit               -> Visit
 *  11. Attachment          -> Attachment
 *  12. Part                -> Part
 *  13. Part Stock          -> PartStock
 *  14. Part Request        -> PartRequest
 *  15. Part Usage          -> PartUsage
 *  16. SLA Rule            -> SlaRule
 *  17. Audit Log           -> AuditLog
 *
 * Plus one not in the spec's list: `Counter`, which makes complaint numbering
 * atomic (section 6.2). Counting existing complaints to derive the next number
 * is a race that mints duplicates.
 */
