/**
 * Master data and user management tests (spec sections 3.1, 3.2, 8, 9, 13).
 *
 * The centrepiece is technician onboarding: until now nothing could create
 * one, so the `mustChangePassword` flow built in the auth phase had no way of
 * being reached in real use.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Complaint, Customer, User } from '../../src/models/index.js';
import { TEST_PASSWORD, makeServiceCenter, seedWorld } from '../fixtures.js';

const app = createApp();

async function token(mobile: string, password = TEST_PASSWORD): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
  owner: string;
  tech: string;
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  c = {
    world,
    admin: await token('9800000001'),
    owner: await token('9800000002'),
    tech: await token('9800000003'),
  };
});

describe('technician onboarding (section 3.2, DECISIONS 4.5)', () => {
  it('lets an owner create a technician who must then change their password', async () => {
    const created = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ role: 'TECHNICIAN', name: 'Ravi Kumar', mobile: '9812345670' });

    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toBeTruthy();
    expect(created.body.user.mustChangePassword).toBe(true);
    /* The technician is attached to the Owner's centre without the request
       ever naming it, so there is nothing to spoof. */
    expect(created.body.user.serviceCenterId).toBe(String(c.world.center._id));

    /* The temporary password works once. */
    const first = await request(app)
      .post('/auth/login')
      .send({ mobile: '9812345670', password: created.body.temporaryPassword });
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);

    /* But nothing else is reachable until it is replaced. */
    const blocked = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${first.body.accessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/temporary password/i);

    await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({
        currentPassword: created.body.temporaryPassword,
        newPassword: 'chosen-by-the-technician',
      });

    const after = await token('9812345670', 'chosen-by-the-technician');
    const working = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${after}`);
    expect(working.status).toBe(200);
  });

  it('refuses an owner creating anything but a technician', async () => {
    /* Section 3.2 grants exactly one creation power. */
    for (const role of ['ADMIN', 'SERVICE_CENTER_OWNER']) {
      const res = await request(app)
        .post('/users')
        .set('Authorization', `Bearer ${c.owner}`)
        .send({ role, name: 'Sneaky', mobile: '9812345671' });

      expect(res.status, `owner should not create ${role}`).toBe(403);
    }
  });

  it('refuses an owner creating a technician for another center', async () => {
    const other = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-30');

    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({
        role: 'TECHNICIAN',
        name: 'Elsewhere Tech',
        mobile: '9812345672',
        serviceCenterId: String(other._id),
      });

    expect(res.status).toBe(403);
  });

  it('refuses a technician creating anyone', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.tech}`)
      .send({ role: 'TECHNICIAN', name: 'Clone', mobile: '9812345673' });

    expect(res.status).toBe(403);
  });

  it('refuses a duplicate mobile number', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ role: 'TECHNICIAN', name: 'Duplicate', mobile: '9800000003' });

    /* Mobile is the login identifier, so a clash is a genuine conflict. */
    expect(res.status).toBe(409);
  });

  it('scopes an owner to their own technicians', async () => {
    const other = await makeServiceCenter(c.world.city._id, c.world.territory._id, 'JAI-31');
    await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        role: 'TECHNICIAN',
        name: 'Other Centre Tech',
        mobile: '9812345674',
        serviceCenterId: String(other._id),
      });

    const list = await request(app)
      .get('/users')
      .set('Authorization', `Bearer ${c.owner}`);

    const names = list.body.items.map((u: { name: string }) => u.name);
    expect(names).not.toContain('Other Centre Tech');
    /* And an Owner sees no Admins either — userScope pins role to TECHNICIAN. */
    expect(list.body.items.every((u: { role: string }) => u.role === 'TECHNICIAN')).toBe(
      true,
    );
  });
});

