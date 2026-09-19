/**
 * Editing and finding user accounts (spec sections 3.1, 3.2, 9).
 *
 * The bug: clearing a technician's email and saving said "updated", but the
 * old address stayed. The screens left an empty field out of the request, and
 * the API had no way to say "remove it" anyway. An emptied optional field now
 * arrives as `""` (or `null`) and is removed.
 *
 * Also here: searching people by a mobile typed the way the screens show it.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { AuditLog, User } from '../../src/models/index.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();

async function token(mobile: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ mobile, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

let world: Awaited<ReturnType<typeof seedWorld>>;
let admin: string;
let owner: string;

beforeEach(async () => {
  world = await seedWorld();
  admin = await token('9800000001');
  owner = await token('9800000002');
});

const patch = (tokenValue: string, id: unknown, body: Record<string, unknown>) =>
  request(app).patch(`/users/${String(id)}`).set('Authorization', `Bearer ${tokenValue}`).send(body);

describe('clearing an optional email', () => {
  it('removes it when the field is emptied', async () => {
    await User.updateOne({ _id: world.technician._id }, { $set: { email: 'ravi@example.com' } });

    const res = await patch(owner, world.technician._id, { name: 'Technician', email: '' });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBeUndefined();

    const stored = await User.findById(world.technician._id).lean().exec();
    expect(stored).not.toHaveProperty('email');
  });

  it('removes it for null too, and records the change', async () => {
    await User.updateOne({ _id: world.owner._id }, { $set: { email: 'owner@example.com' } });

    const res = await patch(admin, world.owner._id, { email: null });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBeUndefined();

    const entry = await AuditLog.findOne({ entityId: String(world.owner._id), action: 'USER_UPDATED' })
      .lean()
      .exec();
    expect(entry?.changes).toEqual([
      expect.objectContaining({ field: 'email', oldValue: 'owner@example.com' }),
    ]);
  });

  it('leaves it alone when the field is not sent', async () => {
    await User.updateOne({ _id: world.technician._id }, { $set: { email: 'ravi@example.com' } });

    const res = await patch(owner, world.technician._id, { name: 'Ravi' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Ravi');
    expect(res.body.user.email).toBe('ravi@example.com');
  });

  it('still refuses an address that is not an email, and changes one that is', async () => {
    const bad = await patch(owner, world.technician._id, { email: 'not-an-email' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.issues).toEqual([expect.objectContaining({ field: 'email' })]);

    const good = await patch(owner, world.technician._id, { email: ' Ravi@Example.com ' });
    expect(good.status).toBe(200);
    expect(good.body.user.email).toBe('ravi@example.com');
  });

  it('does not record a change when nothing changed', async () => {
    /* No email before, none after: saving the form untouched is not an edit. */
    const res = await patch(owner, world.technician._id, { name: 'Technician', email: '' });

    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({ entityId: String(world.technician._id), action: 'USER_UPDATED' })).toBe(0);
  });

  it('accepts an empty email when adding someone, as no email', async () => {
    const res = await request(app)
      .post('/users')
      .set('Authorization', `Bearer ${owner}`)
      .send({ role: 'TECHNICIAN', name: 'New Technician', mobile: '9800000044', email: '' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBeUndefined();
  });
});

describe('finding people', () => {
  it('finds a mobile typed the way the screens show it, and still finds names', async () => {
    for (const search of ['98000 00003', '+91 98000 00003', '0 98000 00003', '98000-0000', 'techni']) {
      const res = await request(app)
        .get('/users')
        .query({ role: 'TECHNICIAN', search })
        .set('Authorization', `Bearer ${owner}`);

      expect(res.status, `searching for "${search}"`).toBe(200);
      expect(
        res.body.items.map((user: { id: string }) => user.id),
        `searching for "${search}"`,
      ).toEqual([String(world.technician._id)]);
    }
  });
});
