# Cooler CRM / After-Sales Service Management System

Internal after-sales service operations platform for a cooler company.
Three roles — **Admin → Service Center Owner → Technician** — around one central
object, the **Complaint**.

- **Specification (source of truth):** [`Cooler_CRM_Final_Master_Implementation_Plan.md`](Cooler_CRM_Final_Master_Implementation_Plan.md)
- **Decisions, deviations and assumptions:** [`DECISIONS.md`](DECISIONS.md)

## Stack

MongoDB 8.2 · Express 5 · React 19 · Node 26 — all TypeScript, strict mode.

## Prerequisites

- Node 22+ (verified on 26.3.1)
- MongoDB Server 8.x and `mongosh` installed locally

## Getting started

Install dependencies. **Use PowerShell, not Git Bash** — Git Bash exports a
POSIX `PATH` that the `cmd.exe` npm spawns for lifecycle scripts cannot read
(see `DECISIONS.md` §7.2):

```bash
npm install
```

Create your environment file and fill in the secrets:

```bash
cp server/.env.example server/.env
```

Generate the three required secrets:

```bash
node -e "const c=require('crypto');console.log('JWT_ACCESS_SECRET='+c.randomBytes(48).toString('base64url'));console.log('JWT_REFRESH_SECRET='+c.randomBytes(48).toString('base64url'));console.log('HAPPY_CODE_KEY='+c.randomBytes(32).toString('hex'))"
```

Start everything with one command — this brings the database up first, then the
API, so there is no second terminal to keep alive:

```bash
npm run dev
```

The API listens on `http://localhost:4000`. Check it with:

```bash
curl http://localhost:4000/health/ready
```

A healthy response looks like this — `transactions: true` is the part that
matters, because the whole design depends on it:

```json
{"status":"ready","database":"connected","replicaSet":"rs0","transactions":true}
```

If you instead see `{"status":"not-ready","database":"disconnected", ...}`, the
database has gone away and the response carries a `hint` field telling you what
to run. The API does not die when this happens — it reconnects on its own as
soon as MongoDB is back, so `npm run db:start` is enough to recover.

## Running the web portals

The API and the web app run as two processes. Open two terminals:

```bash
npm run dev
```

```bash
npm run dev:web
```

Then open **http://127.0.0.1:5173** and sign in with a seeded account.

The web app calls the API through `/api`, which Vite proxies to port 4000 — so
there is no CORS to configure, and the same client code works unchanged behind
a reverse proxy in production.

| Portal | Signed in as | Status |
|---|---|---|
| Admin | `9800000001` | Complete: dashboard (with chosen dates and a service-center filter), complaints, visits schedule, customers (with their products and warranty), products, service centers (each with its own page and ratings), users, parts, SLA, reports with Excel/CSV download, audit log, settings. Cities are typed, states come from the Indian list — nothing to set up first |
| Service Center | `9800000002` | Complete: dashboard, complaints, visits, technicians, parts, reports, profile |
| Technician | `9800000003` | Complete: My Jobs, job detail, visit flow, Schedule, History, Profile |

The technician app is designed for a phone. To see it as a technician would on
a computer, open the browser's developer tools and switch on device mode (in
Chrome: F12, then Ctrl+Shift+M).

It is also installable as a phone app, but only from a production build served
over HTTPS — so installing on a real phone waits until the app is hosted. To
try the production build locally:

```bash
npm run build --workspace client
```

```bash
npm run preview --workspace client
```

Then open **http://127.0.0.1:4173**.

## Testing the API

Three ways in, in increasing order of effort.

### 1. One command, end to end

Proves the whole backend works against your **running server** - creates a
complaint, drives it through all three roles to closure, and checks the
refusals, reports and exports:

```bash
npm run smoke -- --admin-password "..." --owner-password "..." --tech-password "..."
```

Passwords are the ones printed once by the seed. You can put them in the
environment instead (`SMOKE_ADMIN_PASSWORD` and friends) and just run
`npm run smoke`.

This is deliberately separate from `npm test`. The test suite proves the
*code* is correct; the smoke test proves *your running server* is, which is a
different question.

