/**
 * Generates a Postman collection for the whole API.
 *
 * Generated rather than hand-written so it cannot drift: re-run it after
 * adding endpoints and the collection is correct again. A hand-maintained
 * collection is one that is wrong within a week.
 *
 *   node scripts/generate-postman.mjs
 *
 * Import the result into Postman, then run "Auth > Login as Admin" once —
 * a test script on that request stores the token in a collection variable, so
 * every other request is authenticated automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const OUT = path.join(ROOT, 'docs', 'cooler-crm.postman_collection.json');

/** Saves tokens from a login or refresh response into collection variables. */
const SAVE_SESSION = `
const body = pm.response.json();
if (body.accessToken) {
  pm.collectionVariables.set('accessToken', body.accessToken);
  pm.collectionVariables.set('refreshToken', body.refreshToken);
  console.log('Signed in as ' + body.user.role + ' — token stored');
}
`.trim();

/** Captures an id from a creation response so later requests can use it. */
const save = (variable, expression) => `
const body = pm.response.json();
const value = ${expression};
if (value) {
  pm.collectionVariables.set('${variable}', value);
  console.log('${variable} = ' + value);
}
`.trim();

/**
 * Endpoint definitions.
 *
 * `body` is written as an object and serialised below, so the examples stay
 * readable here and valid JSON in the output.
 */
/** Captures the first item of a list response into a variable. */
const saveFirst = (variable, label) => `
const body = pm.response.json();
const first = body.items && body.items[0];
if (first && first.id) {
  pm.collectionVariables.set('${variable}', first.id);
  console.log('${variable} = ' + first.id + '  (${label}: ' + (first.name || first.modelNumber || first.complaintNumber || '') + ')');
} else {
  console.warn('No ${label} found — run the demo seed first.');
}
`.trim();

