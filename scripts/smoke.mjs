/**
 * End-to-end smoke test against a running server.
 *
 * Drives one complaint from creation to closure through all three roles, then
 * exercises parts, reports and the refusals. Prints a readable trace rather
 * than assertions, so it doubles as a demonstration of what the API does.
 *
 *   node scripts/smoke.mjs
 *   node scripts/smoke.mjs --url http://localhost:4000
 *
 * Credentials come from the environment or the flags below; with none given it
 * falls back to the demo seed's mobile numbers and asks for passwords.
 *
 * This is deliberately separate from the vitest suite. That suite proves the
 * code is correct; this proves *your running server* is working, which is a
 * different question and the one you actually want answered at 9am.
 */
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token?.startsWith('--')) {
    const next = process.argv[i + 1];
    args.set(token.slice(2), next && !next.startsWith('--') ? next : 'true');
  }
}

/**
 * Defaults to `127.0.0.1`, not `localhost`.
 *
 * On Windows `localhost` resolves to `::1` before `127.0.0.1`, and Node's
 * `fetch` tries them in that order. A server listening only on IPv4 then fails
 * with a bare "fetch failed" that looks like the server is down when it is
 * merely on the other stack. Naming the address avoids the whole question.
 */
const BASE = args.get('url') ?? process.env['SMOKE_URL'] ?? 'http://127.0.0.1:4000';

const CREDENTIALS = {
  admin: {
    mobile: args.get('admin-mobile') ?? process.env['SMOKE_ADMIN_MOBILE'] ?? '9800000001',
    password: args.get('admin-password') ?? process.env['SMOKE_ADMIN_PASSWORD'],
  },
  owner: {
    mobile: args.get('owner-mobile') ?? process.env['SMOKE_OWNER_MOBILE'] ?? '9800000002',
    password: args.get('owner-password') ?? process.env['SMOKE_OWNER_PASSWORD'],
  },
  technician: {
    mobile: args.get('tech-mobile') ?? process.env['SMOKE_TECH_MOBILE'] ?? '9800000003',
    password: args.get('tech-password') ?? process.env['SMOKE_TECH_PASSWORD'],
  },
};

/* ---- Output ------------------------------------------------------------ */

const PASS = '  PASS';
const FAIL = '  FAIL';
let failures = 0;

const heading = (text) => console.log(`\n${text}\n${'-'.repeat(text.length)}`);

