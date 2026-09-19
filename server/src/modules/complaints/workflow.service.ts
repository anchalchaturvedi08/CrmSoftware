/**
 * Complaint workflow transitions (spec sections 7, 9, 10, Workflows B-G).
 *
 * Every operation here follows the same shape, and the shape is the point:
 *
 *   1. open a transaction
 *   2. load the complaint **within the caller's scope**
 *   3. build the state the complaint *would* have after the change
 *   4. ask the status machine whether that move is legal for this role
 *   5. apply it, write the timeline entry, commit
 *
 * Step 3 matters more than it looks. Assigning a service center is both
 * "set this field" and "move NEW to ASSIGNED", and the transition's
 * precondition is that the field is set — so validating the *current* state
 * would reject every first assignment. The machine is asked about the outcome,
 * not the starting point.
 *
 * Step 5 is one transaction throughout because section 17 requires the
 * timeline to record every action. A status change that commits without its
 * timeline entry is an unexplained change in the record.
 */
import mongoose, { type ClientSession, type HydratedDocument } from 'mongoose';
import { recordActivity, recordAudit, type Actor } from '../../core/audit.js';
import {
  regenerateHappyCode as regenerate,
  verifyHappyCode as checkCode,
  attemptsRemaining,
} from '../../core/happyCode.js';
import { complaintScope, visitScope, withScope } from '../../core/scope.js';
import {
  complete as completeSla,
  markResponded,
  pause as pauseSla,
  resume as resumeSla,
  ruleFor,
  shouldPause,
  startTracking,
} from '../../core/sla.js';
import {
  assertTransition,
  stateViewOf,
  type ComplaintStateView,
} from '../../core/statusMachine.js';
import { AppError, badRequest, forbidden, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  Complaint,
  Part,
  PartRequest,
  ServiceCenter,
  User,
  Visit,
  type ComplaintDoc,
  type VisitDoc,
} from '../../models/index.js';
import type { ActivityAction, ComplaintStatus } from '../../models/enums.js';
import { formatDateTime } from '../reports/report.labels.js';
import type {
  AssignServiceCenterInput,
  AssignTechnicianInput,
  CloseComplaintInput,
  RateServiceInput,
  ReasonOnlyInput,
  ReviewResolutionInput,
  ScheduleVisitInput,
  StartVisitInput,
  SubmitResolutionInput,
  VerifyHappyCodeInput,
} from './workflow.validation.js';

/* ---- Shared plumbing --------------------------------------------------- */

/**
 * A live complaint document.
 *
 * `ComplaintDoc` is the plain data shape; the hydrated form is what a query
 * returns and what carries `save()`. These functions mutate and persist, so
 * they need the hydrated type rather than the interface.
 */
type ComplaintDocument = HydratedDocument<ComplaintDoc>;

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

/**
 * Runs `fn` against a scoped complaint inside a transaction.
 *
 * Out-of-scope complaints report "not found" rather than "forbidden", so one
 * service center cannot confirm another's complaint exists by its id.
 */
async function inTransaction<T>(
  id: string,
  auth: AuthContext,
  fn: (complaint: ComplaintDocument, session: ClientSession, actor: Actor) => Promise<T>,
  options: { withSecret?: boolean } = {},
): Promise<T> {
  const session = await mongoose.startSession();

  try {
    let output: T | undefined;
    let produced = false;

    await session.withTransaction(async () => {
      const query = Complaint.findOne(
        withScope<ComplaintDoc>(complaintScope(auth), { _id: id }),
      ).session(session);

      if (options.withSecret) query.select('+happyCodeSecret');

      const complaint = await query.exec();
      if (!complaint) throw notFound('Complaint not found');

      output = await fn(complaint, session, actorFor(auth));
      produced = true;
    });

    if (!produced) throw new Error('transaction produced no result');
    return output as T;
  } finally {
    await session.endSession();
  }
}

/** The complaint as it would be once the pending changes are applied. */
function projected(
  complaint: ComplaintDocument,
  changes: Partial<ComplaintStateView>,
): ComplaintStateView {
  return { ...stateViewOf(complaint), ...changes };
}

/** Moves the complaint and records the change on its timeline. */
async function transition(
  complaint: ComplaintDocument,
  to: ComplaintStatus,
  auth: AuthContext,
  session: ClientSession,
  actor: Actor,
  options: {
    projection?: Partial<ComplaintStateView>;
    reason?: string | undefined;
    action: ActivityAction;
    note?: string;
  },
): Promise<void> {
  assertTransition({
    complaint: projected(complaint, options.projection ?? {}),
    to,
    role: auth.role,
    reason: options.reason,
  });

  const from = complaint.status;
  complaint.status = to;

  /* What happened, then why. A typed reason used to replace the note, so
     "Visit 3 scheduled for 18 Sep, 3:00 PM" vanished from the timeline
     whenever the Owner also wrote why (pre-launch review). */
  const note = [options.note, options.reason].filter(Boolean).join(' — ');

  await recordActivity(
    {
      complaintId: String(complaint._id),
      action: options.action,
      actor,
      fieldChanged: 'status',
      oldValue: from,
      newValue: to,
      ...(note ? { note: note.slice(0, 2000) } : {}),
    },
    session,
  );

  /* Section 17 lists "Status changed" as its own event, separate from the
     action that caused it, so both appear on the timeline. */
  if (options.action !== 'STATUS_CHANGED') {
    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'STATUS_CHANGED',
        actor,
        fieldChanged: 'status',
        oldValue: from,
        newValue: to,
      },
      session,
    );
  }
}

/* ---- Service center assignment (section 8, Workflow A step 10) --------- */

