/**
 * Seeds the minimum data needed to use the system.
 *
 * Two things are always created:
 *
 *  - the four SLA rules from spec section 14. These are *data*, not constants
 *    (section 14: "SLA should be configurable, not hard-coded"), so without
 *    them a complaint has no window to compute its due dates from.
 *  - a first Admin, because section 3 gives Admin the only route into the
 *    system and nothing else can create one.
 *
 * `--demo` additionally builds a small working world — territory, city,
 * service center, an owner, a technician, products and a customer — so the
 * complaint flow can be exercised without hand-entering master data.
 *
 * Idempotent: existing records are left alone rather than overwritten, so
 * re-running it is safe and never clobbers a password someone is using.
 *
 *   npm run seed --workspace server
 *   npm run seed --workspace server -- --demo
 *   npm run seed --workspace server -- --admin-mobile 9812345678
 *
 * An Admin password can be supplied with `--admin-password` or
 * SEED_ADMIN_PASSWORD. It must meet the same rules as any password set in the
 * app, and the Admin must replace it at first sign-in: a password typed on a
 * command line or kept in an environment file has been seen by shell history,
 * CI logs or whoever else can read that file, so it is only good for getting
 * in once.
 */
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { config, redactCredentials } from '../config/env.js';
import { hashPassword } from '../core/password.js';
import { newPasswordSchema } from '../modules/auth/auth.validation.js';
import { findOrCreateCity } from '../modules/masters/geography.resolve.js';
import {
  Customer,
  DEFAULT_SLA_RULES,
  Part,
  PartStock,
  Product,
  ProductModel,
  ServiceCenter,
  SlaRule,
  User,
} from '../models/index.js';

/** Minimal argv parsing: `--flag` and `--key value`. */
function parseArgs(argv: string[]): Map<string, string | true> {
  const args = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[i + 1];

    if (next && !next.startsWith('--')) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }

  return args;
}

/**
 * A readable but high-entropy password.
 *
 * base64url over 18 bytes is ~144 bits, comfortably above the 12-character
 * policy floor, and safe to paste without shell-quoting surprises.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

const args = parseArgs(process.argv.slice(2));
const withDemo = args.has('demo');

/**
 * The Admin password the operator supplied, checked against the app's own
 * password rules — or null when none was given and one should be generated.
 *
 * Checked before anything connects or writes, so a rejected password leaves
 * nothing half-seeded. An empty SEED_ADMIN_PASSWORD counts as not given: an
 * `.env` line left blank means "unset", and it used to create an Admin whose
 * password was the empty string.
 */
function suppliedAdminPassword(): string | null {
  const fromArgs = args.get('admin-password');
  if (fromArgs === true) {
    throw new Error('--admin-password needs a value, e.g. --admin-password "a long passphrase"');
  }

  const supplied = fromArgs ?? process.env['SEED_ADMIN_PASSWORD'];
  if (supplied === undefined || supplied === '') return null;

  const checked = newPasswordSchema.safeParse(supplied);
  if (!checked.success) {
    const reason = checked.error.issues[0]?.message ?? 'Password is not allowed';
    throw new Error(`the supplied Admin password was refused: ${reason}`);
  }

  return checked.data;
}

/* ---- SLA rules --------------------------------------------------------- */

async function seedSlaRules(): Promise<void> {
  for (const rule of DEFAULT_SLA_RULES) {
    const existing = await SlaRule.findOne({ priority: rule.priority }).exec();
    if (existing) {
      console.log(`  SLA ${rule.priority.padEnd(8)} already present, left as is`);
      continue;
    }

    await SlaRule.create({ ...rule });
    console.log(
      `  SLA ${rule.priority.padEnd(8)} response ${rule.responseMinutes / 60}h,` +
      ` resolution ${rule.resolutionMinutes / 60}h`,
    );
  }
}

/* ---- First admin ------------------------------------------------------- */

interface Credential {
  mobile: string;
  /** Null when the operator supplied it: they have it, so it is not echoed. */
  password: string | null;
}

async function seedAdmin(supplied: string | null): Promise<Credential | null> {
  const mobile = String(args.get('admin-mobile') ?? process.env['SEED_ADMIN_MOBILE'] ?? '9800000001');

  const existing = await User.findOne({ role: 'ADMIN' }).lean().exec();
  if (existing) {
    console.log(`  Admin already exists (${existing.mobile}), left as is`);
    return null;
  }

  const password = supplied ?? generatePassword();

  await User.create({
    role: 'ADMIN',
    name: 'System Administrator',
    mobile,
    passwordHash: await hashPassword(password),
    /* A supplied password has passed through places a password should not
       stay, so it only gets the Admin in once (see the header). A generated
       one is shown once, below, and never stored anywhere readable. */
    mustChangePassword: supplied !== null,
  });

  console.log(`  Admin created: ${mobile}`);
  return { mobile, password: supplied === null ? password : null };
}

/* ---- Demo world -------------------------------------------------------- */

