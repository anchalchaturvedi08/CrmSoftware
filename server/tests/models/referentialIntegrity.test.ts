/**
 * Tests for the foreign-key substitute.
 *
 * This is the most important test file in the model layer. Choosing MongoDB
 * over the relational database the spec asked for (section 18) means
 * referential integrity is application code — so if this plugin does not
 * actually work, nothing enforces it and the compensating control documented
 * in DECISIONS.md section 3 is fiction.
 *
 * What has to hold:
 *   - a reference to a document that does not exist is rejected
 *   - a `refActive` reference to a deactivated document is rejected
 *   - a valid reference is accepted
 *   - query-based updates are checked too, not just document saves
 *   - checks see uncommitted documents inside the caller's transaction
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  City,
  Customer,
  ServiceCenter,
  Territory,
  User,
} from '../../src/models/index.js';

/** Minimal valid territory + city, which most other fixtures depend on. */
async function seedGeography() {
  const territory = await Territory.create({ name: 'North', code: 'NORTH' });
  const city = await City.create({
    name: 'Jaipur',
    state: 'Rajasthan',
    territoryId: territory._id,
  });
  return { territory, city };
}

async function seedServiceCenter(cityId: mongoose.Types.ObjectId, territoryId: mongoose.Types.ObjectId) {
  return ServiceCenter.create({
    name: 'Jaipur Central Service',
    code: 'JAI-01',
    mobile: '9876543210',
    address: '12 Station Road',
    cityId,
    pincode: '302001',
    territoryId,
  });
}

describe('referential integrity plugin', () => {
  it('rejects a reference to a document that does not exist', async () => {
    const orphanId = new mongoose.Types.ObjectId();

    await expect(
      City.create({ name: 'Nowhere', state: 'Nowhere', territoryId: orphanId }),
    ).rejects.toThrow(/Territory not found/);
  });

  it('accepts a reference to a document that does exist', async () => {
    const { territory } = await seedGeography();

    const city = await City.create({
      name: 'Udaipur',
      state: 'Rajasthan',
      territoryId: territory._id,
    });

    expect(city.territoryId.equals(territory._id)).toBe(true);
  });

  it('rejects a refActive reference to a deactivated document', async () => {
    const { city, territory } = await seedGeography();
    const center = await seedServiceCenter(city._id, territory._id);

    /* Section 9: a technician may not be attached to a dead centre. */
    await ServiceCenter.updateOne({ _id: center._id }, { $set: { isActive: false } });

    await expect(
      User.create({
        role: 'TECHNICIAN',
        name: 'Ravi Kumar',
        mobile: '9812345678',
        passwordHash: 'placeholder-hash',
        serviceCenterId: center._id,
      }),
    ).rejects.toThrow(/inactive and cannot be assigned/);
  });

  it('accepts a refActive reference while the target is still active', async () => {
    const { city, territory } = await seedGeography();
    const center = await seedServiceCenter(city._id, territory._id);

    const technician = await User.create({
      role: 'TECHNICIAN',
      name: 'Ravi Kumar',
      mobile: '9812345678',
      passwordHash: 'placeholder-hash',
      serviceCenterId: center._id,
    });

    expect(technician.serviceCenterId?.equals(center._id)).toBe(true);
  });

  it('checks references on query-based updates, not only on save', async () => {
    const { territory, city } = await seedGeography();
    expect(city.territoryId.equals(territory._id)).toBe(true);

    /* findOneAndUpdate bypasses document validation entirely, so this path
       needs its own hook — the easiest place for an orphan to sneak in. */
    await expect(
      City.findOneAndUpdate(
        { _id: city._id },
        { $set: { territoryId: new mongoose.Types.ObjectId() } },
      ).exec(),
    ).rejects.toThrow(/Territory not found/);
  });

  it('sees documents created earlier in the same transaction', async () => {
    /* The subtle failure mode: if the existence check queries outside the
       caller's session it cannot see uncommitted writes, so a perfectly valid
       create would be rejected. This is what session propagation buys. */
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        const [territory] = await Territory.create(
          [{ name: 'West', code: 'WEST' }],
          { session },
        );
        expect(territory).toBeDefined();

        const [city] = await City.create(
          [{ name: 'Ahmedabad', state: 'Gujarat', territoryId: territory!._id }],
          { session },
        );

        expect(city!.territoryId.equals(territory!._id)).toBe(true);
      });
    } finally {
      await session.endSession();
    }

    /* And it actually committed. */
    expect(await City.countDocuments({ name: 'Ahmedabad' })).toBe(1);
  });

  it('rolls back the whole transaction when a reference is invalid', async () => {
    const session = await mongoose.startSession();
    const orphanId = new mongoose.Types.ObjectId();

    await expect(
      session.withTransaction(async () => {
        await Territory.create([{ name: 'South', code: 'SOUTH' }], { session });
        /* This must fail, taking the territory above with it. */
        await City.create(
          [{ name: 'Kochi', state: 'Kerala', territoryId: orphanId }],
          { session },
        );
      }),
    ).rejects.toThrow(/Territory not found/);

    await session.endSession();

    expect(await Territory.countDocuments({ code: 'SOUTH' })).toBe(0);
    expect(await City.countDocuments({ name: 'Kochi' })).toBe(0);
  });

  it('reports the offending field so a form can highlight it', async () => {
    const orphanId = new mongoose.Types.ObjectId();

    try {
      await City.create({ name: 'Nowhere', state: 'Nowhere', territoryId: orphanId });
      expect.unreachable('create should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(mongoose.Error.ValidationError);
      const validation = err as mongoose.Error.ValidationError;
      expect(Object.keys(validation.errors)).toContain('territoryId');
    }
  });
});