export async function assignServiceCenter(
  id: string,
  input: AssignServiceCenterInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const centre = await ServiceCenter.findById(input.serviceCenterId)
      .session(session)
      .exec();

    if (!centre) throw notFound('That service center no longer exists');
    if (!centre.isActive) {
      throw badRequest(`${centre.name} is deactivated and cannot take new work`, [
        { field: 'serviceCenterId', message: 'This service center is inactive' },
      ]);
    }

    const previous = complaint.serviceCenterId;
    const isReassignment = Boolean(previous) && String(previous) !== String(centre._id);

    if (previous && String(previous) === String(centre._id)) {
      throw badRequest('This complaint is already with that service center');
    }

    /* Moving work between centres is always explained; choosing the first
       centre — including for a complaint reopened before it had one — is not
       a move, so needs no reason. */
    if (isReassignment && !input.reason?.trim()) {
      throw badRequest('A reason is required to move this complaint to another service center', [
        { field: 'reason', message: 'Please give a reason' },
      ]);
    }

    if (complaint.status === 'ASSIGNED') {
      /**
       * Correcting the centre while still ASSIGNED.
       *
       * Found through the Admin UI: after a mis-click on the wrong centre, the
       * status machine offered no way back — ASSIGNED -> ASSIGNED is not a
       * transition, so the request was refused as "already assigned", and the
       * only escape was cancelling the whole complaint.
       *
       * It is not a transition, because the status does not change, so it is
       * handled like reassigning a technician within a status: an explicit
       * permission check and a timeline entry. No technician can be attached
       * yet at this status, so there is nobody to unassign.
       */
      if (auth.role !== 'ADMIN') {
        throw forbidden('Only ADMIN can change the service center');
      }

      /* By name, like the new value — the timeline is read by people. */
      const previousCentre = previous
        ? await ServiceCenter.findById(previous).select('name').session(session).lean().exec()
        : null;

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'SERVICE_CENTER_REASSIGNED',
          actor,
          fieldChanged: 'serviceCenterId',
          ...(previous ? { oldValue: previousCentre?.name ?? String(previous) } : {}),
          newValue: centre.name,
          note: input.reason,
        },
        session,
      );
    } else {
      /**
       * A reassignment drops the technician.
       *
       * The new centre has its own staff, so carrying the old technician over
       * would leave a job assigned to someone who does not work there —
       * and `refActive` would not catch it, because that technician is still a
       * perfectly active user elsewhere.
       */
      await transition(complaint, 'ASSIGNED', auth, session, actor, {
        projection: {
          serviceCenterId: centre._id,
          ...(isReassignment ? { technicianId: undefined } : {}),
        },
        reason: input.reason,
        action: isReassignment ? 'SERVICE_CENTER_REASSIGNED' : 'SERVICE_CENTER_SELECTED',
        note: isReassignment ? `Moved to ${centre.name}` : `Sent to ${centre.name}`,
      });

      if (isReassignment) {
        await withdrawCentreWork(complaint, centre.name, input.reason ?? '', session, actor);
      }

      /* ASSIGNED is not a status the clock pauses in; a job moved while on
         hold for parts or sent back starts counting again at the new centre. */
      if (complaint.sla.state === 'PAUSED') {
        complaint.sla = resumeSla(complaint.sla);
      }
    }

    complaint.serviceCenterId = centre._id;
    if (isReassignment) complaint.technicianId = undefined;

    await complaint.save({ session });
    return complaint;
  });
}

/**
 * Calls off what the previous centre had under way when a complaint moves.
 *
 * Found in the pre-launch review: moving a complaint touched only the
 * complaint. Its booked visit stayed on the old centre's schedule, turned
 * "Missed", and silently moved to whichever technician the new centre picked
 * — still tagged with the old centre, so the new Owner could not see it and
 * the technician could not start it. Pending part requests stayed in the old
 * centre's queue, where deciding one wrote to a complaint that was no longer
 * theirs.
 *
 * Booked and started visits are cancelled, as cancelling the complaint does:
 * the new centre books its own. Requests not yet issued are withdrawn; parts
 * already issued or used stay on record against the centre that supplied
 * them. Everything is written to the timeline.
 */
async function withdrawCentreWork(
  complaint: ComplaintDocument,
  newCentreName: string,
  reason: string,
  session: ClientSession,
  actor: Actor,
): Promise<void> {
  const now = new Date();
  const why = `Moved to ${newCentreName}${reason ? `: ${reason}` : ''}`.slice(0, 2000);

  const visits = await Visit.find({
    complaintId: complaint._id,
    status: { $in: ['SCHEDULED', 'IN_PROGRESS'] },
  })
    .session(session)
    .exec();

  for (const visit of visits) {
    visit.status = 'CANCELLED';
    visit.cancelledAt = now;
    visit.cancellationReason = why;
    await visit.save({ session });

    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'VISIT_CANCELLED',
        actor,
        visitId: String(visit._id),
        note: `Visit ${visit.sequence} cancelled — ${why}`.slice(0, 2000),
      },
      session,
    );
  }

  const requests = await PartRequest.find({
    complaintId: complaint._id,
    status: { $in: ['REQUESTED', 'APPROVED'] },
  })
    .session(session)
    .exec();

  if (requests.length === 0) return;

  const parts = await Part.find({ _id: { $in: requests.map((request) => request.partId) } })
    .select('name')
    .session(session)
    .lean()
    .exec();

  for (const request of requests) {
    request.status = 'CANCELLED';
    request.decidedAt = now;
    request.decidedBy = new mongoose.Types.ObjectId(actor.userId);
    request.decisionRemarks = why.slice(0, 1000);
    await request.save({ session });

    const part = parts.find((p) => String(p._id) === String(request.partId));
    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'PARTS_REQUEST_CANCELLED',
        actor,
        fieldChanged: 'partRequest.status',
        newValue: 'CANCELLED',
        note: `${request.quantityRequested} x ${part?.name ?? 'part'} withdrawn — ${why}`.slice(0, 2000),
      },
      session,
    );
  }
}

