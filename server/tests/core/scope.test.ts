/**
 * Query scoping tests.
 *
 * Scoping is what keeps one service center's complaints out of another's
 * hands (spec sections 3.2, 3.3, 19). The failure mode is not a crash — it is
 * a silent cross-center data leak that looks like a working feature, so these
 * assertions matter more than most.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  attachmentScope,
  complaintScope,
  partStockScope,
  userScope,
  visitScope,
  withScope,
} from '../../src/core/scope.js';
import { AppError } from '../../src/http/errors.js';
import type { AuthContext } from '../../src/middleware/authenticate.js';

const CENTER_A = new mongoose.Types.ObjectId();
const TECH_ID = new mongoose.Types.ObjectId();

const admin: AuthContext = {
  userId: String(new mongoose.Types.ObjectId()),
  role: 'ADMIN',
  name: 'Admin',
  mustChangePassword: false,
};

const owner: AuthContext = {
  userId: String(new mongoose.Types.ObjectId()),
  role: 'SERVICE_CENTER_OWNER',
  name: 'Owner',
  serviceCenterId: String(CENTER_A),
  mustChangePassword: false,
};

const technician: AuthContext = {
  userId: String(TECH_ID),
  role: 'TECHNICIAN',
  name: 'Technician',
  serviceCenterId: String(CENTER_A),
  mustChangePassword: false,
};

describe('complaintScope', () => {
  it('gives Admin an unrestricted scope', () => {
    expect(complaintScope(admin)).toEqual({});
  });

  it('restricts an Owner to their own service center', () => {
    expect(complaintScope(owner)).toEqual({ serviceCenterId: CENTER_A });
  });

  it('restricts a Technician to their own assigned jobs', () => {
    expect(complaintScope(technician)).toEqual({ technicianId: TECH_ID });
  });

  it('fails closed when a scoped role has no service center', () => {
    /* Returning {} here would silently promote a data inconsistency into
       Admin-level visibility across every center. */
    const broken: AuthContext = { ...owner };
    delete broken.serviceCenterId;

    expect(() => complaintScope(broken)).toThrow(AppError);
    expect(() => complaintScope(broken)).toThrow(/not attached to a service center/);
  });
});

describe('withScope', () => {
  it('returns the caller filter alone when the scope is empty', () => {
    expect(withScope({}, { status: 'NEW' })).toEqual({ status: 'NEW' });
  });

  it('returns the scope alone when there is no caller filter', () => {
    expect(withScope({ serviceCenterId: CENTER_A })).toEqual({
      serviceCenterId: CENTER_A,
    });
  });

  it('combines with $and rather than spreading', () => {
    const combined = withScope({ serviceCenterId: CENTER_A }, { status: 'NEW' });
    expect(combined).toEqual({
      $and: [{ serviceCenterId: CENTER_A }, { status: 'NEW' }],
    });
  });

  it('cannot be overridden by a caller filter on the same field', () => {
    /* The attack this prevents: a request supplying its own serviceCenterId
       to read another center's complaints. With a spread merge the caller
       would win; with $and both conditions apply and the result is empty. */
    const otherCenter = new mongoose.Types.ObjectId();
    const combined = withScope(
      { serviceCenterId: CENTER_A },
      { serviceCenterId: otherCenter },
    );

    expect(combined).toEqual({
      $and: [{ serviceCenterId: CENTER_A }, { serviceCenterId: otherCenter }],
    });

    /* Both clauses survive, so the scope is still enforced. */
    const clauses = (combined as { $and: Array<Record<string, unknown>> }).$and;
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toEqual({ serviceCenterId: CENTER_A });
  });
});

describe('other scopes', () => {
  it('scopes a Technician to visits they were assigned', () => {
    /* Visits rather than current complaint assignment is what preserves a
       technician's completed history after a job is reassigned. */
    expect(visitScope(technician)).toEqual({ technicianId: TECH_ID });
  });

  it('scopes a Technician to attachments they uploaded', () => {
    expect(attachmentScope(technician)).toEqual({ uploadedBy: TECH_ID });
  });

  it('gives a Technician no access to stock at all', () => {
    /* null is distinct from {}: no business with the collection, versus
       unrestricted access to it. Conflating the two would hand a technician
       every center's inventory. */
    expect(partStockScope(technician)).toBeNull();
    expect(partStockScope(owner)).toEqual({ serviceCenterId: CENTER_A });
    expect(partStockScope(admin)).toEqual({});
  });

  it('limits an Owner to technicians at their own center', () => {
    /* Section 3.2: an Owner manages their own technicians. Without the role
       clause they could also reach Admin accounts. */
    expect(userScope(owner)).toEqual({
      serviceCenterId: CENTER_A,
      role: 'TECHNICIAN',
    });
  });

  it('limits a Technician to their own user record', () => {
    expect(userScope(technician)).toEqual({ _id: TECH_ID });
  });
});
