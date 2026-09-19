/**
 * Typed cities, an Indian state list, and a customer's products
 * (DECISIONS.md section 32).
 *
 * The client asked for cities nobody has to create in advance. The risk in
 * that is the one every free-text field carries — one place becoming two —
 * so most of what is checked here is that the same city, typed three ways by
 * three people at once, is stored once and matched once. The products list
 * is checked for the grouping and the warranty fields the screens read.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { INDIAN_STATES, canonicalState } from '../../src/core/india.js';
import { City, Complaint, Customer, Territory } from '../../src/models/index.js';
import { findOrCreateCity } from '../../src/modules/masters/geography.resolve.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();
const FIELDS = { cityIdField: 'cityId', cityNameField: 'cityName', stateField: 'state' };

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

interface Ctx {
  world: Awaited<ReturnType<typeof seedWorld>>;
  admin: string;
}
let c: Ctx;

beforeEach(async () => {
  const world = await seedWorld();
  c = { world, admin: await token('9800000001') };
});

const as = (bearer: string) => ({ Authorization: `Bearer ${bearer}` });

describe('the state list', () => {
  it('has every state and union territory, and matches the client copy', async () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(new Set(INDIAN_STATES).size).toBe(36);

    /* The client's copy is what the dropdowns show; a state missing from one
       side would be a choice the server refuses or one the form cannot make. */
    const fs = await import('node:fs');
    const path = await import('node:path');
    const clientCopy = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../client/src/lib/india.ts'),
      'utf8',
    );
    for (const state of INDIAN_STATES) {
      expect(clientCopy, `client list is missing ${state}`).toContain(`'${state}'`);
    }
  });

  it('reads a state however it is typed, and knows the older names', () => {
    expect(canonicalState('rajasthan')).toBe('Rajasthan');
    expect(canonicalState('  MADHYA   PRADESH ')).toBe('Madhya Pradesh');
    expect(canonicalState('Orissa')).toBe('Odisha');
    expect(canonicalState('Pondicherry')).toBe('Puducherry');
    expect(canonicalState('New Delhi')).toBe('Delhi');
    expect(canonicalState('Sindh')).toBeNull();
    expect(canonicalState('')).toBeNull();
  });
});

describe('typed cities', () => {
  it('stores a city once, however its name and state are typed', async () => {
    const first = await findOrCreateCity('Kota', 'rajasthan', FIELDS);
    const again = await findOrCreateCity('  kota ', 'Rajasthan', FIELDS);
    const spaced = await findOrCreateCity('KOTA', 'RAJASTHAN', FIELDS);

    expect(String(again._id)).toBe(String(first._id));
    expect(String(spaced._id)).toBe(String(first._id));
    expect(first.name).toBe('Kota');
    expect(first.state).toBe('Rajasthan');
    expect(await City.countDocuments({ name: /^kota$/i }).exec()).toBe(1);
  });

  it('keeps the same name in two states as two places', async () => {
    const a = await findOrCreateCity('Hyderabad', 'Telangana', FIELDS);
    const b = await findOrCreateCity('Hyderabad', 'Andhra Pradesh', FIELDS);
    expect(String(a._id)).not.toBe(String(b._id));
  });

  it('files each new city under a territory named after its state, created once', async () => {
    const city = await findOrCreateCity('Indore', 'Madhya Pradesh', FIELDS);
    const territory = await Territory.findById(city.territoryId).lean().exec();
    expect(territory?.name).toBe('Madhya Pradesh');

    await findOrCreateCity('Bhopal', 'madhya pradesh', FIELDS);
    expect(await Territory.countDocuments({ name: 'Madhya Pradesh' }).exec()).toBe(1);
  });

  it('refuses a state that is not in India', async () => {
    await expect(findOrCreateCity('Lahore', 'Punjab, Pakistan', FIELDS)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('creates one city when several requests type it at the same moment', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        findOrCreateCity(i % 2 ? 'Udaipur' : 'udaipur', 'Rajasthan', FIELDS),
      ),
    );
    const ids = new Set(results.map((city) => String(city._id)));
    expect(ids.size).toBe(1);
    expect(await City.countDocuments({ state: 'Rajasthan', name: /^udaipur$/i }).exec()).toBe(1);
  });
});