/* ---- Technician assignment (Workflow B) -------------------------------- */

/** Statuses with work a technician can still be put on or taken off. */
const TECHNICIAN_ASSIGNABLE = new Set<ComplaintStatus>([
  'ASSIGNED',
  'REOPENED',
  'TECHNICIAN_ASSIGNED',
  'VISIT_SCHEDULED',
  'IN_PROGRESS',
  'WAITING_FOR_PARTS',
  'REVISIT_REQUIRED',
]);

export async function assignTechnician(
  id: string,
  input: AssignTechnicianInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    if (!complaint.serviceCenterId) {
      throw badRequest('Assign a service center before assigning a technician');
    }

    /**
     * Only while there is work for a technician to do.
     *
     * The pre-launch security review found this open at every status: an
     * Owner could put a technician on a closed or cancelled complaint — moving
     * its report credit and handing that technician the customer's details —
     * or swap the technician on work already submitted for review.
     */
    if (!TECHNICIAN_ASSIGNABLE.has(complaint.status)) {
      throw new AppError(
        409,
        'INVALID_STATUS_TRANSITION',
        complaint.status === 'CLOSED' || complaint.status === 'CANCELLED'
          ? `This complaint is ${complaint.status === 'CLOSED' ? 'closed' : 'cancelled'}. Admin must reopen it first.`
          : 'The work has been submitted, so the technician cannot be changed now. Send it back for a revisit first.',
      );
    }

    const technician = await User.findById(input.technicianId).session(session).exec();
    if (!technician) throw notFound('That technician no longer exists');

    if (technician.role !== 'TECHNICIAN') {
      throw badRequest('That user is not a technician', [
        { field: 'technicianId', message: 'Not a technician' },
      ]);
    }

    if (!technician.isActive) {
      throw badRequest(`${technician.name} is deactivated and cannot take jobs`, [
        { field: 'technicianId', message: 'This technician is inactive' },
      ]);
    }

    /**
     * The technician must belong to the complaint's own service center.
     *
     * Without this an Owner could assign someone else's staff — the scope
     * check only proves the Owner may touch *this complaint*, not that the
     * technician is theirs to direct.
     */
    if (String(technician.serviceCenterId) !== String(complaint.serviceCenterId)) {
      throw forbidden('That technician belongs to a different service center');
    }

    const previous = complaint.technicianId;
    const isReassignment = Boolean(previous) && String(previous) !== String(technician._id);

    /**
     * Reassigning within a status is not a transition (see statusMachine.ts),
     * so it is applied directly with its own timeline entry. Only a move from
     * ASSIGNED or REOPENED actually changes the status.
     */
    const changesStatus =
      complaint.status === 'ASSIGNED' || complaint.status === 'REOPENED';

    /* Naming the current technician again is a no-op — unless it moves the
       complaint on. Reopening keeps the technician, and sending the job back
       to the person who knows the unit is the usual choice; refusing it left
       a centre with one technician no way to restart a reopened complaint. */
    if (previous && !isReassignment && !changesStatus) {
      throw badRequest('That technician is already assigned to this complaint');
    }

    if (changesStatus) {
      await transition(complaint, 'TECHNICIAN_ASSIGNED', auth, session, actor, {
        projection: { technicianId: technician._id },
        reason: input.reason,
        action: 'TECHNICIAN_ASSIGNED',
        note: `Assigned to ${technician.name}`,
      });
    } else {
      if (auth.role !== 'SERVICE_CENTER_OWNER') {
        throw forbidden('Only SERVICE_CENTER_OWNER can reassign a technician');
      }

      /* By name, like the new value — the timeline is read by people. */
      const previousTechnician = previous
        ? await User.findById(previous).select('name').session(session).lean().exec()
        : null;

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: isReassignment ? 'TECHNICIAN_REASSIGNED' : 'TECHNICIAN_ASSIGNED',
          actor,
          fieldChanged: 'technicianId',
          ...(previous ? { oldValue: previousTechnician?.name ?? String(previous) } : {}),
          newValue: technician.name,
          ...(input.reason ? { note: input.reason } : {}),
        },
        session,
      );
    }

    complaint.technicianId = technician._id;

    /**
     * A visit the previous technician has under way ends here.
     *
     * Only they can finish or submit it, and they no longer have the job, so
     * leaving it open stranded the complaint: "Resume work" came back to a
     * visit the new technician was refused on (pre-launch review). It is
     * cancelled with the reason, keeping when it started; the Owner books the
     * new technician's visit.
     */
    const underWay = await Visit.find({
      complaintId: complaint._id,
      status: 'IN_PROGRESS',
      technicianId: { $ne: technician._id },
    })
      .session(session)
      .exec();

    for (const visit of underWay) {
      visit.status = 'CANCELLED';
      visit.cancelledAt = new Date();
      visit.cancellationReason = `Job moved to ${technician.name}${input.reason ? `: ${input.reason}` : ''}`.slice(0, 2000);
      await visit.save({ session });

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'VISIT_CANCELLED',
          actor,
          visitId: String(visit._id),
          note: `Visit ${visit.sequence} ended without a resolution — job moved to ${technician.name}`,
        },
        session,
      );
    }

    /**
     * Move any pending visit to the new technician.
     *
     * Without this, reassigning while a visit is `SCHEDULED` strands the
     * complaint: the visit still belongs to the previous technician, who can
     * no longer see the complaint at all, while the new technician is refused
     * for trying to start someone else's visit. The Owner would have to
     * cancel the visit and schedule another to get moving again.
     *
     * Only `SCHEDULED` visits move. One already in progress or completed is a
     * record of what the previous technician actually did, and section 22
     * requires that to survive.
     */
    const pending = await Visit.findOne({
      complaintId: complaint._id,
      status: 'SCHEDULED',
    })
      .session(session)
      .exec();

    if (pending && String(pending.technicianId) !== String(technician._id)) {
      pending.technicianId = technician._id;
      await pending.save({ session });

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'VISIT_RESCHEDULED',
          actor,
          visitId: String(pending._id),
          note: `Visit ${pending.sequence} moved to ${technician.name}`,
        },
        session,
      );
    }

    await complaint.save({ session });
    return complaint;
  });
}

