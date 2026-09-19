/**
 * Test fixtures.
 *
 * Passwords are hashed with the real `hashPassword`, not a stub. scrypt at
 * N=2^15 costs about 60ms a call, which is the point — a stub would let a
 * broken verify path pass its tests.
 */
import mongoose from 'mongoose';
import { hashPassword } from '../src/core/password.js';
import {
  City,
  Customer,
  Part,
  Product,
  ProductModel,
  ServiceCenter,
  SlaRule,
  Territory,
  User,
  DEFAULT_SLA_RULES,
  type CityDoc,
  type ServiceCenterDoc,
  type TerritoryDoc,
  type UserDoc,
} from '../src/models/index.js';

export const TEST_PASSWORD = 'correct-horse-battery';

export async function makeTerritory(code = 'NORTH'): Promise<TerritoryDoc> {
  return Territory.create({ name: `Territory ${code}`, code });
}

export async function makeCity(
  territoryId: mongoose.Types.ObjectId,
  name = 'Jaipur',
): Promise<CityDoc> {
  return City.create({ name, state: 'Rajasthan', territoryId });
}

export async function makeServiceCenter(
  cityId: mongoose.Types.ObjectId,
  territoryId: mongoose.Types.ObjectId,
  code = 'JAI-01',
): Promise<ServiceCenterDoc> {
  return ServiceCenter.create({
    name: `Service Center ${code}`,
    code,
    mobile: '9876500000',
    address: '12 Station Road',
    cityId,
    pincode: '302001',
    territoryId,
    servedCityIds: [cityId],
    servedPincodes: ['302001'],
  });
}

interface MakeUserOptions {
  role: UserDoc['role'];
  mobile: string;
  name?: string;
  serviceCenterId?: mongoose.Types.ObjectId;
  password?: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}

export async function makeUser(options: MakeUserOptions): Promise<UserDoc> {
  return User.create({
    role: options.role,
    name: options.name ?? `${options.role} user`,
    mobile: options.mobile,
    passwordHash: await hashPassword(options.password ?? TEST_PASSWORD),
    ...(options.serviceCenterId ? { serviceCenterId: options.serviceCenterId } : {}),
    isActive: options.isActive ?? true,
    mustChangePassword: options.mustChangePassword ?? false,
  });
}

/**
 * A complete, consistent world: geography, a centre, one user per role, a
 * product with a model, a customer, and the section 14 SLA defaults.
 */
export async function seedWorld() {
  const territory = await makeTerritory();
  const city = await makeCity(territory._id);
  const center = await makeServiceCenter(city._id, territory._id);

  const admin = await makeUser({ role: 'ADMIN', mobile: '9800000001', name: 'Admin' });
  const owner = await makeUser({
    role: 'SERVICE_CENTER_OWNER',
    mobile: '9800000002',
    name: 'Owner',
    serviceCenterId: center._id,
  });
  const technician = await makeUser({
    role: 'TECHNICIAN',
    mobile: '9800000003',
    name: 'Technician',
    serviceCenterId: center._id,
  });

  const product = await Product.create({ name: 'Desert Cooler 50L', code: 'DC50' });
  const productModel = await ProductModel.create({
    productId: product._id,
    modelNumber: 'DC50-X',
  });

  const customer = await Customer.create({
    name: 'Anita Sharma',
    mobile: '9811111111',
    address: '4 Lake View',
    cityId: city._id,
    state: 'Rajasthan',
    pincode: '302001',
  });

  await SlaRule.insertMany(DEFAULT_SLA_RULES.map((rule) => ({ ...rule })));

  /**
   * Part master records, matching the codes the demo seed uses.
   *
   * No stock rows: tests set their own levels so each one states the
   * quantities its assertions depend on, rather than inheriting a number from
   * here that a later edit could quietly change.
   */
  const parts = await Part.insertMany([
    { name: 'Cooling Pad', code: 'PAD-01', unit: 'PIECE' },
    { name: 'Water Pump', code: 'PUMP-01', unit: 'PIECE' },
    { name: 'Fan Motor', code: 'MOTOR-01', unit: 'PIECE' },
  ]);

  return {
    territory,
    city,
    center,
    admin,
    owner,
    technician,
    product,
    productModel,
    customer,
    parts,
  };
}
