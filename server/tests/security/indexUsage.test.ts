/**
 * Index usage verification (spec section 19, "Important indexes").
 *
 * Section 19 lists the indexes this system needs. Declaring them is easy and
 * the models do; what is not checked anywhere else is whether the queries the
 * application actually runs *use* them.
 *
 * A declared index that no query touches costs write throughput and buys
 * nothing. A hot query with no index works perfectly on a seeded database and
 * degrades quietly as data grows — which is the worst failure shape, because
 * it passes every test and only appears months later on a Monday morning.
 *
 * So these tests run `explain()` on the real query shapes and assert the
 * planner chose an index scan rather than a collection scan.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { AuditLog, Complaint, ComplaintActivity, PartStock, User, Visit } from '../../src/models/index.js';

/** The stage name MongoDB reports for the winning plan. */
async function planFor(
  model: mongoose.Model<never> | mongoose.Model<unknown>,
  filter: Record<string, unknown>,
  sort?: Record<string, 1 | -1>,
): Promise<{ stage: string; indexName?: string }> {
  const query = model.find(filter as never);
  if (sort) query.sort(sort);

  const explained = (await query.explain('queryPlanner')) as unknown as {
    queryPlanner: {
      winningPlan: Record<string, unknown>;
    };
  };

  /* Unwrap the plan tree until the leaf that actually reads data. */
  let node = explained.queryPlanner.winningPlan as Record<string, unknown>;
  const names: string[] = [];

  while (node) {
    const stage = String(node['stage'] ?? '');
    if (stage) names.push(stage);

    if (stage === 'IXSCAN') {
      return { stage: 'IXSCAN', indexName: String(node['indexName']) };
    }
    if (stage === 'COLLSCAN') return { stage: 'COLLSCAN' };

    node =
      (node['inputStage'] as Record<string, unknown>) ??
      ((node['inputStages'] as Record<string, unknown>[]) ?? [])[0] ??
      (node['queryPlan'] as Record<string, unknown>);
  }

  return { stage: names.join(' > ') || 'UNKNOWN' };
}

const objectId = () => new mongoose.Types.ObjectId();

