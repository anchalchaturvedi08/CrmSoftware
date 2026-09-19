/**
 * Route security audit (spec section 19).
 *
 * Section 19: "Enforce RBAC on backend", "Never trust client-side
 * permissions". Every other test checks the routes it knows about. This one
 * enumerates the **whole API surface from the source** and calls each route
 * with no credentials, asserting it refuses.
 *
 * The failure this prevents is not a broken check but a missing one: a route
 * mounted without `authenticate` passes every other test in the suite, because
 * no test knows to look for it. It simply answers everyone.
 *
 * ## Why the routes are read from source rather than introspected
 *
 * Express 5 compiles a mount path into a `matchers` array and keeps no literal
 * `path` on the layer, so the prefix a router was mounted at cannot be
 * recovered reliably from the router tree. Reading the declarations gives the
 * real paths, and calling them proves the behaviour — which is the thing worth
 * asserting anyway. A structural check would only prove a function with a
 * particular *name* is present.
 */
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TEST_PASSWORD, seedWorld } from '../fixtures.js';

const app = createApp();
const SRC = path.resolve(import.meta.dirname, '../../src');

interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Full path, with parameters left as `:id`. */
  path: string;
  module: string;
}

/** Maps each router variable to the prefix `app.ts` mounts it at. */
function readMounts(): Map<string, string> {
  const source = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8');
  const mounts = new Map<string, string>();

  const pattern = /app\.use\(\s*'([^']*)'\s*,\s*(\w+Router)\s*\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    /* A router mounted at '/' declares its own full paths. */
    mounts.set(match[2]!, match[1] === '/' ? '' : match[1]!);
  }

  return mounts;
}

/** Reads every route declaration out of the module route files. */
function readRoutes(): Route[] {
  const mounts = readMounts();
  const modulesDir = path.join(SRC, 'modules');
  const routes: Route[] = [];

  for (const moduleName of fs.readdirSync(modulesDir)) {
    const dir = path.join(modulesDir, moduleName);
    const file = fs.readdirSync(dir).find((name) => name.endsWith('.routes.ts'));
    if (!file) continue;

    const source = fs.readFileSync(path.join(dir, file), 'utf8');

    /* Multi-line declarations are normal here, so the path may sit on the
       line after the method call. */
    const pattern =
      /(\w+Router)\.(get|post|patch|put|delete)\(\s*[\r\n\s]*'([^']+)'/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(source))) {
      const [, routerName, method, declared] = match;
      const prefix = mounts.get(routerName!);

      if (prefix === undefined) {
        throw new Error(
          `${routerName} is declared in ${moduleName} but never mounted in app.ts`,
        );
      }

      const full = `${prefix}${declared === '/' ? '' : declared}` || '/';

      routes.push({
        method: method!.toUpperCase() as Route['method'],
        path: full,
        module: moduleName,
      });
    }
  }

  return routes;
}

/**
 * Routes that answer without credentials, each with the reason.
 *
 * Anything not on this list must refuse an unauthenticated caller. Adding to
 * it is a deliberate act that shows up in review.
 */
const PUBLIC: ReadonlyMap<string, string> = new Map([
  ['GET /health', 'liveness — must answer while the database is the broken thing'],
  ['GET /health/ready', 'readiness — same'],
  ['POST /auth/login', 'you cannot authenticate before authenticating'],
  ['POST /auth/refresh', 'the refresh token is itself the credential'],
]);

const routes = readRoutes();

/** A concrete URL for a route, with parameters filled in. */
function concrete(route: Route): string {
  return route.path
    .replace(/:attachmentId|:requestId|:usageId|:id/g, '000000000000000000000000')
    .replace(/:serialNumber/g, 'SN-AUDIT')
    .replace(/:priority/g, 'LOW')
    .replace(/:kind/g, 'complaints');
}

