/**
 * Master data: territories, cities, service centers, products, models and
 * customers (spec section 25 Phase 2).
 *
 * All of it is Admin-maintained reference data, and none of it is ever
 * deleted — rule 17 allows only active/inactive. Two deactivations carry extra
 * weight and are handled specially:
 *
 *  - **Service center** (section 8): history is untouched, but open complaints
 *    must be reassigned by Admin.
 *  - **Technician** (section 9, in `users.service.ts`): the same, for jobs.
 *
 * Both report what they have just stranded rather than leaving someone to
 * discover it later.
 */
import type { FilterQuery, Model } from 'mongoose';
import { recordAudit, type Actor } from '../../core/audit.js';
import { complaintScope, withScope } from '../../core/scope.js';
import { mobilePattern, searchPattern } from '../../core/search.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import {
  City,
  Complaint,
  Customer,
  Product,
  ProductModel,
  ServiceCenter,
  Territory,
  type CityDoc,
  type ComplaintDoc,
  type CustomerDoc,
  type ProductDoc,
  type ProductModelDoc,
  type ServiceCenterDoc,
  type TerritoryDoc,
} from '../../models/index.js';
import { TERMINAL_STATUSES } from '../../models/enums.js';
import { findOrCreateCity, resolveCity, resolveState } from './geography.resolve.js';
import type {
  CreateCityInput,
  CreateCustomerInput,
  CreateProductInput,
  CreateProductModelInput,
  CreateServiceCenterInput,
  CreateTerritoryInput,
  ListCitiesInput,
  ListCustomersInput,
  ListProductModelsInput,
  ListQueryInput,
  ListServiceCentersInput,
  UpdateCityInput,
  UpdateCustomerInput,
  UpdateProductInput,
  UpdateProductModelInput,
  UpdateServiceCenterInput,
  UpdateTerritoryInput,
} from './masters.validation.js';

function actorFor(auth: AuthContext): Actor {
  return { userId: auth.userId, role: auth.role, name: auth.name };
}