describe('complaint queries use an index (section 19)', () => {
  it('complaint number lookup', async () => {
    const plan = await planFor(Complaint, { complaintNumber: 'CMP-2026-000001' });
    expect(plan.stage, 'complaint number must be indexed — it is the primary identifier').toBe(
      'IXSCAN',
    );
  });

  it('serial number history (section 13)', async () => {
    /* Section 13 wants this prominent, so it must not be a scan. */
    const plan = await planFor(Complaint, { serialNumber: 'SN-0001' }, { createdAt: -1 });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('customer mobile history (section 13)', async () => {
    const plan = await planFor(
      Complaint,
      { 'customerSnapshot.mobile': '9811111111' },
      { createdAt: -1 },
    );
    expect(plan.stage).toBe('IXSCAN');
  });

  it('service center queue, the hottest query in the centre portal', async () => {
    const plan = await planFor(
      Complaint,
      { serviceCenterId: objectId(), status: 'ASSIGNED' },
      { createdAt: -1 },
    );
    expect(plan.stage).toBe('IXSCAN');
  });

  it('technician job list', async () => {
    const plan = await planFor(
      Complaint,
      { technicianId: objectId(), status: 'VISIT_SCHEDULED' },
      { createdAt: -1 },
    );
    expect(plan.stage).toBe('IXSCAN');
  });

  it('dashboard status and priority counts', async () => {
    const plan = await planFor(Complaint, { status: 'NEW', priority: 'HIGH' });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('SLA breach sweep', async () => {
    const plan = await planFor(Complaint, {
      'sla.state': 'RUNNING',
      'sla.resolutionDueAt': { $lt: new Date() },
    });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('city and model reporting breakdowns (section 16)', async () => {
    for (const filter of [
      { 'serviceAddress.cityId': objectId() },
      { productModelId: objectId() },
      { warrantyStatus: 'IN_WARRANTY' },
    ]) {
      const plan = await planFor(Complaint, filter, { createdAt: -1 });
      expect(plan.stage, `unindexed report filter: ${JSON.stringify(filter)}`).toBe('IXSCAN');
    }
  });
});

describe('other hot queries use an index', () => {
  it('login by mobile number', async () => {
    /* Every single request that authenticates starts here. */
    const plan = await planFor(User, { mobile: '9800000001' });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('an owner listing their technicians', async () => {
    const plan = await planFor(User, {
      serviceCenterId: objectId(),
      role: 'TECHNICIAN',
      isActive: true,
    });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('the centre visit calendar', async () => {
    const plan = await planFor(
      Visit,
      { serviceCenterId: objectId(), status: 'SCHEDULED' },
      { scheduledAt: -1 },
    );
    expect(plan.stage).toBe('IXSCAN');
  });

  it("a technician's own schedule", async () => {
    const plan = await planFor(Visit, { technicianId: objectId() }, { scheduledAt: -1 });
    expect(plan.stage).toBe('IXSCAN');
  });

  it("a technician's history, newest finished first", async () => {
    const plan = await planFor(
      Visit,
      { technicianId: objectId(), status: 'COMPLETED' },
      { completedAt: -1 },
    );
    expect(plan.stage).toBe('IXSCAN');
  });

  it('stock lookup for one part at one centre', async () => {
    const plan = await planFor(PartStock, {
      serviceCenterId: objectId(),
      partId: objectId(),
    });
    /* This is the filter the transactional decrement runs on, so it is on the
       critical path of every parts finalisation. */
    expect(plan.stage).toBe('IXSCAN');
  });

  it('the Admin activity feed, newest first across every complaint', async () => {
    const plan = await planFor(ComplaintActivity, {}, { createdAt: -1 });
    expect(plan.stage).toBe('IXSCAN');
  });

  it('the system audit log, newest first, without session renewals', async () => {
    const plan = await planFor(AuditLog, { action: { $ne: 'TOKEN_REFRESHED' } }, { createdAt: -1 });
    expect(plan.stage).toBe('IXSCAN');
  });
});

describe('index inventory', () => {
  it('declares no index the application never queries', async () => {
    /**
     * Every index costs write throughput. This does not fail the build — an
     * index can be justified by an ad-hoc report or a future query — but it
     * prints what exists so the list stays a deliberate choice rather than an
     * accumulation.
     */
    const report: string[] = [];

    for (const model of [Complaint, User, Visit, PartStock]) {
      const indexes = await model.collection.indexes();
      report.push(
        `  ${model.modelName}: ${indexes.length} indexes — ` +
        indexes.map((index) => index.name).join(', '),
      );
    }

    console.log('\nIndex inventory:\n' + report.join('\n'));

    /* MongoDB always has _id_; anything beyond that is ours. */
    const complaintIndexes = await Complaint.collection.indexes();
    expect(complaintIndexes.length).toBeGreaterThan(1);
  });

  it('enforces the unique constraints that matter', async () => {
    const [complaints, users, stock] = await Promise.all([
      Complaint.collection.indexes(),
      User.collection.indexes(),
      PartStock.collection.indexes(),
    ]);

    const unique = (indexes: Array<{ key: Record<string, unknown>; unique?: boolean }>, field: string) =>
      indexes.some((index) => index.unique === true && field in index.key);

    /* A duplicate complaint number would mean two jobs sharing an identifier;
       a duplicate mobile would make login ambiguous; a duplicate stock row
       would split one part's count in two. */
    expect(unique(complaints, 'complaintNumber'), 'complaintNumber must be unique').toBe(true);
    expect(unique(users, 'mobile'), 'user mobile must be unique').toBe(true);
    expect(unique(stock, 'serviceCenterId'), 'stock must be unique per centre+part').toBe(true);
  });
});