describe('route discovery', () => {
  it('finds the whole API surface', () => {
    /* If this drops, the reader has stopped seeing a module and everything
       below is silently checking less than it claims. */
    expect(routes.length).toBeGreaterThanOrEqual(70);
  });

  it('mounts every declared router', () => {
    /* `readRoutes` throws on an unmounted router, so reaching here means all
       of them resolved. Asserted explicitly so the intent is visible. */
    expect(routes.every((route) => route.path.startsWith('/'))).toBe(true);
  });

  it('has no duplicate method and path', () => {
    const seen = new Map<string, string[]>();
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      seen.set(key, [...(seen.get(key) ?? []), route.module]);
    }

    /* Two handlers on one path means the second is dead code — Express uses
       the first that matches. */
    const duplicated = [...seen.entries()].filter(([, modules]) => modules.length > 1);
    expect(duplicated.map(([key, modules]) => `${key} in ${modules.join(' and ')}`)).toEqual(
      [],
    );
  });
});

describe('every route refuses an unauthenticated caller (section 19)', () => {
  it('has no route that answers without a token', async () => {
    const answered: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC.has(key)) continue;

      const res = await request(app)[
        route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'
      ](concrete(route)).send({});

      /**
       * 401 is the pass. 403 also counts: `authenticate` ran and something
       * downstream refused, which still means the route is guarded.
       *
       * Anything else — 200, 400, 404, 409 — means the request reached
       * application logic without a credential.
       */
      if (res.status !== 401 && res.status !== 403) {
        answered.push(`${key} -> ${res.status}`);
      }
    }

    expect(answered, 'these routes responded without authentication').toEqual([]);
  });

  it('refuses a malformed token everywhere', async () => {
    const answered: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (PUBLIC.has(key)) continue;

      const res = await request(app)[
        route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete'
      ](concrete(route))
        .set('Authorization', 'Bearer not.a.real.token')
        .send({});

      if (res.status !== 401 && res.status !== 403) {
        answered.push(`${key} -> ${res.status}`);
      }
    }

    expect(answered, 'these routes accepted a forged token').toEqual([]);
  });
});

describe('responses never leak credentials', () => {
  let token: string;

  beforeAll(async () => {
    await seedWorld();
    const login = await request(app)
      .post('/auth/login')
      .send({ mobile: '9800000001', password: TEST_PASSWORD });

    expect(login.status).toBe(200);
    token = login.body.accessToken as string;
  });

  it('returns no password hash, Happy Code ciphertext or version key', async () => {
    /**
     * A live sweep rather than trusting `select: false` to have been applied
     * at every call site. `select: false` is the mechanism; this is the check
     * that the mechanism is actually working on the routes people use.
     */
    const endpoints = [
      '/auth/me',
      '/users',
      '/complaints',
      '/customers',
      '/products',
      '/product-models',
      '/parts',
      '/parts/stock/list',
      '/service-centers',
      '/territories',
      '/cities',
      '/visits',
      '/dashboard',
      '/audit',
      '/sla-rules',
      '/reports/complaints',
    ];

    for (const endpoint of endpoints) {
      const res = await request(app)
        .get(endpoint)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status, `${endpoint} should be reachable by Admin`).toBeLessThan(400);

      const body = JSON.stringify(res.body);

      for (const secret of ['passwordHash', 'happyCodeSecret', 'ciphertext', 'authTag']) {
        expect(body, `${endpoint} leaked ${secret}`).not.toContain(secret);
      }

      /* `__v` is optimistic-concurrency bookkeeping, not client data. */
      expect(body, `${endpoint} leaked __v`).not.toContain('"__v"');
      /* And the normalizer should have turned every _id into id. */
      expect(body, `${endpoint} returned a raw _id`).not.toContain('"_id"');
    }
  });

  it('never returns a Happy Code in a complaint list or detail', async () => {
    /* The plaintext is returned exactly twice by design: at creation, and from
       the audited /whatsapp route. Nowhere else. */
    const list = await request(app)
      .get('/complaints')
      .set('Authorization', `Bearer ${token}`);

    expect(JSON.stringify(list.body)).not.toMatch(/"happyCode"\s*:\s*"\d{6}"/);
  });
});