function report(ok, label, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? PASS : FAIL}  ${label}${detail ? `  ${detail}` : ''}`);
}

/* ---- HTTP -------------------------------------------------------------- */

async function call(method, path, { token, body, raw = false } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (raw) return { status: response.status, response };

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  return { status: response.status, body: parsed };
}

async function login(role) {
  const { mobile, password } = CREDENTIALS[role];

  if (!password) {
    console.error(
      `\nNo password for ${role}. Pass --${role}-password, or set ` +
      `SMOKE_${role.toUpperCase()}_PASSWORD.\n` +
      'Passwords are printed once by:  npm run seed --workspace server -- --demo',
    );
    process.exit(2);
  }

  const { status, body } = await call('POST', '/auth/login', {
    body: { mobile, password },
  });

  if (status !== 200) {
    console.error(`\nCould not sign in as ${role} (${mobile}): HTTP ${status}`);
    console.error(body?.error?.message ?? body);
    process.exit(2);
  }

  return body.accessToken;
}

/* ---- The run ----------------------------------------------------------- */

async function main() {
  console.log(`Cooler CRM smoke test against ${BASE}`);

  /* --- Is it even up? ------------------------------------------------- */
  heading('Health');
  const health = await call('GET', '/health/ready');
  if (health.status !== 200) {
    console.error(
      `\nServer is not ready (HTTP ${health.status}).\n` +
      JSON.stringify(health.body, null, 2),
    );
    process.exit(2);
  }
  report(health.body.transactions === true, 'database connected, transactions available');

  /* --- Sign in as all three roles ------------------------------------- */
  heading('Authentication');
  const admin = await login('admin');
  const owner = await login('owner');
  const technician = await login('technician');
  report(Boolean(admin && owner && technician), 'signed in as Admin, Owner and Technician');

  const enumeration = await Promise.all([
    call('POST', '/auth/login', { body: { mobile: CREDENTIALS.admin.mobile, password: 'wrong-password' } }),
    call('POST', '/auth/login', { body: { mobile: '9777777777', password: 'wrong-password' } }),
  ]);
  report(
    enumeration[0].body?.error?.message === enumeration[1].body?.error?.message,
    'wrong password and unknown number are indistinguishable',
  );

  /* --- Reference data -------------------------------------------------- */
  heading('Reference data');
  const [customers, products, models, centers, technicians] = await Promise.all([
    call('GET', '/customers?limit=1', { token: admin }),
    call('GET', '/products?limit=1', { token: admin }),
    call('GET', '/product-models?limit=1', { token: admin }),
    call('GET', '/service-centers?limit=1', { token: admin }),
    call('GET', '/users?role=TECHNICIAN&limit=1', { token: owner }),
  ]);

  const customerId = customers.body?.items?.[0]?.id;
  const productId = products.body?.items?.[0]?.id;
  const productModelId = models.body?.items?.[0]?.id;
  const serviceCenterId = centers.body?.items?.[0]?.id;
  const technicianId = technicians.body?.items?.[0]?.id;

  const haveAll = [customerId, productId, productModelId, serviceCenterId, technicianId].every(Boolean);
  report(haveAll, 'customer, product, model, service center and technician found');

  if (!haveAll) {
    console.error('\nSeed the demo data first:  npm run seed --workspace server -- --demo');
    process.exit(2);
  }

  /* --- The lifecycle --------------------------------------------------- */
  heading('Complaint lifecycle (spec section 7)');
  const serial = `SMOKE-${Date.now()}`;

  const created = await call('POST', '/complaints', {
    token: admin,
    body: {
      customerId,
      productId,
      productModelId,
      serialNumber: serial,
      category: 'Not cooling',
      description: 'Smoke test complaint.',
      priority: 'HIGH',
      warrantyStatus: 'IN_WARRANTY',
    },
  });

  const complaintId = created.body?.complaint?.id;
  report(
    created.status === 201 && created.body.complaint.status === 'NEW',
    'Admin created complaint',
    created.body?.complaint?.complaintNumber ?? '',
  );

  const happyCode = created.body?.happyCode;
  report(/^\d{6}$/.test(happyCode ?? ''), 'Happy Code issued');

  const steps = [
    ['Admin assigned service center', 'ASSIGNED', admin, `/complaints/${complaintId}/assign-service-center`, { serviceCenterId }],
    ['Owner assigned technician', 'TECHNICIAN_ASSIGNED', owner, `/complaints/${complaintId}/assign-technician`, { technicianId }],
    ['Owner scheduled visit', 'VISIT_SCHEDULED', owner, `/complaints/${complaintId}/visits`, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }],
    ['Technician started visit', 'IN_PROGRESS', technician, `/complaints/${complaintId}/start-visit`, { customerAvailability: 'CUSTOMER_AVAILABLE' }],
    ['Technician submitted resolution', 'RESOLUTION_SUBMITTED', technician, `/complaints/${complaintId}/resolution`, {
      diagnosis: { problemFound: 'Water pump seized' },
      workPerformed: { details: 'Replaced pump' },
      resolution: { result: 'Cooling restored' },
    }],
    ['Owner accepted resolution', 'ADMIN_CONFIRMATION', owner, `/complaints/${complaintId}/review-resolution`, { outcome: 'ACCEPTED' }],
  ];

  for (const [label, expected, token, path, body] of steps) {
    const { status } = await call('POST', path, { token, body });
    const after = await call('GET', `/complaints/${complaintId}`, { token: admin });
    report(
      status < 400 && after.body.complaint.status === expected,
      label,
      `-> ${after.body?.complaint?.status}`,
    );
  }

  /* --- The refusals section 22 names ---------------------------------- */
  heading('Section 22 refusals');

  const techClose = await call('POST', `/complaints/${complaintId}/close`, { token: technician });
  report(techClose.status === 403, 'technician cannot close', `HTTP ${techClose.status}`);

  const ownerClose = await call('POST', `/complaints/${complaintId}/close`, { token: owner });
  report(ownerClose.status === 403, 'service center owner cannot close', `HTTP ${ownerClose.status}`);

  const earlyClose = await call('POST', `/complaints/${complaintId}/close`, { token: admin });
  report(
    earlyClose.status === 409,
    'Admin cannot close before the Happy Code is verified',
    `HTTP ${earlyClose.status}`,
  );

  const wrongCode = await call('POST', `/complaints/${complaintId}/verify-happy-code`, {
    token: admin,
    body: { code: happyCode === '000000' ? '111111' : '000000' },
  });
  report(
    wrongCode.status === 200 && wrongCode.body.verified === false,
    'wrong Happy Code is rejected and the attempt counted',
    `${wrongCode.body?.attemptsRemaining} attempts left`,
  );

  /* --- Closure --------------------------------------------------------- */
  heading('Closure (Workflow F)');

  const verified = await call('POST', `/complaints/${complaintId}/verify-happy-code`, {
    token: admin,
    body: { code: happyCode },
  });
  report(verified.body?.verified === true, 'Happy Code verified');

  const closed = await call('POST', `/complaints/${complaintId}/close`, { token: admin });
  report(
    closed.status === 200 && closed.body.complaint.status === 'CLOSED',
    'Admin closed the complaint',
  );

  const reopened = await call('POST', `/complaints/${complaintId}/reopen`, {
    token: admin,
    body: { reason: 'Smoke test reopen' },
  });
  report(
    reopened.body?.complaint?.closureHistory?.length === 1,
    'reopen preserved the previous closure',
  );
  report(
    reopened.body?.happyCode && reopened.body.happyCode !== happyCode,
    'reopen issued a fresh Happy Code',
  );

  /* --- Scoping --------------------------------------------------------- */
  heading('Scoping (sections 3.2, 3.3)');

  const techList = await call('GET', '/complaints', { token: technician });
  report(
    techList.body?.items?.every((item) => item.technicianId === technicianId) ?? false,
    'technician sees only their own jobs',
    `${techList.body?.total ?? 0} complaints`,
  );

  const techReports = await call('GET', '/reports/complaints', { token: technician });
  report(techReports.status === 403, 'technician has no reports', `HTTP ${techReports.status}`);

  const techStock = await call('GET', '/parts/stock/list', { token: technician });
  report(techStock.status === 403, 'technician has no stock access', `HTTP ${techStock.status}`);

  /* --- Timeline and dashboards ---------------------------------------- */
  heading('Timeline, dashboard and reports');

  const timeline = await call('GET', `/complaints/${complaintId}/timeline`, { token: admin });
  report(
    (timeline.body?.total ?? 0) >= 10,
    'timeline recorded the whole journey',
    `${timeline.body?.total} entries`,
  );

  const dashboard = await call('GET', '/dashboard', { token: admin });
  report(
    Object.keys(dashboard.body?.kpis ?? {}).length === 10,
    'dashboard returned all ten KPI cards',
  );
  report(
    Object.keys(dashboard.body?.breakdowns ?? {}).length === 9,
    'dashboard returned all nine breakdowns',
  );

  for (const kind of ['complaints', 'service-centers', 'technicians', 'products', 'parts']) {
    const { status } = await call('GET', `/reports/${kind}`, { token: admin });
    report(status === 200, `report: ${kind}`);
  }

  const csv = await call('GET', '/reports/complaints?format=csv', { token: admin, raw: true });
  const csvText = await csv.response.text();
  report(csv.status === 200 && csvText.includes('City,'), 'CSV export');
  report(!/(^|,)=/m.test(csvText), 'CSV contains no executable formula cells');

  const xlsx = await call('GET', '/reports/complaints?format=xlsx', { token: admin, raw: true });
  const bytes = Buffer.from(await xlsx.response.arrayBuffer());
  report(
    xlsx.status === 200 && bytes.subarray(0, 2).toString() === 'PK',
    'Excel export is a valid workbook',
    `${bytes.byteLength} bytes`,
  );

  /* --- Verdict --------------------------------------------------------- */
  console.log(`\n${'='.repeat(52)}`);
  if (failures === 0) {
    console.log('All checks passed. The backend is working end to end.');
  } else {
    console.log(`${failures} check(s) FAILED. See the FAIL lines above.`);
  }
  console.log('='.repeat(52));

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test could not run:', err.message);
  console.error(`Is the server running at ${BASE}?  Start it with:  npm run dev`);
  process.exit(2);
});