/* ---- Visit scheduling (section 9) -------------------------------------- */

export interface ScheduledVisit {
  complaint: ComplaintDocument;
  visit: VisitDoc;
}

export async function scheduleVisit(
  id: string,
  input: ScheduleVisitInput,
  auth: AuthContext,
): Promise<ScheduledVisit> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    if (input.technicianId) {
      /* Scheduling may also (re)assign, so reuse the same validation rather
         than duplicating the centre-membership check. */
      const technician = await User.findById(input.technicianId).session(session).exec();
      if (!technician || technician.role !== 'TECHNICIAN' || !technician.isActive) {
        throw badRequest('That technician cannot take this job');
      }
      if (String(technician.serviceCenterId) !== String(complaint.serviceCenterId)) {
        throw forbidden('That technician belongs to a different service center');
      }
      complaint.technicianId = technician._id;
    }

    if (!complaint.technicianId) {
      throw badRequest('Assign a technician before scheduling a visit');
    }

    /* Said in words here: left to the visit model, a deactivated technician
       came back as "The record failed validation" (pre-launch review). */
    if (!input.technicianId) {
      const assigned = await User.findById(complaint.technicianId)
        .select('name isActive')
        .session(session)
        .lean()
        .exec();
      if (!assigned?.isActive) {
        throw badRequest(
          `${assigned?.name ?? 'The assigned technician'} is deactivated. Reassign the job to an active technician, then book the visit.`,
          [{ field: 'technicianId', message: 'This technician is inactive' }],
        );
      }
    }

    /* A visit in the past is almost always a typo, and it would quietly
       corrupt the schedule views and SLA reporting. */
    if (input.scheduledAt.getTime() < Date.now() - 60_000) {
      throw badRequest('A visit cannot be scheduled in the past', [
        { field: 'scheduledAt', message: 'Choose a future date and time' },
      ]);
    }

    /**
     * Close the visit this one replaces.
     *
     * Scheduling from IN_PROGRESS or WAITING_FOR_PARTS means the previous trip
     * is over: the technician went home to wait for a part, or the job moved
     * to someone else mid-visit. Left open, that visit would sit on a
     * technician's in-progress list for good, with no way to finish it.
     */
    const unfinished = await Visit.find({
      complaintId: complaint._id,
      status: 'IN_PROGRESS',
    })
      .session(session)
      .exec();

    for (const open of unfinished) {
      open.status = 'COMPLETED';
      open.completedAt = new Date();
      await open.save({ session });
    }

    const sequence = (await Visit.countDocuments({ complaintId: complaint._id })
      .session(session)
      .exec()) + 1;

    const [visit] = await Visit.create(
      [
        {
          complaintId: complaint._id,
          serviceCenterId: complaint.serviceCenterId,
          technicianId: complaint.technicianId,
          sequence,
          scheduledAt: input.scheduledAt,
          scheduledBy: actor.userId,
          status: 'SCHEDULED',
        },
      ],
      { session },
    );

    const closed = unfinished.map((open) => `visit ${open.sequence}`).join(', ');

    await transition(complaint, 'VISIT_SCHEDULED', auth, session, actor, {
      reason: input.reason,
      action: 'VISIT_SCHEDULED',
      note:
        /* In the company timezone and in words: the note is read on the timeline. */
        `Visit ${sequence} scheduled for ${formatDateTime(input.scheduledAt)}` +
        (closed ? ` (${closed} closed)` : ''),
    });

    /* Leaving WAITING_FOR_PARTS resumes a paused clock. */
    const rule = await ruleFor(complaint.priority);
    if (complaint.sla.state === 'PAUSED') {
      complaint.sla = resumeSla(complaint.sla);
    }
    void rule;

    await complaint.save({ session });
    return { complaint, visit: visit! };
  });
}

/* ---- Cancel a booked visit (section 9) --------------------------------- */

/**
 * Calls off a scheduled visit.
 *
 * When it was the only visit booked, the complaint goes back to
 * TECHNICIAN_ASSIGNED — honest about there being no visit, and ready for the
 * Owner to book one. Left at VISIT_SCHEDULED it would claim a visit that does
 * not exist, and a new booking would be refused as a no-op.
 */