describe('deactivation (sections 8, 9)', () => {
  it('lists the open jobs a deactivated technician leaves behind', async () => {
    /* Section 9: "Existing jobs remain in history. Service Center Owner must
       reassign active jobs." */
    const complaint = await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-DEACT',
        category: 'Not cooling',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(c.world.center._id),
      });

    await request(app)
      .post(`/complaints/${complaint.body.complaint.id}/assign-technician`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ technicianId: String(c.world.technician._id) });

    const res = await request(app)
      .patch(`/users/${c.world.technician._id}`)
      .set('Authorization', `Bearer ${c.owner}`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.openJobsNeedingReassignment).toHaveLength(1);
    expect(res.body.warning).toMatch(/must be reassigned/i);

    /* History survives; only access and new work stop. */
    const stillThere = await Complaint.findById(complaint.body.complaint.id).lean().exec();
    expect(String(stillThere!.technicianId)).toBe(String(c.world.technician._id));
  });

  it('lists the open complaints a deactivated service center leaves behind', async () => {
    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-CENTRE',
        category: 'Not cooling',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
        serviceCenterId: String(c.world.center._id),
      });

    /* Section 8: "Existing complaint history remains unchanged. Open
       complaints must be reassigned by Admin." */
    const res = await request(app)
      .patch(`/service-centers/${c.world.center._id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ isActive: false });

    expect(res.body.openComplaintsNeedingReassignment).toHaveLength(1);
    expect(res.body.warning).toMatch(/must be reassigned/i);
  });

  it('refuses to let someone deactivate themselves', async () => {
    /* Recovering needs another Admin, so this is refused rather than
       confirmed. */
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${c.admin}`);

    const res = await request(app)
      .patch(`/users/${me.body.id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ isActive: false });

    expect(res.status).toBe(400);
  });
});

describe('password reset', () => {
  it('issues a new temporary password and revokes existing sessions', async () => {
    const techToken = c.tech;

    const reset = await request(app)
      .post(`/users/${c.world.technician._id}/reset-password`)
      .set('Authorization', `Bearer ${c.owner}`);

    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).toBeTruthy();
    expect(reset.body.user.mustChangePassword).toBe(true);

    /* The session opened before the reset must die — otherwise whoever knew
       the old password keeps their access. */
    const stale = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${techToken}`);
    expect(stale.status).toBe(401);

    const fresh = await request(app)
      .post('/auth/login')
      .send({ mobile: '9800000003', password: reset.body.temporaryPassword });
    expect(fresh.status).toBe(200);
  });
});

describe('master data (section 25 Phase 2)', () => {
  it('creates the full chain: territory, city, center, product, model', async () => {
    const territory = await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'South', code: 'SOUTH' });
    expect(territory.status).toBe(201);

    const city = await request(app)
      .post('/cities')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        name: 'Kochi',
        state: 'Kerala',
        territoryId: territory.body.territory.id,
      });
    expect(city.status).toBe(201);

    const centre = await request(app)
      .post('/service-centers')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        name: 'Kochi Service',
        code: 'KOC-01',
        mobile: '9876512345',
        address: '1 Marine Drive',
        cityId: city.body.city.id,
        pincode: '682001',
        territoryId: territory.body.territory.id,
        servedPincodes: ['682001', '682002'],
      });
    expect(centre.status).toBe(201);

    const product = await request(app)
      .post('/products')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Tower Cooler 30L', code: 'TC30' });
    expect(product.status).toBe(201);

    const model = await request(app)
      .post('/product-models')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ productId: product.body.product.id, modelNumber: 'TC30-A' });
    expect(model.status).toBe(201);

    /* And the new centre is immediately usable by the section 8 recommender. */
    const recommended = await request(app)
      .get('/complaints/recommendations?pincode=682001')
      .set('Authorization', `Bearer ${c.admin}`);
    expect(
      recommended.body.recommended.map((r: { code: string }) => r.code),
    ).toContain('KOC-01');
  });

  it('refuses duplicate codes', async () => {
    await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'West', code: 'WEST' });

    const again = await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Western', code: 'WEST' });

    expect(again.status).toBe(409);
  });

  it('allows the same city name in a different state', async () => {
    const t = await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'East', code: 'EAST' });

    /* Uniqueness is on name+state, because two places can share a name. Both
       states must be Indian ones now (section 32), so the second Hyderabad
       is the one in Andhra Pradesh rather than the one across the border. */
    const first = await request(app)
      .post('/cities')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Hyderabad', state: 'Telangana', territoryId: t.body.territory.id });
    const second = await request(app)
      .post('/cities')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Hyderabad', state: 'Andhra Pradesh', territoryId: t.body.territory.id });

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    /* And a state that is not in India is refused, naming the field. */
    const abroad = await request(app)
      .post('/cities')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Hyderabad', state: 'Sindh', territoryId: t.body.territory.id });
    expect(abroad.status).toBe(400);
  });

  it('lets all roles read masters but only Admin write them', async () => {
    for (const [role, tok] of [['owner', c.owner], ['technician', c.tech]] as const) {
      const read = await request(app)
        .get('/products')
        .set('Authorization', `Bearer ${tok}`);
      expect(read.status, `${role} should read products`).toBe(200);

      const write = await request(app)
        .post('/products')
        .set('Authorization', `Bearer ${tok}`)
        .send({ name: 'Unauthorised', code: 'NOPE-1' });
      expect(write.status, `${role} should not create products`).toBe(403);
    }
  });
});