async function seedDemo(): Promise<Credential[]> {
  const credentials: Credential[] = [];

  /* The same find-or-create every write path uses, so the demo world cannot
     end up with a city the app would not match against (section 32). */
  const city = await findOrCreateCity('Jaipur', 'Rajasthan', {
    cityIdField: 'cityId',
    cityNameField: 'cityName',
    stateField: 'state',
  });

  const center =
    (await ServiceCenter.findOne({ code: 'JAI-01' }).exec()) ??
    (await ServiceCenter.create({
      name: 'Jaipur Central Service',
      code: 'JAI-01',
      mobile: '9876500000',
      address: '12 Station Road, Jaipur',
      cityId: city._id,
      pincode: '302001',
      territoryId: city.territoryId,
      servedCityIds: [city._id],
      servedPincodes: ['302001', '302002'],
    }));

  console.log(`  City / Service Center ready (${center.code})`);

  /* Owner and technician for that center. */
  for (const spec of [
    { role: 'SERVICE_CENTER_OWNER' as const, mobile: '9800000002', name: 'Center Owner' },
    { role: 'TECHNICIAN' as const, mobile: '9800000003', name: 'Field Technician' },
  ]) {
    const existing = await User.findOne({ mobile: spec.mobile }).lean().exec();
    if (existing) {
      console.log(`  ${spec.role} already exists (${spec.mobile}), left as is`);
      continue;
    }

    const password = generatePassword();
    await User.create({
      role: spec.role,
      name: spec.name,
      mobile: spec.mobile,
      passwordHash: await hashPassword(password),
      serviceCenterId: center._id,
      /* Demo accounts are ready to use. A real technician created by an Owner
         gets mustChangePassword: true (DECISIONS.md section 4.5). */
      mustChangePassword: false,
    });

    console.log(`  ${spec.role} created: ${spec.mobile}`);
    credentials.push({ mobile: spec.mobile, password });
  }

  /* Catalog. */
  const product =
    (await Product.findOne({ code: 'DC50' }).exec()) ??
    (await Product.create({
      name: 'Desert Cooler 50L',
      code: 'DC50',
      category: 'Desert Cooler',
      defaultWarrantyMonths: 12,
    }));

  for (const modelNumber of ['DC50-X', 'DC50-PRO']) {
    const existing = await ProductModel.findOne({
      productId: product._id,
      modelNumber,
    }).exec();
    if (!existing) {
      await ProductModel.create({ productId: product._id, modelNumber });
    }
  }
  console.log('  Product and models ready (DC50: DC50-X, DC50-PRO)');

  /* Parts, with stock at the demo center. */
  for (const spec of [
    { name: 'Cooling Pad', code: 'PAD-01', unit: 'PIECE' as const, qty: 24, min: 6 },
    { name: 'Water Pump', code: 'PUMP-01', unit: 'PIECE' as const, qty: 8, min: 3 },
    { name: 'Fan Motor', code: 'MOTOR-01', unit: 'PIECE' as const, qty: 2, min: 4 },
  ]) {
    const part =
      (await Part.findOne({ code: spec.code }).exec()) ??
      (await Part.create({ name: spec.name, code: spec.code, unit: spec.unit }));

    const stock = await PartStock.findOne({
      serviceCenterId: center._id,
      partId: part._id,
    }).exec();

    if (!stock) {
      await PartStock.create({
        serviceCenterId: center._id,
        partId: part._id,
        availableQuantity: spec.qty,
        minimumStock: spec.min,
      });
    }
  }
  /* MOTOR-01 is seeded below its minimum on purpose, so the low-stock report
     (section 16) has something to show. */
  console.log('  Parts and stock ready (MOTOR-01 is deliberately below minimum)');

  const customer = await Customer.findOne({ mobile: '9811111111' }).exec();
  if (!customer) {
    await Customer.create({
      name: 'Anita Sharma',
      mobile: '9811111111',
      address: '4 Lake View Colony',
      cityId: city._id,
      state: 'Rajasthan',
      pincode: '302001',
    });
  }
  console.log('  Customer ready (Anita Sharma, 9811111111)');

  return credentials;
}

/* ---- Run --------------------------------------------------------------- */

async function main(): Promise<void> {
  const adminPassword = suppliedAdminPassword();

  /* Which database is about to be written to is worth printing; its password
     is not. */
  console.log(`Connecting to ${redactCredentials(config.MONGO_URI)}\n`);
  await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 10_000 });

  /* Build indexes before inserting, so unique constraints actually apply. */
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.syncIndexes()),
  );

  console.log('SLA rules (spec section 14):');
  await seedSlaRules();

  console.log('\nAdmin:');
  const adminCredential = await seedAdmin(adminPassword);

  let demoCredentials: Credential[] = [];
  if (withDemo) {
    console.log('\nDemo data:');
    demoCredentials = await seedDemo();
  }

  const created = [
    ...(adminCredential ? [{ role: 'ADMIN', ...adminCredential }] : []),
    ...demoCredentials.map((c) => ({ role: 'USER', ...c })),
  ];

  if (created.length > 0) {
    console.log(`\n${'='.repeat(62)}`);
    console.log('CREDENTIALS - shown once, not recoverable afterwards');
    console.log('='.repeat(62));
    for (const credential of created) {
      console.log(
        `  ${credential.mobile}   ${
          credential.password ?? '(the password you supplied - must be changed at first sign-in)'
        }`,
      );
    }
    console.log('='.repeat(62));
    console.log('Passwords are stored as scrypt hashes and cannot be read back.');
    console.log('Save these now, or re-seed into an empty database to reissue.');
  } else {
    console.log('\nNothing new to create - everything was already present.');
  }

  if (!withDemo) {
    console.log('\nTip: re-run with --demo for a full working dataset.');
  }

  await mongoose.connection.close();
}

main().catch(async (err: unknown) => {
  /* Driver errors can quote the connection string; mask it here too. */
  console.error('\nseed failed:', redactCredentials(err instanceof Error ? err.message : String(err)));
  await mongoose.connection.close().catch(() => undefined);
  process.exit(1);
});