const FOLDERS = [
  {
    name: '0. Setup',
    description:
      'Run this folder once, top to bottom, before anything else.\n\n' +
      'It signs you in and captures the IDs of the data the demo seed already ' +
      'created, so every other request has what it needs. In Postman: hover the ' +
      'folder, press the ▸ Run button, then Run.',
    requests: [
      {
        name: 'Step 1 — Login as Admin',
        method: 'POST',
        url: '/auth/login',
        auth: false,
        body: { mobile: '{{adminMobile}}', password: '{{adminPassword}}' },
        test: SAVE_SESSION,
      },
      {
        name: 'Step 2 — Capture a customer',
        method: 'GET',
        url: '/customers?limit=1',
        test: saveFirst('customerId', 'customer'),
      },
      {
        name: 'Step 3 — Capture a product',
        method: 'GET',
        url: '/products?limit=1',
        test: saveFirst('productId', 'product'),
      },
      {
        /**
         * Filtered by the product captured in step 3.
         *
         * Grabbing any model would eventually pair a model with a different
         * product's id, and complaint creation refuses that combination —
         * correctly, but with a 400 that looks like a bug in the collection.
         */
        name: 'Step 4 — Capture a model for that product',
        method: 'GET',
        url: '/product-models?productId={{productId}}&limit=1',
        test: saveFirst('productModelId', 'model'),
      },
      {
        name: 'Step 5 — Capture a service center',
        method: 'GET',
        url: '/service-centers?limit=1',
        test: saveFirst('serviceCenterId', 'service center'),
      },
      {
        name: 'Step 6 — Capture a technician',
        method: 'GET',
        url: '/users?role=TECHNICIAN&limit=1',
        test: saveFirst('technicianId', 'technician'),
      },
      {
        name: 'Step 7 — Capture a part',
        method: 'GET',
        url: '/parts?limit=1',
        test: saveFirst('partId', 'part'),
      },
      {
        name: 'Step 8 — Check what was captured',
        method: 'GET',
        url: '/health/ready',
        auth: false,
        test: `
const needed = ['customerId','productId','productModelId','serviceCenterId','technicianId','partId'];
const missing = needed.filter((key) => !pm.collectionVariables.get(key));
if (missing.length === 0) {
  console.log('Setup complete — every ID captured. Move on to folder 5.');
} else {
  console.warn('Missing: ' + missing.join(', ') + '. Run the demo seed: npm run seed --workspace server -- --demo');
}
`.trim(),
      },
    ],
  },
  {
    name: '1. Auth',
    description:
      'Start here. Run "Login as Admin" first — it stores the token for every other request.',
    requests: [
      {
        name: 'Login as Admin',
        method: 'POST',
        url: '/auth/login',
        auth: false,
        body: { mobile: '{{adminMobile}}', password: '{{adminPassword}}' },
        test: SAVE_SESSION,
      },
      {
        name: 'Login as Service Center Owner',
        method: 'POST',
        url: '/auth/login',
        auth: false,
        body: { mobile: '{{ownerMobile}}', password: '{{ownerPassword}}' },
        test: SAVE_SESSION,
      },
      {
        name: 'Login as Technician',
        method: 'POST',
        url: '/auth/login',
        auth: false,
        body: { mobile: '{{techMobile}}', password: '{{techPassword}}' },
        test: SAVE_SESSION,
      },
      { name: 'Who am I', method: 'GET', url: '/auth/me' },
      {
        name: 'Refresh token',
        method: 'POST',
        url: '/auth/refresh',
        auth: false,
        body: { refreshToken: '{{refreshToken}}' },
        test: SAVE_SESSION,
      },
      {
        name: 'Change my password',
        method: 'POST',
        url: '/auth/change-password',
        body: { currentPassword: 'current-password', newPassword: 'a-new-long-passphrase' },
      },
      {
        name: 'Sign out this device',
        method: 'POST',
        url: '/auth/logout',
        auth: false,
        body: { refreshToken: '{{refreshToken}}' },
      },
    ],
  },
  {
    name: '2. Dashboard & Reports',
    description: 'Spec sections 5.1, 9 and 16. Admin and Owner only.',
    requests: [
      { name: 'Dashboard', method: 'GET', url: '/dashboard' },
      { name: 'Report: complaints', method: 'GET', url: '/reports/complaints' },
      { name: 'Report: service centers', method: 'GET', url: '/reports/service-centers' },
      { name: 'Report: technicians', method: 'GET', url: '/reports/technicians' },
      { name: 'Report: products', method: 'GET', url: '/reports/products' },
      { name: 'Report: parts', method: 'GET', url: '/reports/parts' },
      {
        name: 'Export complaints as CSV',
        method: 'GET',
        url: '/reports/complaints?format=csv',
      },
      {
        name: 'Export complaints as Excel',
        method: 'GET',
        url: '/reports/complaints?format=xlsx',
      },
    ],
  },
  {
    name: '3. Master data',
    description:
      'Admin creates; every role can read the reference data. Customers are Admin only, ' +
      'and serial history outside Admin covers only units in your own work. Spec section 25 Phase 2.\n\n' +
      'Cities are typed, not created: send cityName + state (an Indian state or union territory) ' +
      'and the server files the city, creating it the first time (DECISIONS.md section 32). ' +
      'Territories are one per state, created by the server; /territories and /cities stay readable.',
    requests: [
      { name: 'List states (territories, one per state)', method: 'GET', url: '/territories' },
      { name: 'List cities', method: 'GET', url: '/cities' },
      { name: 'List service centers', method: 'GET', url: '/service-centers' },
      {
        name: 'Create service center',
        method: 'POST',
        url: '/service-centers',
        body: {
          name: 'Kochi Service',
          code: 'KOC-01',
          mobile: '9876512345',
          address: '1 Marine Drive',
          cityName: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
          servedCities: [{ name: 'Alappuzha', state: 'Kerala' }],
          servedPincodes: ['682001', '682002'],
        },
        test: save('serviceCenterId', 'body.center && body.center.id'),
      },
      {
        name: 'Service center overview (Admin)',
        method: 'GET',
        url: '/service-centers/{{serviceCenterId}}/overview',
      },
      {
        name: 'Deactivate service center',
        method: 'PATCH',
        url: '/service-centers/{{serviceCenterId}}',
        body: { isActive: false },
      },
      { name: 'List products', method: 'GET', url: '/products' },
      {
        name: 'Create product',
        method: 'POST',
        url: '/products',
        body: { name: 'Tower Cooler 30L', code: 'TC30', defaultWarrantyMonths: 12 },
        test: save('productId', 'body.product && body.product.id'),
      },
      { name: 'List product models', method: 'GET', url: '/product-models' },
      {
        name: 'Create product model',
        method: 'POST',
        url: '/product-models',
        body: { productId: '{{productId}}', modelNumber: 'TC30-A' },
        test: save('productModelId', 'body.model && body.model.id'),
      },
      { name: 'List customers', method: 'GET', url: '/customers' },
      {
        name: 'Create customer',
        method: 'POST',
        url: '/customers',
        body: {
          name: 'Ravi Menon',
          mobile: '9812345678',
          address: '12 Beach Road',
          cityName: 'Kochi',
          state: 'Kerala',
          pincode: '682001',
        },
        test: save('customerId', 'body.customer && body.customer.id'),
      },
      {
        name: 'Customer service history',
        method: 'GET',
        url: '/customers/{{customerId}}/history',
      },
      {
        name: 'Serial number history',
        method: 'GET',
        url: '/serial-history/SN-0001',
      },
    ],
  },
  {
    name: '4. Users & technicians',
    description:
      'Admin creates anyone; an Owner creates technicians for their own centre only (spec 3.2).',
    requests: [
      { name: 'List users', method: 'GET', url: '/users' },
      {
        name: 'Create technician (as Owner)',
        method: 'POST',
        url: '/users',
        body: { role: 'TECHNICIAN', name: 'New Technician', mobile: '9812340099' },
        test: save('newUserId', 'body.user && body.user.id'),
      },
      {
        name: 'Create service center owner (as Admin)',
        method: 'POST',
        url: '/users',
        body: {
          role: 'SERVICE_CENTER_OWNER',
          name: 'New Owner',
          mobile: '9812340098',
          serviceCenterId: '{{serviceCenterId}}',
        },
      },
      {
        name: 'Deactivate user',
        method: 'PATCH',
        url: '/users/{{newUserId}}',
        body: { isActive: false },
      },
      {
        name: 'Reset a user password',
        method: 'POST',
        url: '/users/{{newUserId}}/reset-password',
        body: {},
      },
    ],
  },
  {
    name: '5. Complaints',
    description: 'Spec section 6 and Workflow A. Only Admin can create.',
    requests: [
      {
        name: 'Recommend service centers',
        method: 'GET',
        url: '/complaints/recommendations?pincode=302001',
      },
      {
        name: 'Create complaint',
        method: 'POST',
        url: '/complaints',
        body: {
          customerId: '{{customerId}}',
          productId: '{{productId}}',
          productModelId: '{{productModelId}}',
          serialNumber: 'SN-0001',
          category: 'Not cooling',
          description: 'Cooler runs but blows warm air.',
          priority: 'HIGH',
          warrantyStatus: 'IN_WARRANTY',
        },
        test: save('complaintId', 'body.complaint && body.complaint.id'),
      },
      { name: 'List complaints', method: 'GET', url: '/complaints' },
      { name: 'Open complaints only', method: 'GET', url: '/complaints?open=true' },
      { name: 'Open complaints past their SLA', method: 'GET', url: '/complaints?slaBreached=true' },
      { name: 'Search by mobile as shown on screen', method: 'GET', url: '/complaints?search=98111%2011111' },
      {
        name: 'Search complaints',
        method: 'GET',
        url: '/complaints?search=SN-0001&status=NEW',
      },
      { name: 'Complaint detail', method: 'GET', url: '/complaints/{{complaintId}}' },
      {
        name: 'Complaint timeline',
        method: 'GET',
        url: '/complaints/{{complaintId}}/timeline',
      },
      {
        name: 'WhatsApp link (reveals Happy Code)',
        method: 'GET',
        url: '/complaints/{{complaintId}}/whatsapp',
        test: save('happyCode', 'body.happyCode'),
      },
    ],
  },
  {
    name: '6. Workflow',
    description:
      'The lifecycle in order. Switch login between Admin, Owner and Technician as the folder notes say.',
    requests: [
      {
        name: 'ADMIN: assign service center',
        method: 'POST',
        url: '/complaints/{{complaintId}}/assign-service-center',
        body: { serviceCenterId: '{{serviceCenterId}}' },
      },
      {
        name: 'OWNER: assign technician',
        method: 'POST',
        url: '/complaints/{{complaintId}}/assign-technician',
        body: { technicianId: '{{technicianId}}' },
      },
      {
        name: 'OWNER: schedule visit',
        method: 'POST',
        url: '/complaints/{{complaintId}}/visits',
        body: { scheduledAt: '2026-12-31T10:00:00.000Z' },
        test: save('visitId', 'body.visit && body.visit.id'),
      },
      {
        name: 'TECH: start visit',
        method: 'POST',
        url: '/complaints/{{complaintId}}/start-visit',
        body: { customerAvailability: 'CUSTOMER_AVAILABLE' },
      },
      {
        name: 'TECH: submit resolution',
        method: 'POST',
        url: '/complaints/{{complaintId}}/resolution',
        body: {
          diagnosis: { problemFound: 'Water pump seized' },
          workPerformed: { details: 'Replaced pump and flushed the tank' },
          resolution: { result: 'Cooling restored' },
        },
      },
      {
        name: 'OWNER: accept resolution',
        method: 'POST',
        url: '/complaints/{{complaintId}}/review-resolution',
        body: { outcome: 'ACCEPTED' },
      },
      {
        name: 'OWNER: reject and require revisit',
        method: 'POST',
        url: '/complaints/{{complaintId}}/review-resolution',
        body: { outcome: 'REVISIT_REQUIRED', reason: 'Customer says it is still warm' },
      },
      {
        name: 'ADMIN: require rework (customer says not fixed)',
        method: 'POST',
        url: '/complaints/{{complaintId}}/require-rework',
        body: { reason: 'Customer says it still blows warm air' },
      },
      {
        name: 'ADMIN: verify Happy Code',
        method: 'POST',
        url: '/complaints/{{complaintId}}/verify-happy-code',
        body: { code: '{{happyCode}}' },
      },
      {
        name: 'ADMIN: close complaint',
        method: 'POST',
        url: '/complaints/{{complaintId}}/close',
      },
      {
        name: 'ADMIN: rate service center',
        method: 'POST',
        url: '/complaints/{{complaintId}}/rating',
        body: { stars: 5, note: 'Great work' },
      },
      {
        name: 'ADMIN: reopen complaint',
        method: 'POST',
        url: '/complaints/{{complaintId}}/reopen',
        body: { reason: 'Same fault returned within a week' },
      },
      {
        name: 'ADMIN: regenerate Happy Code',
        method: 'POST',
        url: '/complaints/{{complaintId}}/regenerate-happy-code',
      },
      {
        name: 'ADMIN: cancel complaint',
        method: 'POST',
        url: '/complaints/{{complaintId}}/cancel',
        body: { reason: 'Raised by mistake' },
      },
      {
        name: 'Mark waiting for parts',
        method: 'POST',
        url: '/complaints/{{complaintId}}/waiting-for-parts',
        body: { reason: 'Fan motor out of stock' },
      },
      {
        name: 'Resume work',
        method: 'POST',
        url: '/complaints/{{complaintId}}/resume-work',
      },
    ],
  },
  {
    name: '7. Visits',
    description: 'Spec sections 9 and 10.',
    requests: [
      { name: 'Schedule / calendar', method: 'GET', url: '/visits' },
      { name: 'Today only', method: 'GET', url: '/visits?date=2026-09-15' },
      { name: 'ADMIN: finished visits, one centre', method: 'GET', url: '/visits?status=COMPLETED,CANCELLED&serviceCenterId={{serviceCenterId}}&sort=desc' },
      { name: 'TECH: my jobs', method: 'GET', url: '/visits/my-jobs' },
      { name: 'Visit detail', method: 'GET', url: '/visits/{{visitId}}' },
      {
        name: 'Reschedule visit',
        method: 'POST',
        url: '/visits/{{visitId}}/reschedule',
        body: { scheduledAt: '2026-12-31T14:00:00.000Z', reason: 'Customer asked for afternoon' },
      },
      {
        name: 'Cancel visit',
        method: 'POST',
        url: '/visits/{{visitId}}/cancel',
        body: { reason: 'Customer not available all week' },
      },
    ],
  },
  {
    name: '8. Parts & stock',
    description: 'Spec section 11. Stock moves only when usage is finalised.',
    requests: [
      { name: 'List parts', method: 'GET', url: '/parts' },
      {
        name: 'Create part (Admin)',
        method: 'POST',
        url: '/parts',
        body: { name: 'Drain Valve', code: 'VALVE-01', unit: 'PIECE' },
        test: save('partId', 'body.part && body.part.id'),
      },
      { name: 'Stock levels', method: 'GET', url: '/parts/stock/list' },
      { name: 'Low stock only', method: 'GET', url: '/parts/stock/list?lowOnly=true' },
      {
        name: 'Set stock (stocktake)',
        method: 'PUT',
        url: '/parts/stock',
        body: { partId: '{{partId}}', availableQuantity: 20, minimumStock: 5 },
      },
      {
        name: 'Adjust stock (delivery)',
        method: 'POST',
        url: '/parts/stock/adjust',
        body: { partId: '{{partId}}', delta: 10, reason: 'Delivery received' },
      },
      {
        name: 'TECH: request a part',
        method: 'POST',
        url: '/complaints/{{complaintId}}/part-requests',
        body: { partId: '{{partId}}', quantityRequested: 2, reason: 'Pump seized' },
        test: save('partRequestId', 'body.request && body.request.id'),
      },
      { name: 'Request queue', method: 'GET', url: '/parts/requests/list' },
      { name: 'Requests still waiting', method: 'GET', url: '/parts/requests/list?status=REQUESTED,APPROVED' },
      {
        name: 'OWNER: issue the part',
        method: 'POST',
        url: '/parts/requests/{{partRequestId}}/decide',
        body: { status: 'ISSUED', quantityIssued: 2 },
      },
      {
        name: 'OWNER: mark unavailable',
        method: 'POST',
        url: '/parts/requests/{{partRequestId}}/decide',
        body: { status: 'UNAVAILABLE', remarks: 'None left, reordering' },
      },
      {
        name: 'TECH: record parts used',
        method: 'POST',
        url: '/complaints/{{complaintId}}/part-usage',
        body: { partId: '{{partId}}', quantity: 1 },
        test: save('partUsageId', 'body.usage && body.usage.id'),
      },
      {
        name: 'List usage on a complaint',
        method: 'GET',
        url: '/complaints/{{complaintId}}/part-usage',
      },
      {
        name: 'OWNER: finalise usage (moves stock)',
        method: 'POST',
        url: '/parts/usage/{{partUsageId}}/finalize',
      },
    ],
  },
  {
    name: '9. Attachments',
    description:
      'Upload is multipart. In Postman, set the body to form-data with a "file" key of type File.',
    requests: [
      {
        name: 'Upload photo (form-data)',
        method: 'POST',
        url: '/complaints/{{complaintId}}/attachments',
        formData: [
          { key: 'file', type: 'file', src: [] },
          { key: 'kind', value: 'BEFORE_PHOTO', type: 'text' },
          { key: 'caption', value: 'Cooler as found', type: 'text' },
        ],
      },
      {
        name: 'List attachments',
        method: 'GET',
        url: '/complaints/{{complaintId}}/attachments',
        test: saveFirst('attachmentId', 'attachment'),
      },
      {
        name: 'Download file',
        method: 'GET',
        url: '/attachments/{{attachmentId}}/file',
      },
    ],
  },
  {
    name: '10. SLA, Audit & Settings',
    description: 'Spec sections 4, 14 and 17.',
    requests: [
      { name: 'SLA rules', method: 'GET', url: '/sla-rules' },
      {
        name: 'Update an SLA rule (Admin)',
        method: 'PATCH',
        url: '/sla-rules/CRITICAL',
        body: { responseHours: 1, resolutionHours: 6 },
      },
      { name: 'Audit log (Admin)', method: 'GET', url: '/audit' },
      {
        name: 'Audit filtered by entity',
        method: 'GET',
        url: '/audit?entityType=Complaint',
      },
      { name: 'Audit: sign-ins only', method: 'GET', url: '/audit?category=sign-in' },
      { name: 'Audit: session renewals (hidden by default)', method: 'GET', url: '/audit?action=TOKEN_REFRESHED' },
      { name: 'Complaint activity, all complaints (Admin)', method: 'GET', url: '/audit/activity' },
      {
        name: 'Complaint activity for one complaint number',
        method: 'GET',
        url: '/audit/activity?complaintNumber=CMP-2026-000001',
      },
      { name: 'Settings: rules in force (Admin)', method: 'GET', url: '/settings' },
    ],
  },
  {
    name: '11. Health',
    description: 'No authentication required.',
    requests: [
      { name: 'Liveness', method: 'GET', url: '/health', auth: false },
      { name: 'Readiness', method: 'GET', url: '/health/ready', auth: false },
    ],
  },
];