describe('customers and history (section 13)', () => {
  it('refuses a second customer with the same mobile number', async () => {
    const res = await request(app)
      .post('/customers')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        name: 'Someone Else',
        mobile: '9811111111',
        address: 'x',
        cityId: String(c.world.city._id),
        state: 'Rajasthan',
        pincode: '302001',
      });

    /* A duplicate would split one person's service history in two. */
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already registered/i);
  });

  it('will not let a customer mobile number be changed', async () => {
    const res = await request(app)
      .patch(`/customers/${c.world.customer._id}`)
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ mobile: '9999999999' });

    /**
     * Mobile is the customer's identity and is snapshotted onto every
     * complaint; changing it would orphan their history.
     *
     * The schema is strict rather than merely omitting the field, so this is
     * a 400 — not a 200 that silently discarded the change and reported
     * success.
     */
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    /* And the number really is untouched. */
    const customer = await Customer.findById(c.world.customer._id).lean().exec();
    expect(customer!.mobile).toBe('9811111111');
  });

  it('returns a customer\'s complaint history for the repeat decision', async () => {
    for (const serial of ['SN-H1', 'SN-H2']) {
      await request(app)
        .post('/complaints')
        .set('Authorization', `Bearer ${c.admin}`)
        .send({
          customerId: String(c.world.customer._id),
          productId: String(c.world.product._id),
          productModelId: String(c.world.productModel._id),
          serialNumber: serial,
          category: 'Not cooling',
          description: 'x',
          priority: 'NORMAL',
          warrantyStatus: 'IN_WARRANTY',
        });
    }

    const res = await request(app)
      .get(`/customers/${c.world.customer._id}/history`)
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    /* Workflow G: the decision stays human, so the response says so. */
    expect(res.body.note).toMatch(/reopen an existing complaint or raise a new one/i);
  });

  it('returns serial-number history and flags a repeat unit', async () => {
    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .post('/complaints')
        .set('Authorization', `Bearer ${c.admin}`)
        .send({
          customerId: String(c.world.customer._id),
          productId: String(c.world.product._id),
          productModelId: String(c.world.productModel._id),
          serialNumber: 'SN-REPEAT',
          category: 'Not cooling',
          description: 'x',
          priority: 'NORMAL',
          warrantyStatus: 'IN_WARRANTY',
        });
    }

    const res = await request(app)
      .get('/serial-history/SN-REPEAT')
      .set('Authorization', `Bearer ${c.admin}`);

    /* Section 13 wants this prominent: same unit, more than once. */
    expect(res.body.total).toBe(2);
    expect(res.body.isRepeatUnit).toBe(true);
  });

  it('matches a serial number regardless of the case typed', async () => {
    await request(app)
      .post('/complaints')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        customerId: String(c.world.customer._id),
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'sn-lower',
        category: 'Not cooling',
        description: 'x',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
      });

    const res = await request(app)
      .get('/serial-history/SN-LOWER')
      .set('Authorization', `Bearer ${c.admin}`);

    expect(res.body.total).toBe(1);
  });
});

describe('the seeded admin can now build a working system from scratch', () => {
  it('creates a center, its owner, and a technician end to end', async () => {
    const territory = await request(app)
      .post('/territories')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Central', code: 'CENTRAL' });

    const city = await request(app)
      .post('/cities')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({ name: 'Bhopal', state: 'Madhya Pradesh', territoryId: territory.body.territory.id });

    const centre = await request(app)
      .post('/service-centers')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        name: 'Bhopal Service',
        code: 'BHO-01',
        mobile: '9876500001',
        address: '5 MP Nagar',
        cityId: city.body.city.id,
        pincode: '462011',
        territoryId: territory.body.territory.id,
      });

    const owner = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${c.admin}`)
      .send({
        role: 'SERVICE_CENTER_OWNER',
        name: 'Bhopal Owner',
        mobile: '9812340001',
        serviceCenterId: centre.body.center.id,
      });
    expect(owner.status).toBe(201);

    /* The new Owner signs in, replaces their temporary password, and hires. */
    const firstLogin = await request(app)
      .post('/auth/login')
      .send({ mobile: '9812340001', password: owner.body.temporaryPassword });

    await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${firstLogin.body.accessToken}`)
      .send({
        currentPassword: owner.body.temporaryPassword,
        newPassword: 'owner-chosen-passphrase',
      });

    const ownerToken = await token('9812340001', 'owner-chosen-passphrase');

    const technician = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'TECHNICIAN', name: 'Bhopal Tech', mobile: '9812340002' });

    expect(technician.status).toBe(201);
    expect(technician.body.user.serviceCenterId).toBe(centre.body.center.id);

    /* Three roles, one new centre, entirely through the API. */
    const staff = await User.find({ serviceCenterId: centre.body.center.id }).lean().exec();
    expect(staff.map((u) => u.role).sort()).toEqual([
      'SERVICE_CENTER_OWNER',
      'TECHNICIAN',
    ]);
  });
});