export async function cancelScheduledVisit(
  visitId: string,
  input: { reason: string },
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; visit: VisitDoc }> {
  const found = await Visit.findOne(withScope<VisitDoc>(visitScope(auth), { _id: visitId }))
    .select('complaintId')
    .lean()
    .exec();
  if (!found) throw notFound('Visit not found');

  return inTransaction(String(found.complaintId), auth, async (complaint, session, actor) => {
    const visit = await Visit.findById(visitId).session(session).exec();
    if (!visit) throw notFound('Visit not found');

    if (visit.status !== 'SCHEDULED') {
      throw badRequest(
        `This visit is ${visit.status.toLowerCase().replace(/_/g, ' ')} and cannot be cancelled`,
      );
    }

    visit.status = 'CANCELLED';
    visit.cancelledAt = new Date();
    visit.cancellationReason = input.reason;
    await visit.save({ session });

    const stillBooked = await Visit.exists({
      complaintId: complaint._id,
      status: 'SCHEDULED',
    }).session(session);

    /* Recorded as a cancellation: it used to read "Visit rescheduled" with no
       new date, which is not what happened (pre-launch review). */
    if (complaint.status === 'VISIT_SCHEDULED' && !stillBooked) {
      await transition(complaint, 'TECHNICIAN_ASSIGNED', auth, session, actor, {
        reason: input.reason,
        action: 'VISIT_CANCELLED',
        note: `Visit ${visit.sequence} cancelled`,
      });
      await complaint.save({ session });
    } else {
      /* Another visit is still booked, so the status stands; the timeline
         still needs to say this one was called off. */
      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'VISIT_CANCELLED',
          actor,
          visitId: String(visit._id),
          note: `Visit ${visit.sequence} cancelled: ${input.reason}`,
        },
        session,
      );
    }

    return { complaint, visit };
  });
}

/* ---- Start visit (Workflow C step 3) ----------------------------------- */

/**
 * Whether a visit ends the moment it starts, with no work done.
 *
 * Nobody home, or the customer asking for another day, ends it — the
 * technician should be on the way to the next job, not walked into a diagnosis
 * of a unit they never saw. Anything else carries on unless the technician
 * says otherwise, which is what `endVisit` is for.
 */
export function endsOnArrival(input: StartVisitInput): boolean {
  if (input.endVisit !== undefined) return input.endVisit;
  return (
    input.customerAvailability === 'CUSTOMER_UNAVAILABLE' ||
    input.customerAvailability === 'RESCHEDULE_REQUIRED'
  );
}

export async function startVisit(
  id: string,
  input: StartVisitInput,
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; visit: VisitDoc }> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const visit = await Visit.findOne({
      complaintId: complaint._id,
      status: 'SCHEDULED',
    })
      .sort({ sequence: -1 })
      .session(session)
      .exec();

    if (!visit) throw badRequest('There is no scheduled visit to start');

    /* Section 3.3: a technician works only their own jobs. The complaint
       scope already restricts this, but a visit could in principle belong to
       a different technician on the same complaint. */
    if (String(visit.technicianId) !== auth.userId) {
      throw forbidden('That visit is assigned to a different technician');
    }

    /* Section 10 step 1: the timestamp is the server's, never the client's. */
    const now = new Date();
    const endsHere = endsOnArrival(input);

    /* A trip that ends at the door is still a trip: it is recorded as started
       and completed, just with no resolution. The complaint moves to
       IN_PROGRESS either way — attendance stops the response clock, and the
       Owner's "Reschedule visit" leaves from there (statusMachine.ts). */
    visit.status = endsHere ? 'COMPLETED' : 'IN_PROGRESS';
    visit.startedAt = now;
    if (endsHere) visit.completedAt = now;
    if (input.customerAvailability) visit.customerAvailability = input.customerAvailability;
    if (input.availabilityNote) visit.availabilityNote = input.availabilityNote;
    await visit.save({ session });

    const why = [
      input.customerAvailability?.replace(/_/g, ' ').toLowerCase(),
      input.availabilityNote,
    ]
      .filter(Boolean)
      .join(': ');

    await transition(complaint, 'IN_PROGRESS', auth, session, actor, {
      action: 'VISIT_STARTED',
      note: endsHere
        ? `Visit ${visit.sequence} ended without work (${why})`
        : `Visit ${visit.sequence} started`,
    });

    /* First attendance stops the response clock (section 14). */
    complaint.sla = markResponded(complaint.sla, now);

    await complaint.save({ session });
    return { complaint, visit };
  });
}

/* ---- Submit resolution (Workflow C step 10) ---------------------------- */

export async function submitResolution(
  id: string,
  input: SubmitResolutionInput,
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; visit: VisitDoc; closed: boolean }> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const visit = await Visit.findOne({
      complaintId: complaint._id,
      status: 'IN_PROGRESS',
    })
      .sort({ sequence: -1 })
      .session(session)
      .exec();

    if (!visit) throw badRequest('There is no visit in progress to submit');

    if (String(visit.technicianId) !== auth.userId) {
      throw forbidden('That visit is assigned to a different technician');
    }

    const now = new Date();

    visit.diagnosis = {
      problemFound: input.diagnosis.problemFound,
      ...(input.diagnosis.notes ? { notes: input.diagnosis.notes } : {}),
      recordedAt: now,
    };
    visit.workPerformed = {
      details: input.workPerformed.details,
      ...(input.workPerformed.remarks ? { remarks: input.workPerformed.remarks } : {}),
      recordedAt: now,
    };
    visit.resolution = {
      result: input.resolution.result,
      ...(input.resolution.remarks ? { remarks: input.resolution.remarks } : {}),
      ...(input.resolution.customerFeedback
        ? { customerFeedback: input.resolution.customerFeedback }
        : {}),
      submittedAt: now,
      submittedBy: new mongoose.Types.ObjectId(auth.userId),
    };
    if (input.customerAvailability) visit.customerAvailability = input.customerAvailability;

    visit.status = 'COMPLETED';
    visit.completedAt = now;
    await visit.save({ session });

    for (const entry of [
      { action: 'DIAGNOSIS_ADDED' as const, note: input.diagnosis.problemFound },
      { action: 'WORK_RECORDED' as const, note: input.workPerformed.details },
    ]) {
      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: entry.action,
          actor,
          visitId: String(visit._id),
          note: entry.note.slice(0, 2000),
        },
        session,
      );
    }

    /* If the technician entered the Happy Code, try to close directly. */
    let closed = false;
    if (input.happyCode && complaint.happyCodeSecret) {
      const result = checkCode(input.happyCode, complaint.happyCodeSecret, complaint.happyCode);
      complaint.happyCode = result.meta;

      if (result.ok) {
        await recordActivity(
          { complaintId: String(complaint._id), action: 'HAPPY_CODE_VERIFIED', actor, note: 'Customer confirmed the service' },
          session,
        );
        await transition(complaint, 'CLOSED', auth, session, actor, {
          projection: { happyCodeVerifiedAt: result.meta.verifiedAt },
          action: 'COMPLAINT_CLOSED',
          note: 'Closed by technician with Happy Code',
        });
        complaint.closedAt = now;
        complaint.closedBy = new mongoose.Types.ObjectId(auth.userId);
        complaint.sla = completeSla(complaint.sla, now);
        closed = true;
      }
    }

    if (!closed) {
      await transition(complaint, 'RESOLUTION_SUBMITTED', auth, session, actor, {
        action: 'RESOLUTION_SUBMITTED',
        note: input.resolution.result,
      });
    }

    complaint.lastResolutionVisitId = visit._id;
    complaint.lastResolutionSubmittedAt = now;
    complaint.resolutionReview = undefined;

    await complaint.save({ session });
    return { complaint, visit, closed };
  }, { withSecret: true });
}

