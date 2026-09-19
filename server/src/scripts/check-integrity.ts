/**
 * Data integrity sweep.
 *
 * MongoDB enforces no referential integrity (DECISIONS.md section 3), so the
 * `referentialIntegrityPlugin` guards every write. This script checks the
 * other direction: whether anything already in the database is broken.
 *
 * It matters because the plugin can only guard writes that went *through* it.
 * A document inserted by a migration, a `mongosh` session, a restore from an
 * older backup, or a code path written before a rule existed has never been
 * validated. In a relational database the constraint would have caught all of
 * those; here, this script is the equivalent.
 *
 *   npm run check:integrity --workspace server
 *
 * Read-only. It reports and exits non-zero; it never repairs, because the
 * right repair depends on which side is wrong and that is a judgement call.
 */
import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { refRegistry } from '../models/common/referentialIntegrity.js';
import {
  Complaint,
  Counter,
  PartStock,
  SlaRule,
  User,
  Visit,
} from '../models/index.js';
import { PRIORITIES, TERMINAL_STATUSES } from '../models/enums.js';

interface Finding {
  severity: 'ERROR' | 'WARN';
  check: string;
  detail: string;
}

const findings: Finding[] = [];
const error = (check: string, detail: string) =>
  findings.push({ severity: 'ERROR', check, detail });
const warn = (check: string, detail: string) =>
  findings.push({ severity: 'WARN', check, detail });

/** Keeps the output readable when a check finds hundreds of the same thing. */
function summarise(ids: unknown[], limit = 5): string {
  const shown = ids.slice(0, limit).map(String).join(', ');
  return ids.length > limit ? `${shown} … and ${ids.length - limit} more` : shown;
}

/* ---- 1. Dangling references -------------------------------------------- */

/**
 * Every `ref` in the system, checked for targets that do not exist.
 *
 * Driven from `refRegistry`, which the model factory populates — so a
 * reference added later is swept automatically rather than needing to be
 * remembered here.
 */
async function checkReferences(): Promise<void> {
  for (const [modelName, refs] of refRegistry) {
    if (refs.length === 0) continue;

    const model = mongoose.models[modelName];
    if (!model) {
      warn('references', `model ${modelName} is registered but not compiled`);
      continue;
    }

    for (const ref of refs) {
      const target = mongoose.models[ref.modelName];
      if (!target) {
        error('references', `${modelName}.${ref.path} points at unknown model ${ref.modelName}`);
        continue;
      }

      /* Aggregate rather than loading documents: an orphan check over a large
         collection should not pull it into memory. */
      const orphans = await model
        .aggregate([
          { $match: { [ref.path]: { $ne: null, $exists: true } } },
          {
            $lookup: {
              from: target.collection.name,
              localField: ref.path,
              foreignField: '_id',
              as: '__target',
            },
          },
          { $match: { __target: { $size: 0 } } },
          { $project: { _id: 1, [ref.path]: 1 } },
          { $limit: 100 },
        ])
        .exec();

      if (orphans.length > 0) {
        error(
          'references',
          `${modelName}.${ref.path} -> ${ref.modelName}: ${orphans.length} orphan(s): ` +
          summarise(orphans.map((o) => o._id)),
        );
      }
    }
  }
}

/* ---- 2. Stock cannot be negative --------------------------------------- */

async function checkStock(): Promise<void> {
  const negative = await PartStock.find({ availableQuantity: { $lt: 0 } })
    .select('_id serviceCenterId partId availableQuantity')
    .lean()
    .exec();

  if (negative.length > 0) {
    /* The schema minimum and the conditional decrement should both prevent
       this. If it appears, something wrote stock outside the service layer. */
    error(
      'stock',
      `${negative.length} stock row(s) are negative: ` +
      summarise(negative.map((row) => `${row._id}(${row.availableQuantity})`)),
    );
  }
}

/* ---- 3. Complaint numbers are unique and well-formed ------------------- */