describe('typed cities through the API', () => {
  it('creates a customer with a typed city and the official state spelling', async () => {
    const res = await request(app)
      .post('/customers')
      .set(as(c.admin))
      .send({
        name: 'Meera Joshi',
        mobile: '9822222222',
        address: '7 Lake Road',
        cityName: 'Ajmer',
        state: 'rajasthan',
        pincode: '305001',
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.customer.state).toBe('Rajasthan');

    const stored = await Customer.findById(res.body.customer.id).lean().exec();
    const city = await City.findById(stored!.cityId).lean().exec();
    expect(city?.name).toBe('Ajmer');
    expect(city?.state).toBe('Rajasthan');
  });

  it('refuses a customer whose state is not Indian, naming the field', async () => {
    const res = await request(app)
      .post('/customers')
      .set(as(c.admin))
      .send({
        name: 'Nobody',
        mobile: '9823333333',
        address: '1 Road',
        cityName: 'Somewhere',
        state: 'Ontario',
        pincode: '305001',
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.issues)).toContain('state');
  });

  it('creates a service center and its typed coverage cities', async () => {
    const res = await request(app)
      .post('/service-centers')
      .set(as(c.admin))
      .send({
        name: 'Kota Service',
        code: 'KOT-01',
        mobile: '9876500011',
        address: '3 Station Road',
        cityName: 'Kota',
        state: 'Rajasthan',
        pincode: '324001',
        servedCities: [
          { name: 'Bundi', state: 'Rajasthan' },
          { name: 'bundi', state: 'rajasthan' },
        ],
        servedPincodes: ['324001'],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const centre = res.body.center;
    const own = await City.findById(centre.cityId).lean().exec();
    expect(own?.name).toBe('Kota');
    /* The coverage typed twice is one city. */
    expect(centre.servedCityIds).toHaveLength(1);
    const bundi = await City.findById(centre.servedCityIds[0]).lean().exec();
    expect(bundi?.name).toBe('Bundi');
    /* The territory follows the state, chosen by nobody. */
    const territory = await Territory.findById(centre.territoryId).lean().exec();
    expect(territory?.name).toBe('Rajasthan');
  });

  it('raises a complaint for a new customer in a city nobody has typed before', async () => {
    const res = await request(app)
      .post('/complaints')
      .set(as(c.admin))
      .send({
        newCustomer: {
          name: 'Ravi Menon',
          mobile: '9824444444',
          address: '12 Beach Road',
          cityName: 'Alappuzha',
          state: 'Kerala',
          pincode: '688001',
        },
        productId: String(c.world.product._id),
        productModelId: String(c.world.productModel._id),
        serialNumber: 'SN-GEO-1',
        purchaseDate: '2026-03-01',
        category: 'Not cooling',
        description: 'Warm air.',
        priority: 'NORMAL',
        warrantyStatus: 'IN_WARRANTY',
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.complaint.serviceAddress.cityName).toBe('Alappuzha');
    expect(res.body.complaint.serviceAddress.state).toBe('Kerala');
    expect(await City.countDocuments({ name: 'Alappuzha' }).exec()).toBe(1);
  });

  it('still recommends the centre for a typed city it covers', async () => {
    const res = await request(app)
      .get('/complaints/recommendations')
      .query({ pincode: '999999', cityName: 'jaipur', state: 'rajasthan' })
      .set(as(c.admin));

    expect(res.status).toBe(200);
    expect(res.body.recommended.map((centre: { code: string }) => centre.code)).toContain(
      c.world.center.code,
    );
  });
});

describe('a customer’s products', () => {
  it('lists each unit once, with the purchase date and warranty months the screens read', async () => {
    const raise = (serial: string, extra: Record<string, unknown> = {}) =>
      request(app)
        .post('/complaints')
        .set(as(c.admin))
        .send({
          customerId: String(c.world.customer._id),
          productId: String(c.world.product._id),
          productModelId: String(c.world.productModel._id),
          serialNumber: serial,
          category: 'Not cooling',
          description: 'x',
          priority: 'NORMAL',
          warrantyStatus: 'IN_WARRANTY',
          ...extra,
        });

    expect((await raise('SN-P-1', { purchaseDate: '2026-01-15' })).status).toBe(201);
    expect((await raise('SN-P-1')).status).toBe(201);
    expect((await raise('SN-P-2')).status).toBe(201);

    const res = await request(app)
      .get(`/customers/${c.world.customer._id}/history`)
      .set(as(c.admin));

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);

    const first = res.body.products.find((p: { serialNumber: string }) => p.serialNumber === 'SN-P-1');
    expect(first).toMatchObject({ complaints: 2, openComplaints: 2, productName: c.world.product.name });
    /* The purchase date survives from the complaint that recorded it. */
    expect(first.purchaseDate).toContain('2026-01-15');

    const second = res.body.products.find((p: { serialNumber: string }) => p.serialNumber === 'SN-P-2');
    expect(second.complaints).toBe(1);
    expect(second.purchaseDate).toBeUndefined();

    /* Never another customer's unit. */
    const stored = await Complaint.countDocuments({ customerId: c.world.customer._id }).exec();
    expect(stored).toBe(3);
  });
});