export interface Paged<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Runs a paged, sorted query. Shared by every list below. */
async function paged<T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  input: { page: number; limit: number },
  sort: Record<string, 1 | -1>,
): Promise<Paged<T>> {
  const [items, total] = await Promise.all([
    model
      .find(filter)
      .sort(sort)
      .skip((input.page - 1) * input.limit)
      .limit(input.limit)
      .lean<T[]>()
      .exec(),
    model.countDocuments(filter).exec(),
  ]);

  return {
    items,
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/**
 * Applies changed fields to a document and records them for the audit log.
 *
 * Returns the change list so the caller can skip the write entirely when
 * nothing actually differs — a no-op PATCH should not produce an audit entry
 * claiming something was edited.
 */
function applyChanges<T extends Record<string, unknown>>(
  doc: T,
  input: Record<string, unknown>,
  fields: readonly string[],
): Array<{ field: string; oldValue?: string; newValue?: string }> {
  const changes: Array<{ field: string; oldValue?: string; newValue?: string }> = [];

  for (const field of fields) {
    const value = input[field];
    if (value === undefined) continue;

    const before = doc[field];
    const beforeText = Array.isArray(before) ? before.map(String).join(',') : String(before);
    const afterText = Array.isArray(value) ? value.map(String).join(',') : String(value);
    if (beforeText === afterText) continue;

    changes.push({ field, oldValue: beforeText, newValue: afterText });
    (doc as Record<string, unknown>)[field] = value;
  }

  return changes;
}

async function auditEdit(
  entityType: string,
  entityId: string,
  changes: Array<{ field: string; oldValue?: string; newValue?: string }>,
  auth: AuthContext,
  deactivated: boolean,
): Promise<void> {
  /* `ServiceCenter` -> `SERVICE_CENTER`, matching `SERVICE_CENTER_CREATED`.
     A plain upper-case gave `SERVICECENTER_UPDATED`, so filtering the audit
     log by action found a centre's creation but none of its edits. */
  const noun = entityType.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();

  await recordAudit({
    entityType,
    entityId,
    action: deactivated ? `${noun}_DEACTIVATED` : `${noun}_UPDATED`,
    actor: actorFor(auth),
    changes,
  });
}

/* ---- Territory --------------------------------------------------------- */

export async function createTerritory(
  input: CreateTerritoryInput,
  auth: AuthContext,
): Promise<TerritoryDoc> {
  if (await Territory.findOne({ code: input.code }).lean().exec()) {
    throw conflict(`A territory with code ${input.code} already exists`);
  }

  const territory = await Territory.create(input);
  await recordAudit({
    entityType: 'Territory',
    entityId: String(territory._id),
    action: 'TERRITORY_CREATED',
    actor: actorFor(auth),
    note: `${input.name} (${input.code})`,
  });

  return territory;
}

export async function listTerritories(input: ListQueryInput): Promise<Paged<TerritoryDoc>> {
  const filter: FilterQuery<TerritoryDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.search) {
    filter.$or = [{ name: searchPattern(input.search) }, { code: searchPattern(input.search) }];
  }
  return paged(Territory, filter, input, { name: 1 });
}

export async function updateTerritory(
  id: string,
  input: UpdateTerritoryInput,
  auth: AuthContext,
): Promise<TerritoryDoc> {
  const territory = await Territory.findById(id).exec();
  if (!territory) throw notFound('Territory not found');

  const changes = applyChanges(territory as never, input, ['name', 'notes', 'isActive']);
  if (changes.length === 0) return territory;

  await territory.save();
  await auditEdit('Territory', id, changes, auth, input.isActive === false);
  return territory;
}

/* ---- City -------------------------------------------------------------- */

export async function createCity(
  input: CreateCityInput,
  auth: AuthContext,
): Promise<CityDoc> {
  /* Stored as the official spelling, same as every other place a state is
     recorded (DECISIONS.md section 32) — this screen is a thin layer over the
     same find-or-create every other write uses, so it cannot produce a city
     the rest of the app would then fail to match against. */
  const state = resolveState(input.state, 'state');

  /* Two cities of the same name in different states are different places, so
     uniqueness is on the pair. */
  const duplicate = await City.findOne({ name: input.name, state })
    .collation({ locale: 'en', strength: 2 })
    .lean()
    .exec();
  if (duplicate) {
    throw conflict(`${input.name}, ${state} already exists`);
  }

  const city = await City.create({ ...input, state });
  await recordAudit({
    entityType: 'City',
    entityId: String(city._id),
    action: 'CITY_CREATED',
    actor: actorFor(auth),
    note: `${input.name}, ${state}`,
  });

  return city;
}

export async function listCities(input: ListCitiesInput): Promise<Paged<CityDoc>> {
  const filter: FilterQuery<CityDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.territoryId) filter.territoryId = input.territoryId;
  if (input.state) filter.state = input.state;
  if (input.search) filter.name = searchPattern(input.search);
  return paged(City, filter, input, { state: 1, name: 1 });
}

export async function updateCity(
  id: string,
  input: UpdateCityInput,
  auth: AuthContext,
): Promise<CityDoc> {
  const city = await City.findById(id).exec();
  if (!city) throw notFound('City not found');

  const resolved = input.state !== undefined
    ? { ...input, state: resolveState(input.state, 'state') }
    : input;

  const changes = applyChanges(city as never, resolved, [
    'name',
    'state',
    'territoryId',
    'isActive',
  ]);
  if (changes.length === 0) return city;

  await city.save();
  await auditEdit('City', id, changes, auth, input.isActive === false);
  return city;
}

/* ---- Service center ---------------------------------------------------- */

/**
 * A coverage list from both forms a request may send: ids of cities that
 * already exist, and typed name+state pairs resolved (find-or-create) the
 * same way the centre's own city is. The result is the deduplicated union —
 * the *whole* coverage list this write intends, not an addition to what was
 * there before, matching how `servedCityIds` alone always worked.
 */
async function resolveCoverageCityIds(
  servedCityIds: string[] | undefined,
  servedCities: Array<{ name: string; state: string }> | undefined,
): Promise<string[]> {
  const ids = new Set((servedCityIds ?? []).map(String));

  for (const entry of servedCities ?? []) {
    const city = await findOrCreateCity(entry.name, entry.state, {
      cityIdField: 'servedCityIds',
      cityNameField: 'servedCities.name',
      stateField: 'servedCities.state',
    });
    ids.add(String(city._id));
  }

  return [...ids];
}