async function checkComplaintNumbers(): Promise<void> {
  const duplicates = await Complaint.aggregate([
    { $group: { _id: '$complaintNumber', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 },
  ]).exec();

  if (duplicates.length > 0) {
    /* A unique index should make this impossible. If it appears, the index is
       missing — which would mean the atomic counter is not the only thing
       standing between two complaints sharing an identifier. */
    error(
      'complaintNumber',
      `${duplicates.length} duplicate complaint number(s): ` +
      summarise(duplicates.map((d) => d._id)),
    );
  }

  const malformed = await Complaint.find({
    complaintNumber: { $not: /^CMP-\d{4}-\d{6}$/ },
  })
    .select('_id complaintNumber')
    .limit(50)
    .lean()
    .exec();

  if (malformed.length > 0) {
    warn(
      'complaintNumber',
      `${malformed.length} complaint number(s) do not match CMP-YYYY-NNNNNN: ` +
      summarise(malformed.map((c) => c.complaintNumber)),
    );
  }

  /**
   * The counter must be at least as high as the largest number issued.
   *
   * If it is behind, the next complaint will collide with an existing one and
   * be rejected by the unique index — an outage that looks like a random
   * failure to create complaints.
   */
  const latest = await Complaint.findOne().sort({ complaintNumber: -1 }).lean().exec();
  if (latest) {
    const [, year, sequence] = latest.complaintNumber.split('-');
    const counter = await Counter.findById(`complaint:${year}`).lean().exec();
    const highest = Number(sequence);

    if (!counter) {
      error(
        'counter',
        `complaints exist for ${year} but counter 'complaint:${year}' is missing — ` +
        'the next complaint will collide',
      );
    } else if (counter.seq < highest) {
      error(
        'counter',
        `counter for ${year} is at ${counter.seq} but ${latest.complaintNumber} exists — ` +
        'the next complaint will collide',
      );
    }
  }
}

/* ---- 4. Role and scope invariants -------------------------------------- */

async function checkUserScopes(): Promise<void> {
  const scopedWithoutCentre = await User.find({
    role: { $in: ['SERVICE_CENTER_OWNER', 'TECHNICIAN'] },
    $or: [{ serviceCenterId: null }, { serviceCenterId: { $exists: false } }],
  })
    .select('_id role name mobile')
    .lean()
    .exec();

  if (scopedWithoutCentre.length > 0) {
    /* `complaintScope` fails closed for these, so the account cannot work —
       but it is better to know before someone reports "I can't see anything". */
    error(
      'userScope',
      `${scopedWithoutCentre.length} scoped user(s) have no service center: ` +
      summarise(scopedWithoutCentre.map((u) => `${u.name}/${u.mobile}`)),
    );
  }

  const adminWithCentre = await User.find({
    role: 'ADMIN',
    serviceCenterId: { $ne: null, $exists: true },
  })
    .select('_id name mobile')
    .lean()
    .exec();

  if (adminWithCentre.length > 0) {
    error(
      'userScope',
      `${adminWithCentre.length} Admin(s) are attached to a service center: ` +
      summarise(adminWithCentre.map((u) => `${u.name}/${u.mobile}`)),
    );
  }

  const noAdmin = await User.countDocuments({ role: 'ADMIN', isActive: true }).exec();
  if (noAdmin === 0) {
    /* Only Admin can create complaints or close them. Without one the system
       is unusable and nothing in it can create the missing account. */
    error('userScope', 'there is no active Admin — nobody can create or close complaints');
  }
}

/* ---- 5. Complaint state coherence -------------------------------------- */

async function checkComplaintState(): Promise<void> {
  const checks: Array<[string, Record<string, unknown>, string]> = [
    [
      'closed without a timestamp',
      { status: 'CLOSED', $or: [{ closedAt: null }, { closedAt: { $exists: false } }] },
      'CLOSED complaints must record when and by whom',
    ],
    [
      'closed without a verified Happy Code',
      {
        status: 'CLOSED',
        $or: [{ 'happyCode.verifiedAt': null }, { 'happyCode.verifiedAt': { $exists: false } }],
      },
      'section 22 requires the code to be verified before closure',
    ],
    [
      'assigned without a service center',
      {
        status: { $nin: ['NEW', 'CANCELLED'] },
        $or: [{ serviceCenterId: null }, { serviceCenterId: { $exists: false } }],
      },
      'only NEW may have no service center',
    ],
    [
      'technician assigned without a technician',
      {
        status: { $in: ['TECHNICIAN_ASSIGNED', 'VISIT_SCHEDULED', 'IN_PROGRESS'] },
        $or: [{ technicianId: null }, { technicianId: { $exists: false } }],
      },
      'these statuses imply an assigned technician',
    ],
    [
      'cancelled without a reason',
      {
        status: 'CANCELLED',
        $or: [{ cancellationReason: null }, { cancellationReason: { $exists: false } }],
      },
      'cancellation requires a recorded reason',
    ],
    [
      'reopened without closure history',
      { reopenCount: { $gt: 0 }, closureHistory: { $size: 0 } },
      'rule 16 requires the previous closure to be preserved',
    ],
  ];

  for (const [label, filter, why] of checks) {
    const rows = await Complaint.find(filter)
      .select('_id complaintNumber status')
      .limit(50)
      .lean()
      .exec();

    if (rows.length > 0) {
      error(
        'complaintState',
        `${rows.length} complaint(s) ${label} (${why}): ` +
        summarise(rows.map((r) => r.complaintNumber)),
      );
    }
  }
}

/* ---- 6. Visits agree with their complaints ----------------------------- */

async function checkVisits(): Promise<void> {
  /**
   * A visit's denormalised `serviceCenterId` must match its complaint's.
   *
   * It is copied for scoping performance, so a mismatch means the centre
   * calendar shows a visit the complaint list does not — or worse, hides one
   * it should show.
   */
  const mismatched = await Visit.aggregate([
    {
      $lookup: {
        from: 'complaints',
        localField: 'complaintId',
        foreignField: '_id',
        as: 'complaint',
      },
    },
    { $unwind: '$complaint' },
    {
      $match: {
        $expr: { $ne: ['$serviceCenterId', '$complaint.serviceCenterId'] },
      },
    },
    { $project: { _id: 1, sequence: 1, 'complaint.complaintNumber': 1 } },
    { $limit: 50 },
  ]).exec();

  if (mismatched.length > 0) {
    error(
      'visits',
      `${mismatched.length} visit(s) disagree with their complaint's service center: ` +
      summarise(mismatched.map((v) => `${v.complaint.complaintNumber}#${v.sequence}`)),
    );
  }

  const duplicateSequence = await Visit.aggregate([
    { $group: { _id: { complaintId: '$complaintId', sequence: '$sequence' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 50 },
  ]).exec();

  if (duplicateSequence.length > 0) {
    error('visits', `${duplicateSequence.length} complaint(s) have duplicate visit numbers`);
  }

  /**
   * An open visit on a complaint that has moved past it.
   *
   * A scheduled visit only makes sense while the complaint is VISIT_SCHEDULED,
   * and one in progress only while work is under way or paused for parts.
   * Anything else is a visit the workflow forgot to close: it sits on a
   * technician's list with no way to finish it.
   */
  const stranded = await Visit.aggregate([
    { $match: { status: { $in: ['SCHEDULED', 'IN_PROGRESS'] } } },
    {
      $lookup: {
        from: 'complaints',
        localField: 'complaintId',
        foreignField: '_id',
        as: 'complaint',
      },
    },
    { $unwind: '$complaint' },
    {
      $match: {
        $or: [
          { status: 'SCHEDULED', 'complaint.status': { $ne: 'VISIT_SCHEDULED' } },
          {
            status: 'IN_PROGRESS',
            'complaint.status': { $nin: ['IN_PROGRESS', 'WAITING_FOR_PARTS'] },
          },
        ],
      },
    },
    { $project: { sequence: 1, status: 1, 'complaint.complaintNumber': 1, 'complaint.status': 1 } },
    { $limit: 50 },
  ]).exec();

  if (stranded.length > 0) {
    error(
      'visits',
      `${stranded.length} open visit(s) on a complaint that has moved on: ` +
      summarise(
        stranded.map(
          (v) => `${v.complaint.complaintNumber}#${v.sequence} ${v.status} (complaint ${v.complaint.status})`,
        ),
      ),
    );
  }
}

/* ---- 7. Configuration -------------------------------------------------- */

async function checkConfiguration(): Promise<void> {
  for (const priority of PRIORITIES) {
    const rule = await SlaRule.findOne({ priority }).lean().exec();

    if (!rule) {
      /* Complaint creation throws without one, so this breaks the system's
         primary function. */
      error('sla', `no SLA rule for ${priority} — complaints of that priority cannot be created`);
      continue;
    }

    if (rule.resolutionMinutes < rule.responseMinutes) {
      error(
        'sla',
        `${priority}: resolution window (${rule.resolutionMinutes}m) is shorter than ` +
        `response (${rule.responseMinutes}m)`,
      );
    }
  }
}

/* ---- 8. Things worth knowing, not errors ------------------------------- */

async function reportObservations(): Promise<void> {
  const [open, breached, lowStock, unverified] = await Promise.all([
    Complaint.countDocuments({ status: { $nin: TERMINAL_STATUSES } }).exec(),
    Complaint.countDocuments({ 'sla.state': 'BREACHED' }).exec(),
    PartStock.countDocuments({
      $expr: { $lte: ['$availableQuantity', '$minimumStock'] },
    }).exec(),
    Complaint.countDocuments({
      status: 'ADMIN_CONFIRMATION',
      'happyCode.lockedAt': { $ne: null },
    }).exec(),
  ]);

  console.log('\nOperational snapshot');
  console.log(`  open complaints        ${open}`);
  console.log(`  SLA breached           ${breached}`);
  console.log(`  parts at/below minimum ${lowStock}`);
  console.log(`  Happy Codes locked     ${unverified}`);

  if (unverified > 0) {
    warn(
      'happyCode',
      `${unverified} complaint(s) are stuck at ADMIN_CONFIRMATION with a locked ` +
      'Happy Code — they need regenerating before they can close',
    );
  }
}

/* ---- Run --------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log(`Integrity check against ${config.MONGO_URI}`);
  await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

  const checks: Array<[string, () => Promise<void>]> = [
    ['dangling references', checkReferences],
    ['stock levels', checkStock],
    ['complaint numbering', checkComplaintNumbers],
    ['user roles and scopes', checkUserScopes],
    ['complaint state coherence', checkComplaintState],
    ['visits', checkVisits],
    ['configuration', checkConfiguration],
  ];

  for (const [label, run] of checks) {
    process.stdout.write(`  checking ${label.padEnd(28)}`);
    const before = findings.length;
    await run();
    const found = findings.length - before;
    console.log(found === 0 ? 'ok' : `${found} finding(s)`);
  }

  await reportObservations();

  const errors = findings.filter((f) => f.severity === 'ERROR');
  const warnings = findings.filter((f) => f.severity === 'WARN');

  if (findings.length > 0) {
    console.log('\nFindings');
    for (const finding of findings) {
      console.log(`  [${finding.severity}] ${finding.check}: ${finding.detail}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (errors.length === 0 && warnings.length === 0) {
    console.log('No integrity problems found.');
  } else {
    console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
    console.log('Nothing was repaired — the right fix depends on which side is wrong.');
  }
  console.log('='.repeat(60));

  await mongoose.connection.close();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(async (err: unknown) => {
  console.error('\nintegrity check failed:', err instanceof Error ? err.message : err);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(2);
});