/* ---- Review resolution (Workflow E) ------------------------------------ */

export async function reviewResolution(
  id: string,
  input: ReviewResolutionInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const accepted = input.outcome === 'ACCEPTED';

    /* Accepting goes to ADMIN_CONFIRMATION, never CLOSED — section 3.2 is
       explicit that an Owner cannot final-close. */
    await transition(
      complaint,
      accepted ? 'ADMIN_CONFIRMATION' : 'REVISIT_REQUIRED',
      auth,
      session,
      actor,
      {
        reason: input.reason,
        action: accepted ? 'RESOLUTION_SUBMITTED' : 'RESOLUTION_REJECTED',
        note: accepted ? 'Resolution accepted by service center' : undefined,
      },
    );

    complaint.resolutionReview = {
      reviewedAt: new Date(),
      reviewedBy: new mongoose.Types.ObjectId(auth.userId),
      outcome: input.outcome,
      ...(input.reason ? { rejectionReason: input.reason } : {}),
    };

    if (!accepted) {
      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'REVISIT_REQUIRED',
          actor,
          note: input.reason ?? 'Revisit required',
        },
        session,
      );

      const rule = await ruleFor(complaint.priority);
      if (shouldPause(rule, 'REVISIT_REQUIRED')) {
        complaint.sla = pauseSla(complaint.sla);
      }
    } else {
      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: 'ADMIN_CONFIRMATION_STARTED',
          actor,
          note: 'Awaiting Admin customer confirmation',
        },
        session,
      );
    }

    await complaint.save({ session });
    return complaint;
  });
}

/* ---- Happy Code verification (Workflow F steps 5-7) -------------------- */

export interface VerificationOutcome {
  verified: boolean;
  attemptsRemaining: number;
  complaint: ComplaintDocument;
}

/**
 * Checks a code entered by Admin or the Service Centre Owner.
 *
 * Allowed from RESOLUTION_SUBMITTED, ADMIN_CONFIRMATION, and IN_PROGRESS
 * so that the Owner can verify on the phone when the technician could not.
 */
export async function verifyComplaintHappyCode(
  id: string,
  input: VerifyHappyCodeInput,
  auth: AuthContext,
): Promise<VerificationOutcome> {
  const VERIFIABLE: readonly ComplaintStatus[] = [
    'IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'ADMIN_CONFIRMATION',
  ];

  return inTransaction(
    id,
    auth,
    async (complaint, session, actor) => {
      if (!VERIFIABLE.includes(complaint.status)) {
        throw new AppError(
          409,
          'INVALID_STATUS_TRANSITION',
          'The Happy Code can only be verified while the complaint is in progress, submitted, or awaiting confirmation',
        );
      }

      if (!complaint.happyCodeSecret) {
        throw badRequest('This complaint has no Happy Code. Regenerate one first.');
      }

      const result = checkCode(input.code, complaint.happyCodeSecret, complaint.happyCode);
      complaint.happyCode = result.meta;
      await complaint.save({ session });

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: result.ok ? 'HAPPY_CODE_VERIFIED' : 'HAPPY_CODE_VERIFY_FAILED',
          actor,
          note: result.ok
            ? 'Customer confirmed the service'
            : `Incorrect code. ${attemptsRemaining(result.meta)} attempt(s) remaining.`,
        },
        session,
      );

      await recordAudit({
        entityType: 'Complaint',
        entityId: String(complaint._id),
        action: result.ok ? 'HAPPY_CODE_VERIFIED' : 'HAPPY_CODE_VERIFY_FAILED',
        actor,
      });

      return {
        verified: result.ok,
        attemptsRemaining: attemptsRemaining(result.meta),
        complaint,
      };
    },
    { withSecret: true },
  );
}

/** Issues a fresh code, for when the customer never received the first one. */
export async function regenerateComplaintHappyCode(
  id: string,
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; happyCode: string }> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    if (complaint.happyCode.verifiedAt) {
      throw badRequest('This Happy Code has already been verified');
    }

    const fresh = regenerate(complaint.happyCode);
    complaint.happyCodeSecret = fresh.secret;
    complaint.happyCode = fresh.meta;
    await complaint.save({ session });

    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'HAPPY_CODE_REGENERATED',
        actor,
        note: `Regenerated (attempt ${fresh.meta.regenerationCount}). Send it to the customer again.`,
      },
      session,
    );

    return { complaint, happyCode: fresh.code };
  });
}

