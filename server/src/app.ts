/**
 * Express application assembly.
 *
 * Kept separate from `index.ts` so tests can mount the app without binding a
 * port or owning the process lifecycle.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import mongoose from 'mongoose';
import { config, isProduction, isTest } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { normalizeResponse } from './http/normalizeResponse.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { complaintRouter } from './modules/complaints/complaint.routes.js';
import { partsRouter } from './modules/parts/parts.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { mastersRouter } from './modules/masters/masters.routes.js';
import { attachmentsRouter } from './modules/attachments/attachments.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { visitsRouter } from './modules/visits/visits.routes.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { slaRouter } from './modules/sla/sla.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
/* Registers every schema with Mongoose. Must happen before any write, or the
   referential-integrity plugin cannot resolve a `ref` to its model. */
import { User, SlaRule, DEFAULT_SLA_RULES, Territory, City, ServiceCenter, Product, ProductModel, Part, PartStock, Customer } from './models/index.js';
import { hashPassword } from './core/password.js';

export function createApp(): Express {
  const app = express();

  /* Behind a reverse proxy in any real deployment, so client IPs used by rate
     limiting come from X-Forwarded-For rather than the proxy's own address. */
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        },
      },
    }),
  );
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  if (!isTest) {
    /**
     * Request logging, trimmed hard.
     *
     * pino-http's defaults serialise every request and response header. The
     * response set is ~20 lines of helmet policy that is identical on every
     * request, which buries the four fields anyone actually reads and makes
     * the development log unusable for following a request.
     *
     * So: responses keep only the status code. Requests keep method and URL
     * in development, plus caller details in production where logs are read
     * after the fact and tracing matters. Sensitive headers are already
     * redacted by the logger itself (see config/logger.ts).
     */
    /**
     * Express rewrites `req.url` to be relative to the mount point once a
     * request enters a mounted router, so by the time the response finishes
     * `/complaints/recommendations` has become `/recommendations` and
     * `/auth/login` has become `/login`. `originalUrl` is the untouched path,
     * and logging anything else makes routes unidentifiable.
     */
    const fullUrl = (req: { url?: string; originalUrl?: string }): string =>
      req.originalUrl ?? req.url ?? '';

    app.use(
      pinoHttp({
        logger,
        serializers: {
          req: (req) =>
            isProduction
              ? {
                  id: req.id,
                  method: req.method,
                  url: fullUrl(req.raw ?? req),
                  remoteAddress: req.remoteAddress,
                  userAgent: req.headers['user-agent'],
                }
              : { method: req.method, url: fullUrl(req.raw ?? req) },
          res: (res) => ({ statusCode: res.statusCode }),
        },
        /* One readable line per request in development. */
        customSuccessMessage: (req, res) =>
          `${req.method} ${fullUrl(req)} ${res.statusCode}`,
        customErrorMessage: (req, res, err) =>
          `${req.method} ${fullUrl(req)} ${res.statusCode} - ${err.message}`,
        /* Health probes would otherwise dominate the log once something is
           polling them. */
        autoLogging: {
          ignore: (req) => {
            const url = fullUrl(req);
            return url === '/health' || url === '/health/ready';
          },
        },
      }),
    );
  }

  /**
   * Liveness: the process is up. Deliberately does not touch the database, so
   * it stays meaningful while the database is the thing that is broken.
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  /**
   * Readiness: the process can actually serve traffic. Reports the database
   * connection and, because the whole design depends on it, whether this node
   * is part of a replica set and can therefore run transactions (spec §19).
   */
  app.get('/health/ready', async (_req: Request, res: Response) => {
    /* Mongoose also uses 99 for "uninitialized", so this is a keyed lookup
       rather than an array index. */
    const states: Record<number, string> = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
      99: 'uninitialized',
    };
    const dbState = states[mongoose.connection.readyState] ?? 'unknown';

    let replicaSet: string | null = null;
    let transactions = false;

    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      try {
        const hello = (await mongoose.connection.db.admin().command({ hello: 1 })) as {
          setName?: string;
        };
        replicaSet = hello.setName ?? null;
        transactions = Boolean(hello.setName);
      } catch (err) {
        logger.warn({ err }, 'readiness probe could not query server status');
      }
    }

    const ready = dbState === 'connected' && transactions;

    /* A bare "not-ready" is useless to whoever is looking at it. Say what is
       actually wrong and what to run — the most common cause by far is the
       project-local MongoDB not running. */
    let hint: string | undefined;
    if (dbState !== 'connected') {
      hint =
        'The API cannot reach MongoDB. Start the project-local replica set with ' +
        '`npm run db:start`, then check it with `npm run db:status`. ' +
        'Note it runs on port 27018, not the system service on 27017 (see DECISIONS.md section 2). ' +
        'It is a plain process, not a Windows service, so it does not survive a reboot.';
    } else if (!transactions) {
      hint =
        'MongoDB is connected but running standalone, so transactions are unavailable - ' +
        'spec section 19 requires them for closure, parts usage, reassignment and reopen. ' +
        'Run `npm run db:start` to bring up the replica set on port 27018.';
    }

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      database: dbState,
      replicaSet,
      transactions,
      timezone: config.APP_TIMEZONE,
      ...(hint ? { hint } : {}),
    });
  });

  /**
   * One response shape, whatever produced it.
   *
   * `.lean()` skips the schema's `toJSON` transform, so without this a list
   * endpoint returns `_id` and `__v` while a create endpoint returns `id`.
   * Mounted before the routers so it covers every handler, including ones
   * written later.
   */
  app.use(normalizeResponse);

  // TEMPORARY seed endpoint — remove after deployment is stable
  app.get('/seed', async (req: Request, res: Response) => {
    if (req.query['key'] !== '7fK3nP9x2mLw') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const pw = typeof req.query['password'] === 'string' && req.query['password'].length >= 12
        ? req.query['password']
        : randomBytes(12).toString('base64url');
      const passwordHash = await hashPassword(pw);
      const results: Record<string, string> = {};

      // SLA rules
      for (const rule of DEFAULT_SLA_RULES) {
        const has = await SlaRule.findOne({ priority: rule.priority }).exec();
        if (!has) await SlaRule.create({ ...rule });
      }
      results.sla = 'ready';

      // Admin
      const existingAdmin = await User.findOne({ role: 'ADMIN' }).exec();
      if (existingAdmin) {
        if (req.query['reset'] === '1') {
          existingAdmin.passwordHash = passwordHash;
          existingAdmin.mustChangePassword = false;
          await existingAdmin.save();
          results.admin = `${existingAdmin.mobile} — password reset`;
        } else {
          results.admin = `${existingAdmin.mobile} — already exists`;
        }
      } else {
        await User.create({ role: 'ADMIN', name: 'System Administrator', mobile: '9800000001', passwordHash, mustChangePassword: false });
        results.admin = '9800000001 — created';
      }

      // Demo data
      if (req.query['demo'] === '1') {
        // Territory
        const territory = (await Territory.findOne({ code: 'RAJASTHAN' }).exec())
          ?? (await Territory.create({ name: 'Rajasthan', code: 'RAJASTHAN' }));

        // City
        const city = (await City.findOne({ name: /^jaipur$/i }).exec())
          ?? (await City.create({ name: 'Jaipur', state: 'Rajasthan', territoryId: territory._id }));

        // Service Center
        const center = (await ServiceCenter.findOne({ code: 'JAI-01' }).exec())
          ?? (await ServiceCenter.create({
            name: 'Jaipur Central Service', code: 'JAI-01', mobile: '9876500000',
            address: '12 Station Road, Jaipur', cityId: city._id, pincode: '302001',
            territoryId: territory._id, servedCityIds: [city._id], servedPincodes: ['302001', '302002'],
          }));
        results.serviceCenter = `${center.code} — ready`;

        // Service Center Owner
        const existingOwner = await User.findOne({ mobile: '9800000002' }).exec();
        if (existingOwner) {
          if (req.query['reset'] === '1') {
            existingOwner.passwordHash = passwordHash;
            existingOwner.mustChangePassword = false;
            await existingOwner.save();
            results.owner = '9800000002 — password reset';
          } else {
            results.owner = '9800000002 — already exists';
          }
        } else {
          await User.create({ role: 'SERVICE_CENTER_OWNER', name: 'Center Owner', mobile: '9800000002', passwordHash, serviceCenterId: center._id, mustChangePassword: false });
          results.owner = '9800000002 — created';
        }

        // Technician
        const existingTech = await User.findOne({ mobile: '9800000003' }).exec();
        if (existingTech) {
          if (req.query['reset'] === '1') {
            existingTech.passwordHash = passwordHash;
            existingTech.mustChangePassword = false;
            await existingTech.save();
            results.technician = '9800000003 — password reset';
          } else {
            results.technician = '9800000003 — already exists';
          }
        } else {
          await User.create({ role: 'TECHNICIAN', name: 'Field Technician', mobile: '9800000003', passwordHash, serviceCenterId: center._id, mustChangePassword: false });
          results.technician = '9800000003 — created';
        }

        // Product
        const product = (await Product.findOne({ code: 'DC50' }).exec())
          ?? (await Product.create({ name: 'Desert Cooler 50L', code: 'DC50', category: 'Desert Cooler', defaultWarrantyMonths: 12 }));
        for (const m of ['DC50-X', 'DC50-PRO']) {
          if (!(await ProductModel.findOne({ productId: product._id, modelNumber: m }).exec())) {
            await ProductModel.create({ productId: product._id, modelNumber: m });
          }
        }
        results.products = 'DC50 (DC50-X, DC50-PRO) — ready';

        // Customer
        if (!(await Customer.findOne({ mobile: '9811111111' }).exec())) {
          await Customer.create({ name: 'Anita Sharma', mobile: '9811111111', address: '4 Lake View Colony', cityId: city._id, state: 'Rajasthan', pincode: '302001' });
        }
        results.customer = 'Anita Sharma (9811111111) — ready';
      }

      return res.json({ message: 'Seed complete', password: pw, results });
    } catch (err: unknown) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const clientDist = isProduction
    ? path.resolve(process.cwd(), 'client-dist')
    : '';

  if (isProduction) {
    app.use(express.static(clientDist));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && req.accepts('html') && !req.url.startsWith('/api/')) {
        return res.sendFile(path.join(clientDist, 'index.html'));
      }
      next();
    });
  }

  // In production the Vite dev proxy is gone, so strip the /api prefix
  // that the client bakes into every request.
  if (isProduction) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.url.startsWith('/api/')) {
        req.url = req.url.slice(4);
      }
      next();
    });
  }

  /* Feature routers mount here as each module lands. */
  app.use('/auth', authRouter);
  app.use('/complaints', complaintRouter);
  app.use('/parts', partsRouter);
  app.use('/users', usersRouter);
  /* Declares its own full paths (/complaints/:id/attachments, /attachments/...),
     so it mounts at the root. Placed before the complaint router has no
     bearing — Express matches the more specific path either way. */
  app.use('/', attachmentsRouter);
  app.use('/visits', visitsRouter);
  app.use('/sla-rules', slaRouter);
  app.use('/settings', settingsRouter);
  /* Declares its own full paths (/complaints/:id/timeline, /audit). */
  app.use('/', auditRouter);
  /* Likewise: /dashboard and /reports/:kind. */
  app.use('/', reportsRouter);
  /* Mounted at the root so paths read as /territories, /cities, /customers —
     "masters" is how we group the code, not a concept the API should expose. */
  app.use('/', mastersRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