export async function createServiceCenter(
  input: CreateServiceCenterInput,
  auth: AuthContext,
): Promise<ServiceCenterDoc> {
  if (await ServiceCenter.findOne({ code: input.code }).lean().exec()) {
    throw conflict(`A service center with code ${input.code} already exists`);
  }

  const city = await resolveCity(
    { cityId: input.cityId, cityName: input.cityName, state: input.state },
    { cityIdField: 'cityId', cityNameField: 'cityName', stateField: 'state' },
  );
  const servedCityIds = await resolveCoverageCityIds(input.servedCityIds, input.servedCities);

  const centre = await ServiceCenter.create({
    name: input.name,
    code: input.code,
    mobile: input.mobile,
    ...(input.email ? { email: input.email } : {}),
    address: input.address,
    cityId: city._id,
    pincode: input.pincode,
    /* Always the resolved city's own territory — one territory per state
       means there is no independent choice to make here (masters.validation
       no longer even accepts a `territoryId` from the client). */
    territoryId: city.territoryId,
    servedCityIds,
    servedPincodes: input.servedPincodes,
    ...(input.location ? { location: input.location } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    createdBy: auth.userId,
  });
  await recordAudit({
    entityType: 'ServiceCenter',
    entityId: String(centre._id),
    action: 'SERVICE_CENTER_CREATED',
    actor: actorFor(auth),
    note: `${input.name} (${input.code})`,
  });

  return centre;
}

export async function listServiceCenters(
  input: ListServiceCentersInput,
): Promise<Paged<ServiceCenterDoc>> {
  const filter: FilterQuery<ServiceCenterDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.cityId) {
    /* Either located there or covering it — both are relevant when an Admin
       is looking for "centres for this city". */
    filter.$or = [{ cityId: input.cityId }, { servedCityIds: input.cityId }];
  }
  if (input.territoryId) filter.territoryId = input.territoryId;
  if (input.pincode) {
    filter.$or = [...(filter.$or ?? []), { pincode: input.pincode }, { servedPincodes: input.pincode }];
  }
  if (input.search) {
    filter.$and = [
      { $or: [{ name: searchPattern(input.search) }, { code: searchPattern(input.search) }] },
    ];
  }

  return paged(ServiceCenter, filter, input, { name: 1 });
}

export interface ServiceCenterUpdate {
  center: ServiceCenterDoc;
  /**
   * Set when deactivation has just stranded live work.
   *
   * Section 8: "If a service center is later deactivated: Existing complaint
   * history remains unchanged. Open complaints must be reassigned by Admin."
   */
  openComplaintsNeedingReassignment?: Array<{
    complaintId: string;
    complaintNumber: string;
    status: string;
  }>;
}

export async function updateServiceCenter(
  id: string,
  input: UpdateServiceCenterInput,
  auth: AuthContext,
): Promise<ServiceCenterUpdate> {
  const centre = await ServiceCenter.findById(id).exec();
  if (!centre) throw notFound('Service center not found');

  const resolved: Record<string, unknown> = { ...input };

  if (input.cityId || input.cityName) {
    /* A typed name with no state falls back to the centre's current city's
       state — changing only the name of an otherwise-unmoved centre should
       not force re-typing the state too. */
    let state = input.state;
    if (input.cityName && !state) {
      state = (await City.findById(centre.cityId).lean().exec())?.state;
    }

    const city = await resolveCity(
      { cityId: input.cityId, cityName: input.cityName, state },
      { cityIdField: 'cityId', cityNameField: 'cityName', stateField: 'state' },
    );
    resolved['cityId'] = String(city._id);
    /* Follows the city, same as at creation. */
    resolved['territoryId'] = String(city.territoryId);
  }

  if (input.servedCityIds || input.servedCities) {
    resolved['servedCityIds'] = await resolveCoverageCityIds(
      input.servedCityIds,
      input.servedCities,
    );
  }

  const wasActive = centre.isActive;
  const changes = applyChanges(centre as never, resolved, [
    'name',
    'mobile',
    'email',
    'address',
    'cityId',
    'pincode',
    'territoryId',
    'servedCityIds',
    'servedPincodes',
    'location',
    'notes',
    'isActive',
  ]);

  if (changes.length === 0) return { center: centre };

  await centre.save();
  await auditEdit('ServiceCenter', id, changes, auth, input.isActive === false);

  if (wasActive && centre.isActive === false) {
    const open = await Complaint.find({
      serviceCenterId: centre._id,
      status: { $nin: TERMINAL_STATUSES },
    })
      .select('complaintNumber status')
      .lean()
      .exec();

    if (open.length > 0) {
      return {
        center: centre,
        openComplaintsNeedingReassignment: open.map((c) => ({
          complaintId: String(c._id),
          complaintNumber: c.complaintNumber,
          status: c.status,
        })),
      };
    }
  }

  return { center: centre };
}