/* ---- Closure (Workflow F; DECISIONS.md section 33) -------------------- */

export async function closeComplaint(
  id: string,
  input: CloseComplaintInput,
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; verified?: boolean; attemptsRemaining?: number }> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const now = new Date();

    /* If a Happy Code was provided in the request, verify it inline so the
       caller does not need a separate verify step. */
    if (input.code && complaint.happyCodeSecret) {
      const result = checkCode(input.code, complaint.happyCodeSecret, complaint.happyCode);
      complaint.happyCode = result.meta;

      await recordActivity(
        {
          complaintId: String(complaint._id),
          action: result.ok ? 'HAPPY_CODE_VERIFIED' : 'HAPPY_CODE_VERIFY_FAILED',
          actor,
          note: result.ok
            ? 'Customer confirmed the service'
            : `Incorrect code. ${attemptsRemaining(result.meta)} attempt(s) remaining.`,
        },
        session,
      );

      if (!result.ok) {
        await complaint.save({ session });
        return {
          complaint,
          verified: false,
          attemptsRemaining: attemptsRemaining(result.meta),
        };
      }
    }

    /* Complete any in-progress visit before closing. */
    if (complaint.status === 'IN_PROGRESS') {
      const visit = await Visit.findOne({ complaintId: complaint._id, status: 'IN_PROGRESS' })
        .sort({ sequence: -1 })
        .session(session)
        .exec();
      if (visit) {
        visit.status = 'COMPLETED';
        visit.completedAt = now;
        await visit.save({ session });
      }
    }

    const roleLabel =
      auth.role === 'SERVICE_CENTER_OWNER' ? 'service centre' : 'Admin';
    const note = input.remarks
      ? `Closed by ${roleLabel} — ${input.remarks}`
      : `Closed by ${roleLabel}`;

    await transition(complaint, 'CLOSED', auth, session, actor, {
      projection: complaint.happyCode?.verifiedAt ? { happyCodeVerifiedAt: complaint.happyCode.verifiedAt } : {},
      action: 'COMPLAINT_CLOSED',
      note,
    });

    complaint.closedAt = now;
    complaint.closedBy = new mongoose.Types.ObjectId(auth.userId);
    complaint.sla = completeSla(complaint.sla, now);

    await complaint.save({ session });
    return { complaint, verified: true };
  }, { withSecret: true });
}

/* ---- Service centre rating (DECISIONS.md section 31) ------------------- */

/**
 * Admin's star rating of the centre's work on a closed complaint.
 *
 * Not a transition — the status does not move, so this is handled the same
 * way as the other in-status actions here (the ASSIGNED correction above,
 * a technician reassignment within a status): a plain precondition check and
 * a timeline entry, rather than an entry in `statusMachine.ts`.
 *
 * The whole rating is replaced on every call rather than patched, which is
 * what makes a bare or emptied `note` on a change *clear* it — the previous
 * value is never carried forward unless it is sent again.
 */
export async function rateService(
  id: string,
  input: RateServiceInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    if (complaint.status !== 'CLOSED') {
      throw badRequest('Only a closed complaint can be rated');
    }

    const serviceCenterId = complaint.serviceCenterId;
    if (!serviceCenterId) {
      throw badRequest('This complaint has no service center to rate');
    }

    const previous = complaint.serviceRating;
    const note = input.note;
    const now = new Date();

    /* Re-submitting the same stars and note is a no-op — a double-click on
       Save, or a client retry, must not bump `revisions` or write a second
       timeline entry that claims a change from N stars to N stars. This
       mirrors assignServiceCenter's and assignTechnician's own guards
       against a no-op re-selection, just without treating it as an error:
       nothing here has side effects worth refusing, only bookkeeping worth
       skipping. */
    if (previous && previous.stars === input.stars && (previous.note ?? '') === (note ?? '')) {
      return complaint;
    }

    complaint.serviceRating = {
      stars: input.stars,
      ...(note ? { note } : {}),
      serviceCenterId,
      ratedAt: now,
      ratedBy: new mongoose.Types.ObjectId(actor.userId),
      ratedByName: actor.name,
      revisions: previous ? previous.revisions + 1 : 0,
    };

    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'SERVICE_CENTER_RATED',
        actor,
        fieldChanged: 'serviceRating.stars',
        ...(previous ? { oldValue: String(previous.stars) } : {}),
        newValue: String(input.stars),
        note: `${input.stars} of 5${note ? ` — ${note}` : ''}`,
      },
      session,
    );

    await complaint.save({ session });
    return complaint;
  });
}

/* ---- Reopen (section 13, Workflow G) ----------------------------------- */

