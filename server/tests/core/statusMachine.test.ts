/**
 * Status machine tests.
 *
 * The table in `statusMachine.ts` is where spec section 22's prohibitions
 * become real. These tests exist to prove the prohibitions actually hold —
 * particularly the three the spec calls out by name:
 *
 *   "Technician attempts to close    -> Backend rejects request"
 *   "Service Center attempts final closure -> Backend rejects request"
 *   "Happy Code mismatch             -> Admin cannot close complaint"
 */
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  availableTransitions,
  TRANSITIONS,
  transitionsFrom,
  type ComplaintStateView,
} from '../../src/core/statusMachine.js';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '../../src/models/enums.js';

/** A complaint in a given state, with everything assigned unless overridden. */
function complaint(
  status: ComplaintStatus,
  overrides: Partial<ComplaintStateView> = {},
): ComplaintStateView {
  return {
    status,
    serviceCenterId: 'center-1',
    technicianId: 'tech-1',
    happyCodeVerifiedAt: null,
    ...overrides,
  };
}

describe('the happy path from section 7', () => {
  it('walks NEW to CLOSED through the roles the spec assigns', () => {
    /* Each step names the role the spec gives it. If any of these threw, the
       documented end-to-end flow would be unwalkable. */
    const steps: Array<[ComplaintStatus, ComplaintStatus, Parameters<typeof assertTransition>[0]['role']]> = [
      ['NEW', 'ASSIGNED', 'ADMIN'],
      ['ASSIGNED', 'TECHNICIAN_ASSIGNED', 'SERVICE_CENTER_OWNER'],
      ['TECHNICIAN_ASSIGNED', 'VISIT_SCHEDULED', 'SERVICE_CENTER_OWNER'],
      ['VISIT_SCHEDULED', 'IN_PROGRESS', 'TECHNICIAN'],
      ['IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'TECHNICIAN'],
      ['RESOLUTION_SUBMITTED', 'ADMIN_CONFIRMATION', 'SERVICE_CENTER_OWNER'],
    ];

    for (const [from, to, role] of steps) {
      expect(() =>
        assertTransition({ complaint: complaint(from), to, role }),
      ).not.toThrow();
    }

    /* The final step additionally needs a verified Happy Code. */
    expect(() =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION', {
          happyCodeVerifiedAt: new Date(),
        }),
        to: 'CLOSED',
        role: 'ADMIN',
      }),
    ).not.toThrow();
  });
});

describe('section 22 prohibitions', () => {
  it('rejects a technician trying to close', () => {
    /* "Technician attempts to close -> Backend rejects request" */
    expect(() =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION', {
          happyCodeVerifiedAt: new Date(),
        }),
        to: 'CLOSED',
        role: 'TECHNICIAN',
      }),
    ).toThrow(/Only ADMIN can do that/);
  });

  it('rejects a service center owner trying to final-close', () => {
    /* "Service Center attempts final closure -> Backend rejects request" */
    expect(() =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION', {
          happyCodeVerifiedAt: new Date(),
        }),
        to: 'CLOSED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).toThrow(/Only ADMIN can do that/);
  });

  it('rejects an owner closing from RESOLUTION_SUBMITTED without Happy Code', () => {
    /* Owner can close from RESOLUTION_SUBMITTED, but only when the Happy Code
       has been verified (DECISIONS.md section 33). Without it the precondition
       blocks the transition. */
    expect(() =>
      assertTransition({
        complaint: complaint('RESOLUTION_SUBMITTED'),
        to: 'CLOSED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).toThrow(/Happy Code must be verified/);
  });

  it('blocks closure when the Happy Code has not been verified', () => {
    /* "Happy Code mismatch -> Admin cannot close complaint" */
    expect(() =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION', { happyCodeVerifiedAt: null }),
        to: 'CLOSED',
        role: 'ADMIN',
      }),
    ).toThrow(/Happy Code must be verified/);
  });

  it('rejects a technician assigning work to themselves', () => {
    /* Section 3.3: a technician cannot assign or reassign jobs. */
    expect(() =>
      assertTransition({
        complaint: complaint('ASSIGNED'),
        to: 'TECHNICIAN_ASSIGNED',
        role: 'TECHNICIAN',
      }),
    ).toThrow(/Only SERVICE_CENTER_OWNER can do that/);
  });

  it('rejects an owner assigning a service center', () => {
    /* Section 3.2: an Owner cannot assign complaints to another centre. */
    expect(() =>
      assertTransition({
        complaint: complaint('NEW'),
        to: 'ASSIGNED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).toThrow(/Only ADMIN can do that/);
  });
});

describe('preconditions', () => {
  it('will not assign a service center that is not set', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('NEW', { serviceCenterId: undefined }),
        to: 'ASSIGNED',
        role: 'ADMIN',
      }),
    ).toThrow(/service center must be selected/);
  });

  it('will not move to TECHNICIAN_ASSIGNED without a technician', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('ASSIGNED', { technicianId: undefined }),
        to: 'TECHNICIAN_ASSIGNED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).toThrow(/technician must be assigned/);
  });

  it('distinguishes a permission failure from an unmet precondition', () => {
    /* These must not collapse into one message: an Admin needs to know
       whether they lack permission or the code is simply unverified. */
    const wrongRole = () =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION', {
          happyCodeVerifiedAt: new Date(),
        }),
        to: 'CLOSED',
        role: 'TECHNICIAN',
      });

    const notReady = () =>
      assertTransition({
        complaint: complaint('ADMIN_CONFIRMATION'),
        to: 'CLOSED',
        role: 'ADMIN',
      });

    expect(wrongRole).toThrow(/permission|Only ADMIN/);
    expect(notReady).toThrow(/Happy Code/);
  });
});