/* ---- Product and model ------------------------------------------------- */

export async function createProduct(
  input: CreateProductInput,
  auth: AuthContext,
): Promise<ProductDoc> {
  if (await Product.findOne({ code: input.code }).lean().exec()) {
    throw conflict(`A product with code ${input.code} already exists`);
  }

  const product = await Product.create(input);
  await recordAudit({
    entityType: 'Product',
    entityId: String(product._id),
    action: 'PRODUCT_CREATED',
    actor: actorFor(auth),
    note: `${input.name} (${input.code})`,
  });

  return product;
}

export async function listProducts(input: ListQueryInput): Promise<Paged<ProductDoc>> {
  const filter: FilterQuery<ProductDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.search) {
    filter.$or = [{ name: searchPattern(input.search) }, { code: searchPattern(input.search) }];
  }
  return paged(Product, filter, input, { name: 1 });
}

export async function updateProduct(
  id: string,
  input: UpdateProductInput,
  auth: AuthContext,
): Promise<ProductDoc> {
  const product = await Product.findById(id).exec();
  if (!product) throw notFound('Product not found');

  const changes = applyChanges(product as never, input, [
    'name',
    'category',
    'defaultWarrantyMonths',
    'notes',
    'isActive',
  ]);
  if (changes.length === 0) return product;

  await product.save();
  await auditEdit('Product', id, changes, auth, input.isActive === false);
  return product;
}

export async function createProductModel(
  input: CreateProductModelInput,
  auth: AuthContext,
): Promise<ProductModelDoc> {
  const product = await Product.findById(input.productId).lean().exec();
  if (!product) throw notFound('Product not found');

  /* Model numbers are unique within a product line, not globally — two lines
     may legitimately reuse one. */
  const duplicate = await ProductModel.findOne({
    productId: input.productId,
    modelNumber: input.modelNumber,
  })
    .lean()
    .exec();

  if (duplicate) {
    throw conflict(`${product.name} already has model ${input.modelNumber}`);
  }

  const model = await ProductModel.create(input);
  await recordAudit({
    entityType: 'ProductModel',
    entityId: String(model._id),
    action: 'PRODUCT_MODEL_CREATED',
    actor: actorFor(auth),
    note: `${product.name} / ${input.modelNumber}`,
  });

  return model;
}

export async function listProductModels(
  input: ListProductModelsInput,
): Promise<Paged<ProductModelDoc>> {
  const filter: FilterQuery<ProductModelDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.productId) filter.productId = input.productId;
  if (input.search) filter.modelNumber = searchPattern(input.search);
  return paged(ProductModel, filter, input, { modelNumber: 1 });
}

export async function updateProductModel(
  id: string,
  input: UpdateProductModelInput,
  auth: AuthContext,
): Promise<ProductModelDoc> {
  const model = await ProductModel.findById(id).exec();
  if (!model) throw notFound('Model not found');

  const changes = applyChanges(model as never, input, [
    'name',
    'defaultWarrantyMonths',
    'isActive',
  ]);
  if (changes.length === 0) return model;

  await model.save();
  await auditEdit('ProductModel', id, changes, auth, input.isActive === false);
  return model;
}

/* ---- Customer ---------------------------------------------------------- */

export async function createCustomer(
  input: CreateCustomerInput,
  auth: AuthContext,
): Promise<CustomerDoc> {
  const existing = await Customer.findOne({ mobile: input.mobile }).lean().exec();
  if (existing) {
    /* Section 13's history is keyed on the mobile number, so a second record
       would split one person's service history in two. The existing id is
       returned in the message so the caller can go straight to it. */
    throw conflict(
      `${existing.name} is already registered with that mobile number`,
      { existingCustomerId: String(existing._id) },
    );
  }

  /* The same canonical state ends up on the customer record and on the city
     it points at, so the two can never disagree about which state this
     address is in (DECISIONS.md section 32). */
  const state = resolveState(input.state, 'state');
  const city = await resolveCity(
    { cityId: input.cityId, cityName: input.cityName, state },
    { cityIdField: 'cityId', cityNameField: 'cityName', stateField: 'state' },
  );

  const customer = await Customer.create({
    name: input.name,
    mobile: input.mobile,
    ...(input.alternateMobile ? { alternateMobile: input.alternateMobile } : {}),
    ...(input.email ? { email: input.email } : {}),
    address: input.address,
    cityId: city._id,
    state,
    pincode: input.pincode,
    ...(input.notes ? { notes: input.notes } : {}),
    createdBy: auth.userId,
  });
  await recordAudit({
    entityType: 'Customer',
    entityId: String(customer._id),
    action: 'CUSTOMER_CREATED',
    actor: actorFor(auth),
    note: `${input.name} (${input.mobile})`,
  });

  return customer;
}