export async function reopenComplaint(
  id: string,
  input: ReasonOnlyInput,
  auth: AuthContext,
): Promise<{ complaint: ComplaintDocument; happyCode: string }> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    const wasClosed = complaint.status === 'CLOSED';

    await transition(complaint, 'REOPENED', auth, session, actor, {
      reason: input.reason,
      action: 'COMPLAINT_REOPENED',
    });

    /**
     * The previous closure is preserved, not replaced.
     *
     * Rule 16 and section 22 both require it: reopening appends to the
     * history rather than overwriting what happened the first time.
     */
    if (wasClosed && complaint.closedAt && complaint.closedBy) {
      complaint.closureHistory.push({
        closedAt: complaint.closedAt,
        closedBy: complaint.closedBy,
        reopenedAt: new Date(),
        reopenedBy: new mongoose.Types.ObjectId(auth.userId),
        reopenReason: input.reason,
        /* The rating belonged to that closure, so it is filed with it. */
        ...(complaint.serviceRating ? { rating: complaint.serviceRating } : {}),
      });
    }

    /**
     * The rating goes with the closure it judged
     * (DECISIONS.md section 31).
     *
     * A reopened complaint is work still to be done, and Admin rates it again
     * when it closes again — possibly a different centre, if this one is
     * moved. Left on the complaint, that old rating would travel with it and
     * land in the new centre's average, rating one centre for another's work.
     * The closure history above keeps it, and so does the timeline.
     */
    complaint.serviceRating = undefined;

    complaint.reopenCount += 1;
    complaint.closedAt = undefined;
    complaint.closedBy = undefined;
    complaint.cancelledAt = undefined;
    complaint.cancelledBy = undefined;
    complaint.cancellationReason = undefined;
    complaint.resolutionReview = undefined;

    /**
     * A fresh Happy Code and a fresh SLA clock (DECISIONS.md section 5,
     * item 3). Reusing the old code would let a customer close the reopened
     * complaint with a code they were given for work that evidently did not
     * hold; reusing the old clock would show the complaint as breached from
     * the moment it reopened.
     */
    const fresh = regenerate(complaint.happyCode);
    complaint.happyCodeSecret = fresh.secret;
    complaint.happyCode = fresh.meta;

    const rule = await ruleFor(complaint.priority);
    complaint.sla = startTracking(rule, new Date());

    await complaint.save({ session });
    return { complaint, happyCode: fresh.code };
  });
}

/* ---- Cancel ------------------------------------------------------------ */

export async function cancelComplaint(
  id: string,
  input: ReasonOnlyInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    await transition(complaint, 'CANCELLED', auth, session, actor, {
      reason: input.reason,
      action: 'COMPLAINT_CANCELLED',
    });

    complaint.cancelledAt = new Date();
    complaint.cancelledBy = new mongoose.Types.ObjectId(auth.userId);
    complaint.cancellationReason = input.reason;

    /* A cancelled job must leave the technician's list too. A completed visit
       is a record of what happened and stays exactly as it was (section 22). */
    const open = await Visit.find({
      complaintId: complaint._id,
      status: { $in: ['SCHEDULED', 'IN_PROGRESS'] },
    })
      .session(session)
      .exec();

    for (const visit of open) {
      visit.status = 'CANCELLED';
      visit.cancelledAt = complaint.cancelledAt;
      visit.cancellationReason = `Complaint cancelled: ${input.reason}`.slice(0, 2000);
      await visit.save({ session });
    }

    await complaint.save({ session });
    return complaint;
  });
}

/* ---- Admin requires rework (section 3.1, Workflow F) ------------------- */

/**
 * Sends accepted work back when the customer says it is not fixed.
 *
 * The status machine has always allowed ADMIN_CONFIRMATION -> REVISIT_REQUIRED
 * for Admin; this is the operation that performs it. It mirrors the Owner's
 * rejection so every screen reads the same "sent back" record.
 *
 * A verified Happy Code is cleared. The customer confirmed the *previous*
 * work; the rework needs its own confirmation before Admin may close.
 */
export async function requireRework(
  id: string,
  input: ReasonOnlyInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    await transition(complaint, 'REVISIT_REQUIRED', auth, session, actor, {
      reason: input.reason,
      action: 'RESOLUTION_REJECTED',
    });

    complaint.resolutionReview = {
      reviewedAt: new Date(),
      reviewedBy: new mongoose.Types.ObjectId(auth.userId),
      outcome: 'REVISIT_REQUIRED',
      rejectionReason: input.reason,
    };

    if (complaint.happyCode.verifiedAt) {
      complaint.happyCode.verifiedAt = undefined;
    }

    await recordActivity(
      {
        complaintId: String(complaint._id),
        action: 'REVISIT_REQUIRED',
        actor,
        note: input.reason,
      },
      session,
    );

    const rule = await ruleFor(complaint.priority);
    if (shouldPause(rule, 'REVISIT_REQUIRED')) {
      complaint.sla = pauseSla(complaint.sla);
    }

    await complaint.save({ session });
    return complaint;
  });
}

/* ---- Parts holds (Workflow D) ------------------------------------------ */

export async function markWaitingForParts(
  id: string,
  input: ReasonOnlyInput,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    await transition(complaint, 'WAITING_FOR_PARTS', auth, session, actor, {
      reason: input.reason,
      action: 'PARTS_MARKED_UNAVAILABLE',
    });

    const rule = await ruleFor(complaint.priority);
    if (shouldPause(rule, 'WAITING_FOR_PARTS')) {
      complaint.sla = pauseSla(complaint.sla);
    }

    await complaint.save({ session });
    return complaint;
  });
}

export async function resumeWork(
  id: string,
  auth: AuthContext,
): Promise<ComplaintDocument> {
  return inTransaction(id, auth, async (complaint, session, actor) => {
    /**
     * Resuming continues a visit that is still under way — the technician
     * waited on site, or is going back to finish. With none (they left, or
     * the job has moved to someone else since), resuming would claim work in
     * progress that nobody can submit, so a follow-up visit is booked instead.
     */
    const underWay = await Visit.exists({
      complaintId: complaint._id,
      status: 'IN_PROGRESS',
      technicianId: complaint.technicianId,
    }).session(session);

    if (complaint.status === 'WAITING_FOR_PARTS' && !underWay) {
      throw new AppError(
        409,
        'INVALID_STATUS_TRANSITION',
        'No visit is under way for this job, so there is nothing to resume. Book a follow-up visit instead.',
      );
    }

    await transition(complaint, 'IN_PROGRESS', auth, session, actor, {
      action: 'STATUS_CHANGED',
      note: 'Parts available, work resumed',
    });

    if (complaint.sla.state === 'PAUSED') {
      complaint.sla = resumeSla(complaint.sla);
    }

    await complaint.save({ session });
    return complaint;
  });
}