describe('mandatory reasons', () => {
  it('requires a reason to reject a resolution', () => {
    /* Workflow E step 4: "Reason is mandatory." */
    expect(() =>
      assertTransition({
        complaint: complaint('RESOLUTION_SUBMITTED'),
        to: 'REVISIT_REQUIRED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).toThrow(/reason is required/i);

    expect(() =>
      assertTransition({
        complaint: complaint('RESOLUTION_SUBMITTED'),
        to: 'REVISIT_REQUIRED',
        role: 'SERVICE_CENTER_OWNER',
        reason: 'Cooling still inadequate after service',
      }),
    ).not.toThrow();
  });

  it('treats whitespace as no reason at all', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('CLOSED'),
        to: 'REOPENED',
        role: 'ADMIN',
        reason: '    ',
      }),
    ).toThrow(/reason is required/i);
  });

  it('requires a reason to cancel', () => {
    expect(() =>
      assertTransition({ complaint: complaint('NEW'), to: 'CANCELLED', role: 'ADMIN' }),
    ).toThrow(/reason is required/i);
  });
});

describe('revisit and parts loops', () => {
  it('allows the revisit cycle from section 7', () => {
    /* REVISIT_REQUIRED -> VISIT_SCHEDULED -> IN_PROGRESS -> RESOLUTION_SUBMITTED */
    expect(() =>
      assertTransition({
        complaint: complaint('REVISIT_REQUIRED'),
        to: 'VISIT_SCHEDULED',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).not.toThrow();

    expect(() =>
      assertTransition({
        complaint: complaint('VISIT_SCHEDULED'),
        to: 'IN_PROGRESS',
        role: 'TECHNICIAN',
      }),
    ).not.toThrow();
  });

  it('allows the waiting-for-parts cycle from Workflow D', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('IN_PROGRESS'),
        to: 'WAITING_FOR_PARTS',
        role: 'TECHNICIAN',
        reason: 'Fan motor out of stock',
      }),
    ).not.toThrow();

    expect(() =>
      assertTransition({
        complaint: complaint('WAITING_FOR_PARTS'),
        to: 'IN_PROGRESS',
        role: 'SERVICE_CENTER_OWNER',
      }),
    ).not.toThrow();
  });
});

describe('reopen', () => {
  it('lets Admin reopen a closed complaint with a reason', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('CLOSED'),
        to: 'REOPENED',
        role: 'ADMIN',
        reason: 'Same fault recurred within a week',
      }),
    ).not.toThrow();
  });

  it('does not let an owner reopen', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('CLOSED'),
        to: 'REOPENED',
        role: 'SERVICE_CENTER_OWNER',
        reason: 'Customer called us back',
      }),
    ).toThrow(/Only ADMIN can do that/);
  });

  it('lets Admin recover a complaint cancelled by mistake', () => {
    /* Beyond the spec, and justified in DECISIONS.md section 11: without it a
       mis-cancelled complaint is unrecoverable and the only remedy is a
       duplicate, which fights rule 15. */
    expect(() =>
      assertTransition({
        complaint: complaint('CANCELLED'),
        to: 'REOPENED',
        role: 'ADMIN',
        reason: 'Cancelled in error',
      }),
    ).not.toThrow();
  });
});