### 2. Postman

```bash
npm run postman
```

Import `docs/cooler-crm.postman_collection.json`. Then:

1. Open the collection variables and paste the seeded passwords.
2. Run **1. Auth > Login as Admin** - it stores the token automatically, and
   every other request uses it.
3. Work through folders 3 to 8 in order; each creation request saves the id it
   produced, so the next request already has it.

Switch role by running the Login request for that role. The folder `6. Workflow`
labels each step with the role it needs.

### 3. curl

```bash
curl -s -X POST http://127.0.0.1:4000/auth/login -H "Content-Type: application/json" -d "{\"mobile\":\"9800000001\",\"password\":\"YOUR_PASSWORD\"}"
```

Then pass the token:

```bash
curl -s http://127.0.0.1:4000/dashboard -H "Authorization: Bearer YOUR_TOKEN"
```

Use `127.0.0.1` rather than `localhost`: on Windows `localhost` resolves to
`::1` first, which fails confusingly if the server is listening on IPv4.

### Lost the seeded passwords?

They are stored only as scrypt hashes and cannot be read back. Either reset one:

```bash
curl -s -X POST http://127.0.0.1:4000/users/USER_ID/reset-password -H "Authorization: Bearer ADMIN_TOKEN"
```

or re-seed into an empty database.

## The database is not the one on port 27017

This project runs its **own** MongoDB instance on **port 27018** as a
single-node replica set, and leaves any system MongoDB service on 27017 alone.

The reason is transactions. Spec §19 requires them for complaint closure, parts
issue/usage, reassignment and reopen — and MongoDB only offers multi-document
transactions on a replica set. A standalone server rejects them outright.

The server therefore **refuses to boot** if it finds itself talking to a
standalone MongoDB, rather than letting a half-applied stock decrement surface
weeks later. Full reasoning in `DECISIONS.md` §2.

It runs as a plain background process, not a Windows service. Two consequences:

- It does **not** survive a reboot.
- Closing the terminal it was started from can take it down with it.

`npm run dev` works around both by starting it for you every time, so in normal
use you should not have to think about it. If the API starts reporting
`database: disconnected`, the database is simply gone — `npm run db:start`
brings it back and the API reconnects on its own.

| Command | What it does |
|---|---|
| `npm run db:start` | Start the instance and initiate the replica set (idempotent) |
| `npm run db:status` | Report whether it is up, PRIMARY, and transaction-capable |
| `npm run db:stop` | Shut it down cleanly |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API in watch mode |
| `npm run dev:web` | Web portals in watch mode |
| `npm run test` | Test suite |
| `npm run check:integrity --workspace server` | Scan the database for broken references and impossible states |
| `npm run typecheck --workspace server` | Strict typecheck, no emit |
| `npm run build --workspace server` | Compile to `server/dist` |
| `npm run build --workspace client` | Production build of the web portals to `client/dist` |
| `npm run icons` | Regenerate the app icons in `client/public/icons` |

## Layout

```
server/           Express API (TypeScript)
  src/
    config/       Validated env, logger
    db/           Connection lifecycle
    http/         Error types and handler
client/           React portals (Vite, TypeScript, Tailwind)
  src/
    app/          Routes and providers
    components/   UI primitives, charts, layout
    lib/          API client, auth, formatting, types
    pages/        One folder per portal
scripts/          Local MongoDB lifecycle, smoke test, Postman and icon generators
docs/             Design notes, Postman collection
```

## Conventions

- **All business rules live in the service layer.** Controllers parse requests
  and format responses; they never decide what is allowed. MongoDB enforces no
  foreign keys, so the application is the only guard there is.
- **Nothing reads `process.env` outside `src/config/env.ts`.** A missing secret
  is a loud boot failure, never an `undefined` that quietly disables a check.
- **Permissions and status transitions are enforced server-side** (spec §19).
  The UI may hide an action; that is a convenience, never the control.
- **No hard deletes** of operational records (spec §17) — active/inactive flags
  and archival only.
- **Timestamps are stored UTC** and rendered in one configurable company
  timezone (`APP_TIMEZONE`, default `Asia/Kolkata`).