describe('model invariants', () => {
  it('refuses an Admin attached to a service center', async () => {
    const { city, territory } = await seedGeography();
    const center = await seedServiceCenter(city._id, territory._id);

    await expect(
      User.create({
        role: 'ADMIN',
        name: 'Global Admin',
        mobile: '9800000001',
        passwordHash: 'placeholder-hash',
        serviceCenterId: center._id,
      }),
    ).rejects.toThrow(/Admin is global/);
  });

  it('refuses a technician with no service center', async () => {
    await expect(
      User.create({
        role: 'TECHNICIAN',
        name: 'Unscoped Tech',
        mobile: '9800000002',
        passwordHash: 'placeholder-hash',
      }),
    ).rejects.toThrow(/must belong to a service center/);
  });

  it('enforces one account per mobile number across roles', async () => {
    const { city, territory } = await seedGeography();
    const center = await seedServiceCenter(city._id, territory._id);

    await User.create({
      role: 'ADMIN',
      name: 'Admin One',
      mobile: '9800000003',
      passwordHash: 'placeholder-hash',
    });

    /* Mobile is the login identifier, so a collision across roles would make
       authentication ambiguous. */
    await expect(
      User.create({
        role: 'TECHNICIAN',
        name: 'Tech Two',
        mobile: '9800000003',
        passwordHash: 'placeholder-hash',
        serviceCenterId: center._id,
      }),
    ).rejects.toThrow();
  });

  it('normalizes a mobile number before storing it', async () => {
    const { city } = await seedGeography();

    /* Section 13's repeat-complaint lookup depends on this: a customer typed
       as '+91 98765-43210' must be the same record as '9876543210'. */
    const customer = await Customer.create({
      name: 'Anita Sharma',
      mobile: '+91 98765-43210',
      address: '4 Lake View',
      cityId: city._id,
      state: 'Rajasthan',
      pincode: '302001',
    });

    expect(customer.mobile).toBe('9876543210');
  });

  it('never returns passwordHash unless explicitly selected', async () => {
    await User.create({
      role: 'ADMIN',
      name: 'Admin One',
      mobile: '9800000004',
      passwordHash: 'placeholder-hash',
    });

    const found = await User.findOne({ mobile: '9800000004' }).lean().exec();
    expect(found).not.toBeNull();
    expect(found).not.toHaveProperty('passwordHash');

    const withHash = await User.findOne({ mobile: '9800000004' })
      .select('+passwordHash')
      .lean()
      .exec();
    expect(withHash?.passwordHash).toBe('placeholder-hash');
  });

  it('rejects an unknown field rather than storing it', async () => {
    const { territory } = await seedGeography();

    /* strict: 'throw'. MongoDB would accept a typo'd key forever; a schema
       nobody enforces is a schema in name only. */
    await expect(
      City.create({
        name: 'Typo City',
        state: 'Rajasthan',
        territoryId: territory._id,
        teritoryId: territory._id,
      } as never),
    ).rejects.toThrow();
  });
});