export async function listCustomers(
  input: ListCustomersInput,
): Promise<Paged<CustomerDoc>> {
  const filter: FilterQuery<CustomerDoc> = {};
  if (!input.includeInactive) filter.isActive = true;
  if (input.cityId) filter.cityId = input.cityId;
  if (input.search) {
    /* Name or mobile: the two things an Admin has when someone calls in.
       The mobile is matched on its digits, so "98765 43210" and
       "+91 98765 43210" find it the way the screens show it. */
    filter.$or = [
      { name: searchPattern(input.search) },
      { mobile: mobilePattern(input.search) },
    ];
  }
  return paged(Customer, filter, input, { name: 1 });
}

export async function getCustomer(id: string): Promise<CustomerDoc> {
  const customer = await Customer.findById(id).lean<CustomerDoc>().exec();
  if (!customer) throw notFound('Customer not found');
  return customer;
}

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  auth: AuthContext,
): Promise<CustomerDoc> {
  const customer = await Customer.findById(id).exec();
  if (!customer) throw notFound('Customer not found');

  /**
   * Mobile is rejected at the schema, which is a `strictObject` precisely so
   * an attempt to change it fails loudly instead of being silently stripped.
   * This second check catches an internal caller that bypassed the schema.
   */
  if ('mobile' in input) {
    throw badRequest(
      'A customer mobile number cannot be changed: it identifies their service history',
    );
  }

  const resolved: Record<string, unknown> = { ...input };

  if (input.cityId || input.cityName) {
    /* A typed name with no state falls back to the customer's current
       state — editing only the address line should not force re-typing it. */
    let state = input.state;
    if (input.cityName && !state) state = customer.state;
    else if (state) state = resolveState(state, 'state');

    const city = await resolveCity(
      { cityId: input.cityId, cityName: input.cityName, state },
      { cityIdField: 'cityId', cityNameField: 'cityName', stateField: 'state' },
    );
    resolved['cityId'] = String(city._id);
    resolved['state'] = city.state;
  } else if (input.state) {
    resolved['state'] = resolveState(input.state, 'state');
  }

  const changes = applyChanges(customer as never, resolved, [
    'name',
    'alternateMobile',
    'email',
    'address',
    'cityId',
    'state',
    'pincode',
    'notes',
    'isActive',
  ]);
  if (changes.length === 0) return customer;

  await customer.save();
  await auditEdit('Customer', id, changes, auth, input.isActive === false);
  return customer;
}

/** One of a customer's units, as the Customers screen shows it. */
export interface CustomerProductSummary {
  serialNumber: string;
  productName: string;
  modelNumber: string;
  /** The most recent purchase date recorded against this serial, if any. */
  purchaseDate?: Date;
  /** From `productSnapshot.warrantyMonths`; omitted when no complaint recorded one. */
  warrantyMonths?: number;
  complaints: number;
  lastComplaintAt: Date;
  openComplaints: number;
}

interface ComplaintForProducts {
  serialNumber: string;
  productSnapshot: { productName: string; modelNumber: string; warrantyMonths?: number };
  purchaseDate?: Date;
  createdAt: Date;
  status: ComplaintDoc['status'];
}

/**
 * A customer's units, grouped by serial number from their complaints —
 * deliberately never a stored collection of its own, so there is nothing here
 * that could drift from what was actually raised.
 *
 * `complaints` must already be sorted newest first: that ordering is what
 * lets a single pass pick "the most recent purchase date recorded for that
 * serial" by taking the first one a group encounters, and is also how ties in
 * `lastComplaintAt` resolve to a stable, newest-first product list.
 */