function buildRequest(definition) {
  const [rawPath, query] = definition.url.split('?');
  const segments = rawPath.split('/').filter(Boolean);

  const request = {
    method: definition.method,
    header: [],
    url: {
      raw: `{{baseUrl}}${definition.url}`,
      host: ['{{baseUrl}}'],
      path: segments,
      ...(query
        ? {
            query: query.split('&').map((pair) => {
              const [key, value] = pair.split('=');
              return { key, value: value ?? '' };
            }),
          }
        : {}),
    },
  };

  /* Requests that must not carry a token say so; everything else inherits the
     collection-level bearer auth. */
  if (definition.auth === false) {
    request.auth = { type: 'noauth' };
  }

  if (definition.formData) {
    request.body = { mode: 'formdata', formdata: definition.formData };
  } else if (definition.body !== undefined) {
    request.header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(definition.body, null, 2),
      options: { raw: { language: 'json' } },
    };
  }

  const item = { name: definition.name, request };

  if (definition.test) {
    item.event = [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: definition.test.split('\n') },
      },
    ];
  }

  return item;
}

const collection = {
  info: {
    name: 'Cooler CRM API',
    description:
      'After-sales service management API.\n\n' +
      'Run "1. Auth > Login as Admin" first — it stores the token automatically ' +
      'and every other request uses it.\n\n' +
      'Seed credentials come from `npm run seed --workspace server -- --demo`. ' +
      'Set them in the collection variables below.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: {
    type: 'bearer',
    bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:4000' },
    { key: 'adminMobile', value: '9800000001' },
    { key: 'adminPassword', value: 'PASTE_FROM_SEED_OUTPUT' },
    { key: 'ownerMobile', value: '9800000002' },
    { key: 'ownerPassword', value: 'PASTE_FROM_SEED_OUTPUT' },
    { key: 'techMobile', value: '9800000003' },
    { key: 'techPassword', value: 'PASTE_FROM_SEED_OUTPUT' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
    { key: 'complaintId', value: '' },
    { key: 'customerId', value: '' },
    { key: 'productId', value: '' },
    { key: 'productModelId', value: '' },
    { key: 'serviceCenterId', value: '' },
    { key: 'cityId', value: '' },
    { key: 'technicianId', value: '' },
    { key: 'visitId', value: '' },
    { key: 'partId', value: '' },
    { key: 'partRequestId', value: '' },
    { key: 'partUsageId', value: '' },
    { key: 'attachmentId', value: '' },
    { key: 'newUserId', value: '' },
    { key: 'happyCode', value: '' },
  ],
  item: FOLDERS.map((folder) => ({
    name: folder.name,
    description: folder.description,
    item: folder.requests.map(buildRequest),
  })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(collection, null, 2), 'utf8');

const count = FOLDERS.reduce((sum, folder) => sum + folder.requests.length, 0);
console.log(`Wrote ${count} requests in ${FOLDERS.length} folders to:`);
console.log(`  ${path.relative(ROOT, OUT)}`);