describe('table integrity', () => {
  it('rejects a no-op transition', () => {
    expect(() =>
      assertTransition({
        complaint: complaint('IN_PROGRESS'),
        to: 'IN_PROGRESS',
        role: 'TECHNICIAN',
      }),
    ).toThrow(/already in progress/i);
  });

  it('every path to CLOSED requires Happy Code or is an Admin override', () => {
    /* DECISIONS.md section 33: multiple roles can close, but non-admin
       paths always require HAPPY_CODE_VERIFIED. Admin can close from
       RESOLUTION_SUBMITTED without it (override). */
    const toClosed = TRANSITIONS.filter((rule) => rule.to === 'CLOSED');

    for (const rule of toClosed) {
      const isAdmin = rule.roles.includes('ADMIN');
      const requiresCode = rule.requires?.includes('HAPPY_CODE_VERIFIED');
      expect(
        isAdmin || requiresCode,
        `${rule.from} → CLOSED for ${rule.roles.join(',')} needs HAPPY_CODE_VERIFIED or ADMIN`,
      ).toBe(true);
    }
  });

  it('references only statuses declared in the spec', () => {
    const known = new Set<string>(COMPLAINT_STATUSES);
    for (const rule of TRANSITIONS) {
      expect(known.has(rule.from)).toBe(true);
      expect(known.has(rule.to)).toBe(true);
    }
  });

  it('leaves no non-terminal status stranded', () => {
    /* Every status a complaint can occupy must have a way out, or work
       reaching it can never progress or be cancelled. */
    for (const status of COMPLAINT_STATUSES) {
      if (status === 'CLOSED' || status === 'CANCELLED') continue;
      expect(transitionsFrom(status).length).toBeGreaterThan(0);
    }
  });

  it('gives even the terminal statuses a recovery path', () => {
    expect(transitionsFrom('CLOSED').map((r) => r.to)).toContain('REOPENED');
    expect(transitionsFrom('CANCELLED').map((r) => r.to)).toContain('REOPENED');
  });

  it('never grants a role a transition the table does not list', () => {
    /* availableTransitions drives the UI's action list; if it offered
       anything assertTransition would refuse, the UI would show buttons that
       fail on click. */
    for (const status of COMPLAINT_STATUSES) {
      for (const role of ['ADMIN', 'SERVICE_CENTER_OWNER', 'TECHNICIAN'] as const) {
        const state = complaint(status, { happyCodeVerifiedAt: new Date() });
        for (const rule of availableTransitions(state, role)) {
          expect(rule.roles).toContain(role);
          expect(() =>
            assertTransition({
              complaint: state,
              to: rule.to,
              role,
              reason: 'reason supplied for rules that need one',
            }),
          ).not.toThrow();
        }
      }
    }
  });
});

describe('availableTransitions', () => {
  it('hides closure from Admin until the Happy Code is verified', () => {
    const unverified = availableTransitions(
      complaint('ADMIN_CONFIRMATION'),
      'ADMIN',
    );
    expect(unverified.map((r) => r.to)).not.toContain('CLOSED');

    const verified = availableTransitions(
      complaint('ADMIN_CONFIRMATION', { happyCodeVerifiedAt: new Date() }),
      'ADMIN',
    );
    expect(verified.map((r) => r.to)).toContain('CLOSED');
  });

  it('offers a technician nothing on a complaint awaiting review', () => {
    /* Once submitted, the next move belongs to the Owner. */
    expect(
      availableTransitions(complaint('RESOLUTION_SUBMITTED'), 'TECHNICIAN'),
    ).toHaveLength(0);
  });

  it('offers the owner exactly accept or reject after submission', () => {
    const options = availableTransitions(
      complaint('RESOLUTION_SUBMITTED'),
      'SERVICE_CENTER_OWNER',
    ).map((r) => r.to);

    expect(options.sort()).toEqual(['ADMIN_CONFIRMATION', 'REVISIT_REQUIRED']);
  });
});