function productsFromComplaints(
  complaints: readonly ComplaintForProducts[],
): CustomerProductSummary[] {
  interface Group {
    serialNumber: string;
    /** The complaint this group's product name, model and purchase date are
       read from — the newest one that actually recorded a purchase date, or
       simply the newest complaint for this serial when none did. */
    primary: ComplaintForProducts;
    complaints: number;
    lastComplaintAt: Date;
    openComplaints: number;
  }

  const bySerial = new Map<string, Group>();

  for (const complaint of complaints) {
    const isOpen = !TERMINAL_STATUSES.includes(complaint.status);
    const existing = bySerial.get(complaint.serialNumber);

    if (!existing) {
      bySerial.set(complaint.serialNumber, {
        serialNumber: complaint.serialNumber,
        primary: complaint,
        complaints: 1,
        lastComplaintAt: complaint.createdAt,
        openComplaints: isOpen ? 1 : 0,
      });
      continue;
    }

    existing.complaints += 1;
    if (isOpen) existing.openComplaints += 1;
    /* Complaints arrive newest first, so the first one seen with a purchase
       date is already the most recently recorded one for this serial. */
    if (!existing.primary.purchaseDate && complaint.purchaseDate) {
      existing.primary = complaint;
    }
  }

  return [...bySerial.values()]
    .sort((a, b) => b.lastComplaintAt.getTime() - a.lastComplaintAt.getTime())
    .map((group) => ({
      serialNumber: group.serialNumber,
      productName: group.primary.productSnapshot.productName,
      modelNumber: group.primary.productSnapshot.modelNumber,
      ...(group.primary.purchaseDate ? { purchaseDate: group.primary.purchaseDate } : {}),
      ...(group.primary.productSnapshot.warrantyMonths !== undefined
        ? { warrantyMonths: group.primary.productSnapshot.warrantyMonths }
        : {}),
      complaints: group.complaints,
      lastComplaintAt: group.lastComplaintAt,
      openComplaints: group.openComplaints,
    }));
}

/**
 * A customer's full service history (section 13, Workflow G steps 1-3).
 *
 * This is what Admin looks at before deciding whether a call is a repeat of an
 * existing complaint or a genuinely new one. The spec is explicit that the
 * decision is human: no automatic duplicate detection in the MVP.
 *
 * Also returns `products` (the client's request): the customer's units, one
 * row per serial number, each showing what it takes to compute a warranty —
 * the client formats that text (`client/src/lib/warranty.ts`), this only
 * supplies the dates and months.
 */
export async function customerHistory(id: string) {
  const customer = await getCustomer(id);

  const complaints = await Complaint.find({ customerId: id })
    .select(
      'complaintNumber status priority category description serialNumber ' +
      'productSnapshot purchaseDate warrantyStatus createdAt closedAt reopenCount',
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
    .exec();

  return {
    customer,
    complaints,
    total: complaints.length,
    products: productsFromComplaints(complaints),
  };
}

/**
 * Service history for one serial number (section 13, "Serial number history").
 *
 * Section 13 asks for this prominently: previous complaints, dates, problems,
 * resolutions, reopens and closures for the same physical unit — regardless of
 * which customer record they sit under, since a unit can change hands.
 */
export async function serialHistory(serialNumber: string, auth: AuthContext) {
  const serial = serialNumber.trim().toUpperCase();
  const isAdmin = auth.role === 'ADMIN';

  /**
   * Outside Admin, the unit must be in the caller's own work.
   *
   * The pre-launch security review found this open to any signed-in user: a
   * technician could look up any serial number and read every complaint on
   * it, customer names, mobiles and addresses included. A technician still
   * needs the unit's past (section 10, "View History") — earlier faults are
   * how a repeat problem gets recognised — but only for a unit they have been
   * sent to, and without who owned it. Not found for anything else, so the
   * endpoint cannot be used to learn which serial numbers exist.
   */
  if (!isAdmin) {
    const ownsUnit = await Complaint.exists(
      withScope<ComplaintDoc>(complaintScope(auth), { serialNumber: serial }),
    ).exec();
    if (!ownsUnit) throw notFound('No service history found for that serial number');
  }

  const complaints = await Complaint.find({ serialNumber: serial })
    .select(
      isAdmin
        ? 'complaintNumber status priority category description customerSnapshot ' +
            'productSnapshot warrantyStatus createdAt closedAt reopenCount closureHistory'
        : 'complaintNumber status priority category description ' +
            'productSnapshot warrantyStatus createdAt closedAt reopenCount',
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .lean()
    .exec();

  return {
    serialNumber: serial,
    complaints,
    total: complaints.length,
    /* A unit with repeated complaints is exactly what section 16's "repeat
       issue patterns" report is for, so the count is surfaced here too. */
    isRepeatUnit: complaints.length > 1,
  };
}
