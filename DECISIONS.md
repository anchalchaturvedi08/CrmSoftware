# Cooler CRM — Architecture Decisions & Spec Deviations

Companion to `Cooler_CRM_Final_Master_Implementation_Plan.md` (the source-of-truth spec).
This file records decisions made *outside* that document, and the points where we
knowingly depart from it. Amend freely — this is the living record.

Date opened: 2026-09-14

---

## 1. Locked stack decisions

| Decision | Choice | Notes |
|---|---|---|
| Stack | MERN | MongoDB 8.2, Express, React 19, Node 26 |
| Language | TypeScript | Both `server/` and `client/` |
| Build order | Backend/API first, then the three UIs | Per user choice |
| Happy Code storage | AES-256-GCM encrypted, Admin-re-viewable | Overrides spec §18 `happy_code_hash` |
| Admin login | Mobile + Password | Spec never stated it; matches §3.2/§3.3 |
| Environment | Local dev only | Hosting deferred |
| Database process | Project-local replica set, port 27018 | See §2 |

---

## 2. MongoDB setup (IMPORTANT — not the default service)

The project does **not** use the system MongoDB service on port 27017.
That instance is standalone, so it cannot run transactions, which spec §19
requires for closure, parts issue/usage, reassignment and reopen.

Instead a project-local single-node replica set runs on **port 27018**:

- Replica set name: `rs0`
- Data: `.mongo/data/` (gitignored)
- Logs: `.mongo/log/mongod.log` (gitignored)
- Connection: `mongodb://127.0.0.1:27018/cooler_crm?replicaSet=rs0`

Verified on setup: `isWritablePrimary: true`, multi-document transaction commits OK.

It is started by `npm run db:start` and is **not** a Windows service, so it does
not survive a reboot — restart it after logging back in.

Rationale for not converting the system service: doing so requires editing
`mongod.cfg` under `Program Files` and restarting the service, which needs
administrator rights this session does not have. The project-local instance also
isolates this project from any other MongoDB work on the machine.

If you later prefer to convert the system service instead, run an **elevated**
PowerShell and add to `C:\Program Files\MongoDB\Server\8.2\bin\mongod.cfg`:

```yaml
replication:
  replSetName: rs0
```

then `Restart-Service MongoDB` and `mongosh --eval 'rs.initiate()'`.

---

## 3. Deliberate deviation from the spec: document database

Spec §18 says "Use a relational database" and §19 requires foreign keys,
unique constraints, indexes and transactions. The user chose MERN instead.
Accepted, with these compensating controls:

| §19 requirement | How it is met without a relational DB |
|---|---|
| Foreign keys | **App-level.** A shared Mongoose plugin validates every `ref` target exists and is active before save. MongoDB enforces nothing here. |
| Unique constraints | Native unique indexes (fully supported). |
| Indexes | Native (fully supported). |
| Transactions | Native multi-document ACID transactions — the reason for the replica set. |

**Standing risk:** referential integrity is only as good as the application code.
An integrity-check script is part of the deliverable, and any new `ref` field must
be registered with the validation plugin.

---

## 4. Spec contradictions found, and their resolutions

### 4.1 `NEW` was unreachable
§6.1 lists Service Center as a creation field and Workflow A step 10 selects it
during creation, so every complaint would be born `ASSIGNED` — yet §7 keeps `NEW`
as status #1 and Workflow A step 13 hedges ("NEW/ASSIGNED").

**Resolution:** service center is **optional** at creation. Saving without one
yields `NEW`; assigning one moves it to `ASSIGNED`. Both statuses stay meaningful.

### 4.2 Happy Code could strand a complaint forever
The code reaches the customer only via a WhatsApp message Admin sends by hand.
But §6.4 disables that action for an invalid/missing number, §15 forbids every
other channel, and §22 blocks closure without the code. Invalid number ⇒
uncloseable complaint.

**Resolution:** Admin can re-view and re-send the code (hence encryption, not
hashing), and can regenerate it. Every view, resend, regenerate and verification
attempt is audit-logged.

### 4.3 `happy_code_hash` vs. re-sending
A hash is one-way and cannot be re-read to re-send. Resolved by 4.2 —
encrypted at rest instead of hashed.

**Added control:** a 6-digit numeric code is only 10^6 possibilities, so
verification is attempt-limited and every attempt is logged. Unlimited guessing
would make the control decorative.

### 4.4 Product vs. Model was ambiguous
§18's entity list has only `Product`, but the nav, §25 Phase 2 and the §6.1
complaint form all treat Model as distinct.

**Resolution:** `Product` *has many* `Model`. `serial_number` lives on the
complaint, not as its own tracked unit entity — which is what §13's
serial-number history search needs.

### 4.5 Nobody set the technician's first password
§3.2 lets Owners create technicians who log in with Mobile + Password, but never
says who sets the initial one.

**Resolution:** Owner sets a temporary password; technician is forced to change it
on first login.

---

## 5. Assumed defaults (stated, not confirmed — correct any of these)

1. **Customer identity:** unique by mobile number, reusable across complaints
   (required by §13 repeat-complaint history).
2. **Revisit path:** `REVISIT REQUIRED` → Owner schedules a new visit →
   `VISIT SCHEDULED` → `IN PROGRESS`. Each visit is its own record; the complaint
   carries a single status.
3. **Reopen:** keeps the original complaint number, issues a **fresh** Happy Code,
   starts a new SLA clock, and preserves the prior closure record.
4. **SLA pausing** for `WAITING FOR PARTS` / `REVISIT REQUIRED` ships **off**,
   configurable per §14.
5. **Attachments:** local disk behind a storage interface, so S3 is a config swap.
6. **Time:** stored UTC, displayed in one configurable company timezone,
   default `Asia/Kolkata`.
7. **History snapshots:** customer address, product/model details and warranty are
   snapshotted onto the complaint at creation, so later edits to master records
   cannot retroactively rewrite a closed complaint (serves §15, §17).
8. **Portals:** one React app with three role-scoped route groups sharing a
   component system; technician routes carry the PWA manifest and service worker.

---

## 6. Known gaps to revisit

- DB authentication is **off** on the local instance (no `security:` block).
  Acceptable on localhost; must be enabled before any deployment.
- Deployment target undecided — config is environment-driven so this is not a rewrite.

---

## 7. Toolchain decisions forced by the environment

### 7.1 Password hashing: Node's built-in `scrypt`, not Argon2

`argon2` is a native module and failed to install — no C++ toolchain is present,
and `node-gyp-build` could not run. Rather than ask you to install Visual Studio
Build Tools, we use **`crypto.scryptSync`** from Node's standard library.

scrypt is memory-hard and an accepted password-hashing choice alongside Argon2id
and bcrypt, so §19's "passwords must be securely hashed" is satisfied with zero
native dependencies and no install risk on any machine.

If Argon2id is later required, `argon2` can be swapped in behind the same
hashing interface once build tools are available.

### 7.2 Run `npm` from PowerShell, not the Bash shell

`npm install` fails from Git Bash on this machine. Git Bash exports a POSIX-style
`PATH` (`/c/Program Files/nodejs`), npm passes that `PATH` to the `cmd.exe` it
spawns for lifecycle scripts, and `cmd.exe` cannot interpret it — so every
postinstall script dies with `'node' is not recognized`.

**Use PowerShell for `npm install` and any npm lifecycle script.**

### 7.3 esbuild's blocked postinstall is harmless

npm's allow-scripts policy blocks `esbuild`'s postinstall. This does not matter:
the platform binary (`@esbuild/win32-x64`) arrives as an optional dependency, and
both `tsx` and `vitest` were verified working. No approval needed.

### 7.4 Two moderate advisories left unfixed

`vitest` / `@vitest/mocker` carry moderate advisories with no non-breaking fix
available — only `npm audit fix --force`. They are **dev-only** test tooling and
are never shipped, so forcing a major churn of the test runner buys no production
security. Revisit when vitest publishes a patched release.

---

## 8. Foundation verified working (2026-09-14)

- MongoDB replica set `rs0` on 27018 — PRIMARY, transactions commit OK
- `npm run db:start` / `db:stop` / `db:status` — full lifecycle tested
- TypeScript strict typecheck — clean
- Server boots, connects, and `/health/ready` returns
  `{"status":"ready","database":"connected","replicaSet":"rs0","transactions":true}`
- Error envelope confirmed: `{"error":{"code":"NOT_FOUND","message":"..."}}`

The server **refuses to boot** against a standalone MongoDB, by design — a
missing replica set would otherwise surface much later as a corrupted stock
count. See `src/db/connect.ts`.

---

## 9. Data model complete and verified (2026-09-14)

All 17 entities from spec section 18 are implemented in `server/src/models/`,
with 18 integration tests passing against the real replica set.

### Entity mapping

| Spec section 18 | Implementation |
|---|---|
| 1. Admin User / 5. Technician | `User` (role discriminator, see below) |
| 2. Service Center | `ServiceCenter` |
| 3. City / 4. Territory | `City`, `Territory` |
| 6. Customer | `Customer` |
| 7. Product | `Product` + `ProductModel` (per 4.4) |
| 8. Complaint | `Complaint` |
| 9. Complaint Activity | `ComplaintActivity` |
| 10. Visit | `Visit` |
| 11. Attachment | `Attachment` |
| 12-15. Part / Stock / Request / Usage | `Part`, `PartStock`, `PartRequest`, `PartUsage` |
| 16. SLA Rule | `SlaRule` |
| 17. Audit Log | `AuditLog` |
| *(not in spec)* | `Counter` - atomic complaint numbering |

### Decisions made while modelling

**One `User` collection, not three.** All three roles authenticate with
Mobile + Password, so splitting them would mean three login paths, three places
to get hashing right, and no single index guaranteeing a mobile number
identifies one person. Scope lives in `serviceCenterId`; a pre-validate hook
enforces that Owners and Technicians have one and Admins do not.

**`Counter` was added to the entity list.** Section 6.2 requires unique
complaint numbers, and deriving the next one by counting existing complaints is
a race that mints duplicates. An atomic `$inc` on a single counter document is
not. Verified: 50 concurrent callers receive 50 distinct numbers.

**Happy Code secret is isolated.** `Complaint.happyCodeSecret` is
`select: false`, so no list response, report export or log line can carry it.
Verification metadata lives separately in `happyCode` so the workflow is
reasonable about without loading the secret.

**Low-stock status is derived, not stored.** Section 11 lists it as a tracked
field, but storing it creates a second source of truth that drifts whenever a
quantity changes without the flag. It is a virtual; the low-stock report uses an
aggregation.

**Work records live on `Visit`, not `Complaint`.** A complaint can have many
visits (revisit, parts return trip, customer absent). Diagnosis, work performed
and resolution are per-visit, so "what happened on 3 March" stays answerable
after four more visits. The complaint keeps a pointer to the latest submission.

**Timeline is a collection, not an array.** A reopened complaint's timeline
grows without bound and MongoDB documents cap at 16MB. Paginating a collection
is also far easier than paginating a subdocument array.

### What the tests actually prove

The referential-integrity plugin is the foreign-key substitute, so it was
verified rather than assumed:

- a reference to a non-existent document is rejected
- a `refActive` reference to a *deactivated* document is rejected
- query-based updates (`findOneAndUpdate`) are checked, not just saves
- checks see uncommitted documents **inside the caller's transaction** - the
  subtle failure mode, where validating outside the session would reject valid
  writes
- an invalid reference rolls the whole transaction back
- errors name the offending field, so forms can highlight the input
- `passwordHash` is never returned unless explicitly selected
- `strict: 'throw'` rejects a typo'd field instead of storing it forever
- mobile numbers normalize, so `+91 98765-43210` and `9876543210` are one customer

### One flag relaxed

`exactOptionalPropertyTypes` is **off** in `server/tsconfig.json`. Mongoose's
type definitions are not written for it: `SchemaOptions` and `Schema<T>` stop
unifying and every model needs a cast. Casts around the schema layer would cost
more safety than the flag buys. Every other strict flag remains on.

---

## 10. Auth and RBAC complete and verified (2026-09-14)

71 tests passing across 6 files. Endpoints: `POST /auth/login`,
`POST /auth/refresh`, `POST /auth/change-password`, `GET /auth/me`.

### Security properties built in, and why

**A token proves who you are; the database decides what you may do.**
`authenticate` re-reads role, scope and active status from the user record on
every request rather than trusting the token's claims. Without this, an Owner
moved to another center would keep reaching the old one until their token
expired, and a technician deactivated mid-shift (section 9) would keep working
their queue for another fifteen minutes.

**No user enumeration.** A wrong password and an unknown mobile number return
the same status, the same message, and - via `dummyVerify` - roughly the same
response time. Any of the three differing would let someone map which staff
numbers have accounts. Verified live: both return
`{"code":"UNAUTHENTICATED","message":"Mobile number or password is incorrect"}`.

**Two-layer throttling.** Per-IP via `express-rate-limit`, and per-account via
`failedLoginAttempts` / `lockedUntil` on the user record. The per-account layer
is the one section 19 actually requires - an attacker rotating IP addresses
walks straight through the per-IP limit.

**Access and refresh tokens use different secrets**, and carry a `kind` claim
that is checked on verification. Both token types hold the same claims, so
without that check a 30-day refresh token would work as a 15-minute access
token. Verified: using one as the other returns 401.

**Password change revokes existing sessions** via `passwordChangedAt`. Tokens
issued at or before that instant are refused by both the middleware and the
refresh endpoint. Without it, changing a password *because it was compromised*
would leave the attacker's refresh token valid for its full thirty days.

**Opportunistic rehashing.** Login is the only moment the plaintext password
exists, so raising the scrypt cost later is applied gradually as people sign in
rather than by a mass reset. `needsRehash` drives it.

### Scoping is centralized, and cannot be overridden

`src/core/scope.ts` is the single place query scoping is expressed. Scopes
combine with caller filters using `$and`, never a spread:

```ts
{ ...scope, ...callerFilter }   // WRONG - callerFilter overwrites the scope
withScope(scope, callerFilter)  // $and - the scope always survives
```

With a spread merge, a request supplying its own `serviceCenterId` would decide
which center's data came back. There is a test asserting the `$and` form
specifically.

`partStockScope` returns `null` for a Technician, which is deliberately
distinct from `{}`: no business with the collection at all, versus unrestricted
access to it. Conflating them would hand a technician every center's inventory.

### Password policy

Length-led (12 character minimum), not composition-led. Mandatory symbol
classes push people toward `Password1!`; length is the property that resists
guessing. Login itself accepts any non-empty string - applying the policy at
login would reveal the policy and lock out accounts whose password predates a
policy change.

### Test isolation problem found and fixed

The per-IP limiter's in-memory store is shared across every request in a test
file, so the auth suite exhausted the production ceiling of 20 partway through
and five later tests failed on unrelated 429s. Fixed by raising the ceiling for
the suite (`vitest.config.ts`) and giving `authRateLimit.test.ts` its own
per-test client addresses via `X-Forwarded-For`, which the app honours because
`trust proxy` is set. That also made the limiter's per-address behaviour
directly testable rather than merely disabled.

### Seed script

`npm run seed --workspace server -- --demo` creates the section 14 SLA rules,
a first Admin, and optionally a full demo world. Idempotent - existing records
are left alone, so re-running never clobbers a password in use.

Generated passwords are printed **once** and are not recoverable, since only
scrypt hashes are stored.

---

## 11. Status machine complete and verified (2026-09-15)

98 tests passing across 7 files. The twelve statuses from spec section 7, with
transitions declared in one table at `server/src/core/statusMachine.ts`.

### Why a table rather than checks scattered across routes

Section 7 requires transitions "validated by backend rules and role
permissions". Expressed as a declarative table, the answer to "can a technician
close a complaint?" is one lookup instead of an audit of every route - and a
prohibition is enforced by the *absence* of a rule, which cannot be forgotten
the way an `if` can.

### Section 22's prohibitions, now enforced rather than documented

| Spec section 22 says | How it holds |
|---|---|
| "Technician attempts to close -> Backend rejects" | No rule to `CLOSED` lists `TECHNICIAN` |
| "Service Center attempts final closure -> Backend rejects" | No rule to `CLOSED` lists `SERVICE_CENTER_OWNER` |
| "Happy Code mismatch -> Admin cannot close" | The only rule to `CLOSED` carries `requires: ['HAPPY_CODE_VERIFIED']` |
| "Resolution rejected -> store rejection reason" | That rule sets `requiresReason: true` |

There is a test asserting the central invariant directly: **exactly one**
transition reaches `CLOSED`, it comes from `ADMIN_CONFIRMATION`, its role list
is `['ADMIN']` alone, and it requires a verified Happy Code. Section 28's
"final closure authority always remains with Admin" is that single assertion.

Accepting a resolution deliberately lands on `ADMIN_CONFIRMATION`, never
`CLOSED` - which is what stops an Owner short-cutting the customer confirmation
step entirely.

### Three failure modes, three messages

A refused transition distinguishes:

1. the move does not exist in the lifecycle (409)
2. it exists, but not for this role (403)
3. it is permitted, but the complaint is not ready (409)

Collapsing these into one "forbidden" would leave an Admin unable to tell a
permissions problem from an unverified Happy Code - two situations with
completely different remedies.

### Addition beyond the spec: CANCELLED -> REOPENED

The spec describes reopening a **closed** complaint (section 13, Workflow G)
but says nothing about a cancelled one. Without a path back, a complaint
cancelled by mistake would be unrecoverable, and the only remedy would be
raising a duplicate - which fights rule 15 ("old complaints must never be
overwritten") and section 13's insistence on one continuous service history per
customer and serial number.

Admin only, mandatory reason, fully audited. Flagged here because it is an
addition, not something the document asked for - say if you would rather a
cancellation were final.

### Reassignment is not a transition

Moving a complaint to a different technician within `TECHNICIAN_ASSIGNED` does
not change its status, so it is an operation with its own permission check
rather than an entry in this table. Moving it to a different *service center*
does drop it back to `ASSIGNED`, because the new centre has its own technicians
and the previous assignment cannot carry over (section 8).

### Table integrity is tested, not assumed

- no non-terminal status is stranded without a way out
- both terminal statuses have a recovery path
- every status referenced exists in the spec's list
- `availableTransitions` (which will drive the UI's action list) never offers
  anything `assertTransition` would then refuse - otherwise the UI would show
  buttons that fail on click

---

## 12. Complaint creation complete and verified (2026-09-15)

140 tests across 9 files. Endpoints: `POST /complaints`, `GET /complaints`,
`GET /complaints/:id`, `GET /complaints/recommendations`,
`GET /complaints/:id/whatsapp`.

Verified live: `CMP-2026-000001` created, status `NEW`, SLA computed at exactly
4h response / 24h resolution for HIGH priority, Happy Code issued, WhatsApp
deep link built, encrypted secret absent from the response.

### Creation is one transaction

Minting the number, writing the complaint and appending the first timeline
entry commit together or not at all. Without it:

- a failed insert after a successful counter `$inc` burns a complaint number,
  leaving a gap auditors read as "one is missing";
- a complaint could exist with no `COMPLAINT_CREATED` entry, which section 17
  requires and which is the only record of who raised it.

Tested by forcing a mid-transaction failure and asserting that neither the
complaint nor an orphan timeline entry survives.

### Happy Code exposure is deliberately narrow

The plaintext is returned **once**, in the creation response, so Admin can act
immediately (Workflow A step 14) without a second round trip. After that the
only way to read it is `GET /complaints/:id/whatsapp`, which is Admin-only and
writes both a timeline entry and an audit record every time it is called.

`happyCodeSecret` is `select: false` *and* deleted explicitly in the response
serialiser. The belt-and-braces is intentional: a future query adding
`.select('+happyCodeSecret')` for an unrelated reason must not silently turn
the list endpoint into a leak.

### Recommendations rank, they never decide

Section 8 says "Never automatically assign" and "Admin must manually select".
`recommendServiceCenters` returns an ordered list with a reason on each entry,
and the response carries `manualSelectionRequired: true` so no client can
mistake the top entry for an assignment. Ranking is pincode (100) > serves-city
(70) > located-in-city (60) > same-territory (30).

`LOCATED_IN_CITY` is not in the spec's list. It exists because a centre's
coverage arrays will be empty for most records early on, and without it a
perfectly obvious local centre would rank as no match at all.

When nothing matches, every active centre is returned with
`fellBackToAll: true` - the section 22 requirement.

### Out-of-scope reads return 404, not 403

Asking for another centre's complaint by id gives "not found". A 403 would
confirm the complaint exists, letting one service centre probe another's
workload by iterating identifiers.

### Inline customers attach to an existing mobile number

Creating a complaint with a new customer whose mobile is already on file
reuses that record rather than failing or duplicating. Section 13's repeat
complaint history is keyed on the mobile number, so a duplicate would split a
customer's history in two - and the Admin is on the phone to someone and should
not be blocked by a record the create form did not show them.

### Known gap: nothing assigns a service center yet

A `NEW` complaint currently offers Admin only "Cancel", because
`NEW -> ASSIGNED` requires a service center to be set and no endpoint sets one.
Assignment must update the field and make the transition in a single
transaction, so it lands with the status-transition routes in the next phase.
Creating a complaint *with* `serviceCenterId` already works and starts at
`ASSIGNED`.

---

## 13. Workflow transitions complete and verified (2026-09-15)

158 tests across 10 files. The complaint lifecycle now runs end to end.

### Endpoints (spec section 20)

| Route | Role | Workflow |
|---|---|---|
| `POST /complaints/:id/assign-service-center` | Admin | A step 10, section 8 |
| `POST /complaints/:id/assign-technician` | Owner | B |
| `POST /complaints/:id/visits` | Owner | B, section 9 |
| `POST /complaints/:id/start-visit` | Technician | C step 3 |
| `POST /complaints/:id/resolution` | Technician | C step 10 |
| `POST /complaints/:id/review-resolution` | Owner | E |
| `POST /complaints/:id/waiting-for-parts` | Owner, Technician | D |
| `POST /complaints/:id/resume-work` | Owner, Technician | D |
| `POST /complaints/:id/verify-happy-code` | Admin | F steps 5-7 |
| `POST /complaints/:id/regenerate-happy-code` | Admin | - |
| `POST /complaints/:id/close` | Admin | F |
| `POST /complaints/:id/reopen` | Admin | G |
| `POST /complaints/:id/cancel` | Admin | - |

There is deliberately **no close route for Owner or Technician**. Section 3.2
and 3.3 remove that power, and an absent route cannot be reached by mistake.

### Transitions validate the outcome, not the starting point

Assigning a service center is simultaneously "set this field" and "move NEW to
ASSIGNED", while the transition's own precondition is that the field is set.
Validating the *current* state would therefore reject every first assignment.
The service builds the state the complaint *would* have and asks the machine
about that.

### Every operation is one transaction

Status change, field updates and timeline entries commit together. A status
change that lands without its timeline entry is an unexplained change in the
record, which section 17 does not permit. Tested by attempting an illegal
transition and asserting both the status and the timeline are untouched.

### Gap found and fixed: reassignment stranded a scheduled visit

Reassigning a technician while a visit was `SCHEDULED` left the visit owned by
the previous technician - who could no longer see the complaint at all - while
the new technician was refused for trying to start someone else's visit. The
Owner would have had to cancel the visit and schedule another to get moving.

`assignTechnician` now moves a pending visit to the new technician. Only
`SCHEDULED` visits move: one in progress or completed is the record of what the
previous technician actually did, and section 22 requires that to survive.

### Out-of-scope is 404 everywhere, including transitions

A technician attempting an action on a complaint that is not theirs gets "not
found", not "forbidden". A 403 would confirm the complaint exists and let one
technician probe a colleague's workload by iterating identifiers. This applies
uniformly - reads and writes alike.

### A wrong Happy Code is 200, not an error

`verify-happy-code` returns `200 {"verified": false, "attemptsRemaining": 4}`.
Misreading a code over the phone is an expected outcome of a phone call, not a
fault, and the remaining count lets Admin see the lock coming. The sixth
attempt returns 423 and `regenerate-happy-code` is the recovery.

### Reopen issues a fresh code and a fresh clock

Reusing the old Happy Code would let a customer close a reopened complaint with
a code they were given for work that evidently did not hold. Reusing the old
SLA clock would show the complaint as breached from the instant it reopened.
Both are replaced; the previous closure is appended to `closureHistory` rather
than overwritten (rule 16, section 22).

---

## 14. Parts and inventory complete and verified (2026-09-15)

177 tests across 11 files.

### Endpoints

| Route | Role |
|---|---|
| `GET /parts` | all (the technician's picker needs it) |
| `POST /parts`, `PATCH /parts/:id` | Admin |
| `GET /parts/stock/list` | Admin, Owner |
| `PUT /parts/stock`, `POST /parts/stock/adjust` | Admin, Owner |
| `POST /complaints/:id/part-requests` | Technician |
| `GET /parts/requests/list` | all (scoped) |
| `POST /parts/requests/:id/decide` | Owner |
| `POST /complaints/:id/part-usage` | Technician |
| `POST /parts/usage/:id/finalize` | Admin, Owner |

### The conditional decrement

Section 11's "stock is decremented only when usage is finalized according to
backend transaction rules" is implemented as an atomic conditional update:

```ts
findOneAndUpdate(
  { _id, availableQuantity: { $gte: quantity } },
  { $inc: { availableQuantity: -quantity } },
)
```

Reading the quantity, checking it in JavaScript and then writing would let two
concurrent finalisations both pass the check and drive stock negative. Folding
the check into the *filter* makes MongoDB decide atomically - a second caller
matches nothing and is told the stock is insufficient.

**Tested directly:** ten concurrent finalisations of 1 against a stock of 6.
Exactly six return 200, four return 409, and the final count is 0. Not -4.

### A consequence of the spec worth naming

Between *issuing* a part and *finalising* its usage, the parts are physically
out of the store but still counted in stock. That is what section 11 asks for,
and it is defensible: a technician issued three and fitting one should not
consume three.

If the company would rather stock reflect what has physically left the
building, that is a change to *when* the decrement fires, not to this
structure. The API says so in its response to an issue decision, so nobody has
to guess why the number did not move.

### Low stock stays derived

`lowOnly=true` filters with `$expr: { $lte: ['$availableQuantity', '$minimumStock'] }`
rather than reading a stored flag, which would drift the moment a quantity
changed without it being updated.

### Separation of duty on finalisation

A technician records what they fitted; an Owner or Admin finalises it against
inventory. One person doing both removes the check entirely, so
`POST /parts/usage/:id/finalize` refuses a technician even for their own
record.

### `setStock` versus `adjustStock`

Two operations because "we received 20 more" and "the true count is 20" are
different claims. `adjustStock` uses `$inc`, so two people recording separate
deliveries at the same moment both land; two absolute writes would silently
discard one. `setStock` remains for a physical stocktake, where an absolute
figure is the point.

### Fixture gap found

`seedWorld()` created no parts - only the demo seed script did - so every parts
test failed on a null lookup. Parts are now part of the fixture. Stock levels
deliberately are **not**: each test sets its own, so the quantities its
assertions depend on are stated locally rather than inherited from a shared
number a later edit could change.

---

## 15. Master data complete and verified (2026-09-15)

197 tests across 12 files. The system can now be operated entirely through the
API - before this, the only way data entered it was the seed script.

### New endpoints

**Users** (`/users`): create, list, get, update, reset-password.
**Masters** (root-mounted): `/territories`, `/cities`, `/service-centers`,
`/products`, `/product-models`, `/customers`, plus
`/customers/:id/history` and `/serial-history/:serialNumber` for section 13.

### Who may create whom

Expressed once, as a table in `users.service.ts`:

| Caller | May create |
|---|---|
| Admin | Admin, Service Center Owner, Technician |
| Service Center Owner | Technician (own center only) |
| Technician | nobody |

An Owner's technician is attached to the Owner's own center without the
request naming it, so there is nothing to spoof. Section 3.2 grants exactly
that one creation power, and the allow-list shape means widening it later is a
visible, deliberate edit.

### Deactivation reports what it stranded

Both cases the spec calls out are now actionable rather than something to
discover later:

- **Technician** (section 9): deactivation returns the open jobs still assigned
  to them, with a warning that they need reassigning.
- **Service center** (section 8): the same, for open complaints.

History is untouched in both cases - only access and new work stop.

### Customer mobile numbers cannot be changed

It is the customer's identity: section 13's repeat-complaint history is keyed
on it, and it is snapshotted onto every complaint. Changing it would split one
person's history in two.

The update schema is a `strictObject` rather than simply omitting the field.
Zod strips unknown keys by default, so a request asking to change `mobile`
would otherwise parse to `{}` and return **200 reporting success for a change
that never happened**. Strict mode rejects it, and catches field-name typos as
a bonus.

### Bug found: password change locked users out, intermittently

The revocation check compared the JWT `iat` claim against `passwordChangedAt`.
Both are second-resolution, so changing a password and signing straight back in
produced a token stamped in the *same second* as the change - which the check
read as a pre-change token and refused.

Neither `<` nor `<=` fixes this: one locks out legitimate re-logins, the other
honours genuinely revoked tokens. Which one bit depended on whether the two
calls happened to straddle a second boundary, so it failed **intermittently**
in production and passed in tests by luck of scrypt's timing.

Tokens now carry an `ims` claim with millisecond issue time, and revocation
compares that. A token issued 200ms after a change is honoured; one issued
200ms before is refused. `verifyToken` falls back to `iat * 1000` for tokens
minted before the claim existed, so a deploy does not sign everyone out.

This is exactly the class of bug that only surfaces under real timing - worth
noting that it was found by a master-data test, not an auth one.

---

## 16. API response shape normalised (2026-09-15)

Found by running the server rather than by a test.

### The inconsistency

`baseSchemaOptions.toJSON` maps `_id` to `id` and strips `__v`, so anything
serialised from a Mongoose *document* came out clean. But `.lean()` skips
document hydration for speed, and with it that transform. The result:

| Endpoint style | Returned |
|---|---|
| create (hydrated document) | `id`, no `__v` |
| list (`.lean()`) | `_id`, **and `__v` leaked** |

Same resource, two shapes, depending on which query style the handler happened
to use. Any client moving between a list and a detail view would break, and
fixing it per-query would make every future `.lean()` a chance to reintroduce
it.

### The fix

`src/http/normalizeResponse.ts` wraps `res.json` once, mounted before the
routers, so it covers handlers written later without anyone remembering it:

- `_id` becomes `id`, as a string
- `__v` is dropped
- nested ObjectIds are stringified rather than emitted as buffer objects

**Order of checks matters.** The first version walked objects directly, which
broke hydrated documents: a Mongoose document's enumerable keys are internals
(`$__`, `_doc`, `$isNew`), not its fields, so the response came back as
serialisation machinery. Anything defining its own `toJSON` now runs that
first, and ObjectId / Date / Buffer are handled before that check since all
three define `toJSON` too.

### Why the tests did not catch it

They would have caught the second bug - supertest goes through `res.json` -
but not the first. The original inconsistency was invisible because tests
asserted on *values* (`res.body.complaint.id`) via helpers that happened to use
whichever shape that endpoint produced. Nothing compared two endpoints against
each other.

Worth remembering: a test suite that passes says the behaviour each test
describes is correct, not that the API is coherent across endpoints.

---

## 17. Attachments complete and verified (2026-09-15)

222 tests across 14 files. Verified on a live server, not only through supertest.

### Endpoints

| Route | Role |
|---|---|
| `POST /complaints/:id/attachments` | Technician (own job), Admin |
| `GET /complaints/:id/attachments` | all (scoped) |
| `GET /attachments/:id/file` | all (scoped, re-checked) |

### File type is decided by contents, not by the client's claim

Section 19 requires file type validation. A browser-supplied MIME type is a
*claim* - anything can be uploaded as `image/jpeg` - so the accepted types are
identified by their leading bytes: JPEG, PNG, WEBP and MP4.

Verified live: a shell script sent as `image/jpeg` is refused.

The declared type is still checked first by multer's `fileFilter`, but only to
avoid buffering something obviously wrong. The magic-byte check is the
authority.

HEIC is deliberately **not** accepted. iPhones produce it by default, but
nothing in the admin or centre portals can display it, so accepting it would
create attachments nobody can look at.

### Nothing is publicly reachable

Section 19: "Not be publicly accessible by default." There is no static
serving. Every byte goes through a handler that loads the attachment within
the caller's attachment scope **and** its parent complaint within the caller's
complaint scope. Both checks matter: one decides whether they may see the file,
the other whether they may see the job it belongs to.

Storage keys are generated UUIDs under the complaint's own folder, never
derived from the uploaded filename - which is kept as metadata only. The local
driver additionally refuses any key that resolves outside the storage root.

Download responses carry `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
Without the first two, a crafted upload rendered inline becomes stored XSS
against whoever opens it; without the third, customer premises photos could sit
in a proxy cache.

### Identical bytes are one attachment

A re-upload of the same content returns the existing record with 200 rather
than creating a second row. Field apps retry on a bad signal, and a technician
tapping upload twice should not produce two copies of one photo.

### Write ordering

Bytes first, then the database row; if the row fails, the bytes are removed.
The reverse would risk a row pointing at a file that was never written - a
broken image with no way to tell whether the photo was lost or never taken.

### Test pollution found

Earlier attachment runs wrote 11 real files into `server/storage/`. The cause:
`config/env.ts` parses the environment when first imported, which happens
before any test body runs - so `process.env.STORAGE_LOCAL_PATH` set inside a
spec arrived too late. It is set in `vitest.config.ts` now, alongside
`MONGO_URI`, and the leaked files were removed.

### A test that was asserting the wrong thing

The path-traversal test tried to upload a file named `../../../etc/passwd.jpg`
and assert the stored key was safe. It failed because multipart encoders strip
directory components before the request is even sent - the traversing name
never reached the server, so the test proved nothing about the defence.

Traversal is now tested directly against the storage driver, where a key can
actually be constructed, and the HTTP test asserts the narrower thing it can
genuinely observe: the key is generated rather than derived.

---

## 18. Timeline, visits and SLA settings (2026-09-15)

249 tests across 15 files, 72 endpoints. Verified on a live server.

### New endpoints

| Route | Role | Spec |
|---|---|---|
| `GET /complaints/:id/timeline` | all (scoped) | 17 |
| `GET /audit` | Admin | 17 |
| `GET /visits` | all (scoped) | 9 |
| `GET /visits/my-jobs` | Technician | 10 |
| `GET /visits/:id` | all (scoped) | 9 |
| `POST /visits/:id/reschedule` | Owner, Admin | 9 |
| `POST /visits/:id/cancel` | Owner, Admin | 9 |
| `GET /sla-rules` | all | 14 |
| `PATCH /sla-rules/:priority` | Admin | 14 |

### Timeline reads forwards; the audit log reads backwards

The complaint timeline is sorted **oldest first** - it is read as a story, and
section 17 asks for it "as a clear chronological timeline". The system audit
log is **newest first**, because it is read to answer "what just happened" or
"who changed that", which is a search backwards from now.

The audit log is Admin-only. It spans every service center, so there is no
sensible per-centre scoping of it, and showing it to an Owner would leak other
centres' activity.

### Visit cards carry their complaint inline

A job card needs the customer, address, product and serial number. Returning
only IDs would mean a phone on a patchy connection making five extra round
trips to render one screen, so the complaint context is denormalised into each
card.

`my-jobs` returns every bucket section 10 lists - today, upcoming, in progress,
revisit required, completed - in **one** response for the same reason.

`revisitRequired` is drawn from complaints rather than visits, because it is a
complaint state: the work has been sent back but the Owner has not scheduled
the return trip yet. Without it a technician would be surprised by a job
appearing tomorrow.

### Only a scheduled visit can move

Rescheduling or cancelling is refused once a visit is in progress or complete.
That visit is the record of what actually happened, and section 22 requires it
to survive - a later trip is a **new** visit, not an edit of the old one.
Previous times are kept in `rescheduleHistory` so the calendar's history stays
auditable.

### SLA changes are not retroactive

Each complaint stores its own due dates at creation, so editing a rule affects
only complaints created afterwards. Tightening the policy must not retroactively
breach work that was delivered on time under the old one - an SLA report that
rewrites its own history is worthless. There is a test asserting an existing
complaint's `resolutionDueAt` is unchanged by an edit.

Windows are accepted in **hours** (how section 14 writes them) and stored in
**minutes**, so a sub-hour target is a data change rather than a migration.
Verified: `responseHours: 0.5` stores as 30 minutes.

---

## 19. Reports and dashboards complete (2026-09-15)

273 tests across 16 files, 74 endpoints. Verified live, including a real xlsx
download.

### Endpoints

| Route | Role |
|---|---|
| `GET /dashboard` | Admin, Owner (scoped) |
| `GET /reports/:kind?format=json\|csv\|xlsx` | Admin, Owner (scoped) |

Five reports, matching section 16's five headings: `complaints`,
`service-centers`, `technicians`, `products`, `parts`.

### Spreadsheet formula injection - the reason `export.service.ts` exists

A CSV cell beginning `=`, `+`, `-`, `@`, tab or carriage return is executed by
Excel and Google Sheets as a **formula**. Every field in these reports is user
input: customer names, addresses, complaint descriptions, technician notes. A
customer named `=cmd|'/c calc'!A1` becomes a working payload the moment someone
opens the export.

`safeCell` prefixes any such value with an apostrophe, which spreadsheets read
as "treat as text". Applied to the **Excel path too**, not just CSV - the
vulnerability is in the spreadsheet application, not the file format.

An export feature is the easiest place in a CRM to hand someone a live payload
without noticing, so it is tested directly: seven payload shapes at the unit
level, plus an end-to-end test that creates a customer whose name is a formula
and asserts nothing in the produced file starts a cell with a bare `=`.

### Export lives on the report route, not a separate one

`?format=csv` rather than `/reports/complaints/export`. A separate endpoint
would be a second code path that could drift, and then the spreadsheet would
quietly disagree with the screen it was downloaded from.

Exported files carry the filters that produced them and who generated them, so
a saved file still explains itself weeks later. CSV is written with a BOM so
Excel reads UTF-8 rather than mangling a non-ASCII name.

### One aggregation, not eleven queries

The dashboard serves ten KPI cards (section 5.1), nine breakdowns and six
operational panels (section 9) from a single `$facet` pipeline. A landing
screen that fires a dozen round trips is how a dashboard ends up feeling slow,
and every panel counts the same collection.

Reports use aggregation pipelines for the same reason: a report over a year of
complaints would otherwise pull every document into memory to produce twenty
rows.

### Scope applies to reports too

Section 3.2 restricts an Owner to their own centre, and a report is not an
exception - "service centre performance" for an Owner means *their* centre, not
a league table of everyone else's. Scope and filters combine with `$and`, so a
caller supplying another centre's id narrows to nothing rather than widening.

A technician gets neither reports nor the dashboard. Section 10 gives them a
work queue, not a management view, and the 403 message points at
`/visits/my-jobs` rather than just refusing.

### Products report counts units, not just complaints

Section 16 asks for "repeat issue patterns". Three complaints across two serial
numbers is a different signal from three complaints on one unit, so the report
carries `affectedUnits` and `complaintsPerUnit` alongside the raw count.

### Backend feature-complete against section 24

All eight checklist groups now pass, including Reports and Audit. What remains
is the section 25 Phase 8 hardening pass, not new features.

---

## 20. Hardening pass complete (spec section 25 Phase 8) — 2026-09-15

304 tests across 19 files. Backend complete.

### The missing script is written

`check:integrity` had been referenced in `package.json` since the first day and
never existed. It now does: `server/src/scripts/check-integrity.ts`.

It exists because the `referentialIntegrityPlugin` can only guard writes that
went *through* it. A document inserted by a migration, a `mongosh` session, a
restore from an older backup, or a code path written before a rule existed has
never been validated. In a relational database the constraint would have caught
all of those.

Seven checks: dangling references (driven from `refRegistry`, so a new `ref` is
swept automatically), negative stock, duplicate and malformed complaint
numbers, **counter lag** — a counter behind the highest issued number means the
next complaint collides — role/scope invariants, complaint state coherence,
visit/complaint agreement, and SLA configuration.

Read-only. It reports and exits non-zero; it never repairs, because the right
repair depends on which side is wrong.

**Proved to have teeth.** Five faults were planted in the test database - an
orphaned city, negative stock, an Admin wrongly scoped to a centre, a duplicate
complaint number, and a complaint CLOSED with no verified Happy Code. It caught
all five plus their consequences, 19 errors in total, and exited 1. A check
that only ever says "ok" is worthless.

### Every route is proved to refuse an unauthenticated caller

`tests/security/routeAudit.test.ts` reads the whole API surface out of the
source, then **calls each of the 74 routes** with no token and with a forged
token, asserting both are refused. Four routes are public by design and listed
with their reasons.

The failure this prevents is not a broken check but a missing one: a route
mounted without `authenticate` passes every other test in the suite, because no
test knows to look for it.

Routes are read from source rather than introspected because Express 5 compiles
a mount path into a `matchers` array and keeps no literal `path` on the layer,
so a router's prefix cannot be recovered reliably from the router tree. I tried
that first and it produced `POST /login` instead of `POST /auth/login`.

It also sweeps sixteen read endpoints for `passwordHash`, `happyCodeSecret`,
`ciphertext`, `authTag`, `__v` and raw `_id` — verifying the mechanisms rather
than trusting them.

### Indexes are proved to be used, not merely declared

`tests/security/indexUsage.test.ts` runs `explain()` on thirteen real query
shapes and asserts the planner chose `IXSCAN`, not `COLLSCAN`.

A hot query with no index works perfectly on a seeded database and degrades
quietly as data grows, which is the worst failure shape: it passes every test
and appears months later. Covered: complaint number, serial-number history,
customer-mobile history, the centre queue, the technician job list, dashboard
counts, the SLA breach sweep, report filters, login by mobile, the centre
calendar, and the stock row the transactional decrement locks.

The unique constraints that matter are asserted directly: complaint number,
user mobile, and stock per centre+part.

### Section 22 edge cases: three gaps closed

A coverage sweep found three of section 22's cases untested, all about the
system continuing to work when something *outside* it is broken:

- **Invalid or missing customer phone** — the WhatsApp action reports
  `available: false` with a reason, hands out no Happy Code, still records the
  view, and works again once corrected.
- **WhatsApp unavailable** — a complaint whose link never worked is driven all
  the way to CLOSED via a regenerated code read out over the phone. This is the
  scenario the encryption decision (section 4.2) exists for; with a hashed code
  it would be uncloseable.
- **Customer unavailable** — the outcome is recorded on the visit, a second
  visit is scheduled rather than a resolution invented, and the wasted trip
  stays on the record.

### Bug found: an audit write could fail on unrelated legacy data

Viewing the WhatsApp link stamped `happyCode.lastViewedAt` with `save()`, which
re-validates the **whole document**. A complaint carrying imported data that no
longer passes validation — a customer snapshot with no mobile number — failed on
a field the operation never touched, so recording an audit stamp took down the
request.

Now an `updateOne` on the two fields it actually changes. Stamping an audit
field must not be able to fail because of something unrelated, and it also
stops two concurrent views overwriting each other's view of the document.

### Two of my own tests were time-dependent

Two tests scheduled a visit at `now + 2h` and asserted it fell in "today".
After 21:00 that lands tomorrow, so they failed for reasons unrelated to the
code — and passed every earlier run purely because the suite had been run
during the day. Both now pin an explicit hour today.

Worth recording as a pattern: a relative time offset is only safe in a test
when the assertion does not depend on a calendar boundary.

---

## 21. Frontend: Admin portal, first slice (2026-09-16)

Built and verified in a real browser: login, the Admin shell with all thirteen
section 4 destinations, the section 5.1 dashboard, the complaint list, complaint
detail with assignment / Happy Code / closure / reopen / cancel, and complaint
creation. The remaining Admin screens route to an honest placeholder rather than
dead links.

### Stack

React 19, Vite 7, TypeScript (strict, same flags as the server), Tailwind 4,
TanStack Query, React Router 7. No component library — the UI primitives are
small and owned, so they follow section 21's design rules exactly rather than a
library's defaults.

### The API is reached through `/api`, proxied by Vite

One origin in the browser means no CORS to configure, and production will serve
both behind one reverse proxy — so the client code written against `/api` is the
code that ships. The proxy targets `127.0.0.1`, not `localhost`, for the IPv6
reason recorded in the README.

### Token storage — a trade-off worth knowing

The server returns tokens in the response body rather than as httpOnly cookies,
so the client keeps them in `localStorage` to survive a reload. A script running
on this origin could read them. Acceptable for an internal staff tool served
from our own origin with no third-party scripts and a fifteen-minute access
token. **If this ever becomes customer-facing, move to httpOnly cookies.**

A refresh already in flight is shared, so an expiry does not fire one refresh
per waiting request.

### The server decides what actions exist

The detail page never works out for itself which actions a complaint allows. It
renders `nextActions` from the server, produced by the same status machine that
enforces the rule on write. A button the server would refuse is never shown, and
if the two ever disagreed the server would still win.

### Charts were chosen by rule, and the colours were computed

Using the data-visualisation method rather than taste:

- Twelve statuses are a **labelled bar list in one hue**, not a twelve-colour
  donut — more than about seven colour classes stop being distinguishable.
- Warranty and repeat rate are **meters**; a two-slice pie is a harder way to
  read one percentage.
- Bars are thin, square at the baseline and rounded at the data end; values sit
  in text ink, never the bar colour; every value is visible without hovering.

The palette validator was **run**, not reasoned about, and it changed the design:

| Candidate | Result |
|---|---|
| Brand teal as the single bar hue | all checks pass |
| SLA "met" in **green** beside "breached" in red | **FAIL** — colour-blind separation ΔE 4.1 (deutan) |
| SLA "met" in **teal** beside red | pass, ΔE 11.0 |
| "Paused" in mid slate beside teal | **FAIL** — normal-vision ΔE 11.0, below 15 even for full colour vision |
| "Paused" in light slate | colour-blind ΔE 23.9 and normal-vision ΔE 28.6, both pass |

Green beside red would have made "SLA met" and "SLA breached" look identical to
roughly one man in twenty, in the one chart where that distinction matters most.
Both colours look obviously different to a person with typical colour vision,
which is exactly why this has to be computed.

"Paused" also moved off warning yellow for a semantic reason: a paused clock is
not a warning, it is simply not counting. Its light neutral falls below 3:1
against white, so every SLA segment carries an icon, a label and its count — a
colour that weak never carries meaning alone.

### Looking at it found what typecheck could not

Every screen was rendered and inspected, not only compiled:

- **SLA legend truncated to "O… / P… / B…"** in a one-third-width card. Moved
  from three columns to a vertical list, which cannot truncate.
- **Complaint numbers wrapped across three lines** on a narrow screen, because
  the table crushed its columns. It now has a minimum width and scrolls
  sideways, so the one thing people scan for stays on one line.
- A suspected accessibility fault turned out not to be one: the browser tool
  displayed placeholders, but checking the DOM showed every input correctly
  associated with its label. Verified rather than "fixed".

### Bug found through the UI: a wrong centre could not be corrected

Clicking through Assign showed there was no way to change a centre chosen by
mistake. ASSIGNED -> ASSIGNED is not a transition, so the server refused with
409 "already assigned", and the only escape was cancelling the whole complaint.

A failing test was written first to confirm it (409, as predicted), then fixed:
changing the centre while still ASSIGNED is handled as an operation rather than
a transition — Admin only, reason required, timeline entry — the same shape as
reassigning a technician within a status. The UI offers it explicitly, since it
never appears in `nextActions`. 306 backend tests pass.

### Section 13 is surfaced before a duplicate can exist

Creating a complaint shows the customer's previous complaints as soon as they
are picked, and warns — with the panel turning amber — when the serial number
has been serviced before, pointing at reopening instead. Section 13 asks for a
human reopen-vs-new decision with no automatic duplicate detection, and that
decision is worthless if the history only appears after the duplicate is made.

## 22. Frontend: Technician app (2026-09-16)

Built and verified at phone size (375 x 812) against the running API, signed in
as the seeded technician: My Jobs, job detail, the full visit flow, Schedule,
History, Profile, and the forced first-login password change. Installable as a
phone app (PWA).

### Screens

| Tab / screen | What it does |
|---|---|
| My Jobs | In progress first, then today (missed visits lead), sent back for revisit, upcoming |
| Job detail | Customer, address, product, warranty, unit history; **Call** and **Directions**; exactly one main button |
| Visit flow | Arrival -> Diagnosis -> Work done -> Parts -> Photos -> Result -> Review & submit |
| Schedule | Every booked visit grouped by day, missed visits first |
| History | Finished visits, newest *finished* first, each saying what it came to |
| Profile | Name, centre with a Call button, change password, sign out |

### Choices worth knowing

- **Availability is asked before the visit starts.** "Nobody is home" or
  "customer asked for another day" records the trip and ends it there. The
  technician is never walked into a diagnosis of a unit they did not see — and
  the server now refuses one (below). "Something else" offers both *Can't work*
  and *Start work*, because a neighbour with the key and a power cut go
  opposite ways.
- **Tap-to-add phrases** for common cooler faults, repairs and results (section
  21, "minimal typing"). The text stays editable.
- **The draft is saved on the phone as it is typed**, per complaint, and cleared
  only after the server accepts the resolution. A reload, a phone call or a
  mis-swipe loses nothing; tested with a full page reload mid-flow.
- **Photos are shrunk on the phone** to 1600px JPEG before upload (a 3000px
  test image went up as 108 KB). Re-encoding also strips EXIF, which on a phone
  photo includes the GPS position of the customer's home — section 22 rules out
  location tracking, and a photo quietly carrying it would be tracking by
  another route.
- **Directions** is one addition beyond section 10's list: it hands the address
  to the phone's maps app and sends nothing back.
- **The technician can never close a job.** The last step says so in plain
  words; there is no close button anywhere in the app.
- **Each portal is its own download.** The technician app loads about 15 KB
  gzipped on top of a 125 KB shared core, instead of the Admin portal's charts
  and tables as well.

### Installable, and honest when offline

`manifest.webmanifest`, icons (generated by `scripts/generate-icons.mjs`, no
image library) and a small service worker, registered in production builds only.

- **API responses are never cached.** They hold customer names, phones and
  addresses; a lost or shared phone must not keep a copy outside the session.
- The app itself is cached, so with no signal it still opens, the technician
  stays signed in and the saved draft is intact. Verified by building, loading
  the app, then stopping the server entirely and reloading.
- Old releases' files are cleared when a new release arrives — only then, since
  lazily loaded screens never appear in the HTML and would otherwise be thrown
  away on every page load (caught while testing the split bundles).
- Requests use `networkMode: 'always'`. The default *pauses* requests the
  browser thinks cannot succeed, with no data and no error — which the History
  and Schedule screens read as "nothing here". Found by testing offline: the
  job screen said "Something went wrong" with a `null` error. Screens now treat
  "no data and no error" as loading, never as empty.

Service workers need HTTPS or `127.0.0.1`, so installing on a real phone waits
for hosting (deferred, section 1 of the plan).

### Backend bugs found by building the app

Each was confirmed by a failing test before it was fixed. 327 backend tests pass.

1. **"Customer not home" left the visit open forever.** The complaint moved to
   IN_PROGRESS and so did the visit, so the app offered "Continue visit" — and
   the server would have accepted a resolution for a unit nobody saw. Now the
   visit ends at the door (COMPLETED, no resolution) when the customer is out or
   asks for another day. `endVisit` on start-visit states it explicitly for the
   cases between; ending with `CUSTOMER_AVAILABLE`, or with no reason, is
   refused.
2. **A follow-up visit never closed the one before it** (after waiting for
   parts, or a reschedule). Scheduling now closes any visit still in progress.
3. **Cancelling a complaint left its visit on the technician's list.** Open
   visits are now cancelled with it; completed ones are left untouched.
4. **A missed visit vanished at midnight.** "Today" was bounded at the start of
   the day, so an unstarted visit from yesterday was in no bucket at all. It now
   leads today's list, marked Missed.
5. **A reopened complaint could not go back to its own technician.** Reopening
   keeps the technician, and "assign technician" refused the same person as
   "already assigned" — a centre with one technician (like the seed data) had no
   way forward. Naming the same technician is now allowed when it moves the
   complaint on, and still refused as a no-op otherwise. Also verified against
   the running API.
6. **The technician report counted visits as resolutions.** `resolutionsSubmitted`
   was the completed-visit count; it now counts visits that carry a resolution.
7. **History read as shuffled.** It was ordered by booking time but shows
   finish time. `GET /visits` accepts `orderBy=completedAt`, backed by a new
   index that the index-usage test now covers.

`npm run check:integrity` gained a check for open visits on complaints that
have moved past them, so any data affected by bugs 1-3 is reported.

### Smaller things the browser found

- Vite listened on IPv6 `localhost` only, so the README's
  http://127.0.0.1:5173 refused to connect. Pinned to `127.0.0.1`.
- A cleared draft was immediately re-saved as an empty object, leaving a stub
  in the phone's storage for every finished job.
- `import.meta.env` had no type declarations (`src/vite-env.d.ts` added).

## 23. Frontend: Service Center portal (2026-09-17)

Built: all of section 4's Service Center navigation except Reports.

| Screen | What the Owner does there |
|---|---|
| Dashboard | Section 9's ten figures as tiles, plus three work queues — assign a technician, book a visit, review submitted work — and today's visits, technician workload, part requests and low stock |
| My Complaints | The shared list, with section 9's technician and visit-date columns and a technician filter. Flags jobs that say "in progress" but need rebooking |
| Complaint detail | Assign / reassign technician, book / reschedule / cancel visits, hold for parts, resume, review the technician's work (diagnosis, work, result, photos), confirm parts used, answer part requests |
| Visits / Schedule | A day-by-day agenda for the whole centre, who is on site now, missed visits |
| Technicians | Add, edit, activate / deactivate, reset password, workload per technician |
| Parts & Inventory | Request queue (approve, issue, unavailable, reject) with stock beside each request; stock list with Receive (delivery) and Set count (stocktake) |
| Profile | Own details, centre details, change password |

**Reports** still routes to a placeholder: the Admin Reports screen is not
built either, and both portals use the same report endpoints, so it is built
once for both.

### Shared with the Admin portal

The shell (`PortalLayout`), the complaint list (`ComplaintList`) and the reading
parts of a complaint (`ComplaintCards`: SLA, customer, product, description,
timeline) are now shared. Each portal adds only its own actions. The Admin
screens were re-checked in the browser after the move.

### Choices worth knowing

- **Reassign is hidden while a technician is on site.** The visit under way
  stays with them, and the new technician could never submit it — the same
  stranding as the bugs below. Hold for parts, or wait for the visit to end.
- **"Book another visit" from In progress only when nobody is on site** —
  booking closes any open visit (this file, section 22, bug 2), so it is only
  offered for the "nobody was home" case.
- **Parts are confirmed one line at a time** on the review card. Confirming is
  what deducts stock (section 11), so it is a deliberate act, not a side effect
  of accepting the work. Unconfirmed lines are called out.
- **Delivery and stocktake are separate buttons.** "We received 20" adds
  atomically and is safe when two people record deliveries at once; "there are
  20" replaces the count. The server already treated them differently.
- **Technician passwords are shown once**, with a copy button and a plain
  statement that nobody can look them up later.
- **Photos** need the session to load, which an `<img>` cannot send, so they
  are fetched with it and shown from an object URL.

### API additions (read models section 9 asks for)

- Complaint list rows carry `technicianName`, `currentVisit` and `lastVisit`.
- `status` accepts several values: `?status=ASSIGNED,REOPENED`.
- Part request rows carry the part, the complaint and who asked.
- Technician rows carry `workload` (open jobs, visits today).
- The dashboard counts `missedVisits`.

### Bugs found while building it

Each confirmed by a failing test first (`centerPortal.test.ts`,
`slaBreach.test.ts`). All backend tests pass.

1. **Cancelling a visit stranded the complaint.** It stayed VISIT_SCHEDULED
   with nothing booked, and booking again was refused as a no-op. Cancelling
   the only booked visit now returns the complaint to TECHNICIAN_ASSIGNED — a
   new, reason-required transition for Owner and Admin.
2. **`?includeInactive=false` and `?lowOnly=false` meant true.**
   `z.coerce.boolean()` is `Boolean("false")`, and any non-empty string is
   true. Now `z.stringbool()`, which also refuses nonsense like `perhaps`.
3. **SLA breaches were only recorded when someone opened that complaint.**
   There was no sweep, so dashboards counted only the breaches someone happened
   to open (Admin's showed 1 while 4 complaints were overdue). Breaches are now
   recorded in one indexed update before any dashboard or report counts them.
4. **A breached complaint lost its "overdue by" figure** — shown as "—", on
   exactly the complaints that matter most.
5. **Closing late erased the breach** if nobody had opened the complaint after
   its deadline. Closing now checks the deadline itself. Reports count
   complaints that ever breached, so late closures stay late.

### Checked in the browser, signed in as the Owner

Every screen was opened and the main actions were used on the local test
data: a part confirmed (Fan Motor stock 2 -> 1), work accepted (CMP-2026-000002
to Admin confirmation), a visit booked, cancelled (back to "technician
assigned" — bug 1 above, fixed) and booked again, then rescheduled to 11:30
(CMP-2026-000001), and a reopened job sent back to its original technician
(CMP-2026-000005). The dashboard's "SLA breached" read 3, matching the list.
No accounts were created or changed.

Fixed along the way:

- A photo that downloads but will not decode showed the browser's broken-image
  icon; it now shows a plain "could not be loaded" tile.
- Customer, phone and serial wrapped over two or three lines in the complaint
  list; cells no longer wrap and the table scrolls sideways instead.
- A cancelled visit and its replacement booked for the same slot listed in the
  wrong order; visit history now sorts by visit number (technician app too).
- The "Book another visit" button opened a dialog titled "Reschedule visit".
- The Technicians and Parts pages scrolled sideways as a whole page: the
  screen-reader-only "Actions" header was positioned against the page rather
  than its table. Button labels also no longer wrap.
- The earlier work shown on a reopened job is titled "Last submitted work", so
  it does not read as new work to review.

Not seen on screen: a part request row, because none exists in the local data
(only a technician can raise one). Its data is covered by
`centerPortal.test.ts`.

## 24. Admin record screens (2026-09-17)

The Admin portal's master data, which section 25 puts in Phase 2 and which
until now could only be changed through the API:

| Screen | What Admin does there |
|---|---|
| Customers | Search by name or mobile (on the server — there can be thousands), add, edit, deactivate, and read each customer's complaint history |
| Products | Products on one side, the selected product's models on the other; add, edit, deactivate either |
| Service Centers | Add and edit centres **with their coverage** (extra cities and pincodes section 8's recommendation matches on); deactivating lists the open complaints left to reassign |
| Technicians & Users | Every account — Technicians, Service Center Owners, Admins; add (temporary password shown once), edit, reset password, deactivate |
| Parts & Inventory | The company part list (add, edit, deactivate), and a read-only view of every centre's stock with low stock first |
| Territories / Cities | Both lists side by side; click a territory to see its cities |
| SLA | Response and resolution hours per priority, and whether the clock pauses; says plainly that changes apply to new complaints only |

Still to come on the Admin side: Visits / Schedule, Reports & MIS, Audit Log,
Settings.

### Choices worth knowing

- **Nothing is deleted.** Section 17 rules it out, so every "remove" is
  deactivation, always confirmed, always reversible, and worded to say what it
  does (e.g. a deactivated product cannot be chosen on new complaints but
  existing complaints keep it).
- **Codes are fixed once created** (territory, centre, product, model, part),
  and forms say so rather than offering a field the server ignores.
- **A customer's mobile cannot be edited** — it is the key to their complaint
  history (section 5.1). The form shows it read-only with the reason.
- **Small lists load whole, large ones page on the server.** Cities,
  territories, centres, products and parts are tens of rows and filter as you
  type; customers search and page on the server.
- **Your own account** cannot be reset or deactivated from the users screen;
  the server refuses both, so the buttons are not shown.
- The Service Center portal's password dialog moved to the shared record
  components, so both portals show a new password the same way.

### Gap found: Admin could not send work back

Section 3.1 lets Admin require rework after speaking to the customer, and the
status machine has allowed ADMIN_CONFIRMATION -> REVISIT_REQUIRED from the
start — but no endpoint performed it. If the customer said the cooler was
still not right, Admin could only close it anyway or cancel it.

Added `POST /complaints/:id/require-rework` (Admin, reason required) and a
"Send back for rework" button on the complaint page, shown only while
confirming with the customer. It records the reason the same way the Owner's
rejection does, so every screen shows "sent back". **An already verified Happy
Code is cleared**: the customer confirmed the earlier work, and the rework
needs its own confirmation before closing. Tested in `adminRework.test.ts`
(written first; all 6 failed before the change).

### Gap found: a centre's own pincode did not count as coverage

The recommendation matched a pincode only against a centre's coverage list.
The seed data happened to repeat each centre's own pincode there, which hid
the problem; once the Service Centers screen stopped showing (and saving) a
centre's own city and pincode as "extra" coverage, the local centre dropped
from "Covers this pincode" to "Located in this city". A centre now always
covers its own pincode. Test first in `complaints.test.ts` ("matches a center
on its own pincode, not only its coverage list"), which failed before the fix.

### Checked in the browser

Signed in as Admin: Territories / Cities, Service Centers (coverage edit),
Products and models, Customers (search, history, edit form), Technicians &
Users (list and add form only — no account was created, reset or
deactivated), Parts & Inventory (both tabs), SLA (edit form, not saved), and
the "Send back for rework" dialog (opened, not confirmed). Small fixes from
that pass:

- The products table showed **0 models** while the models were still loading;
  it now shows a dash until they arrive.
- The low-stock warning icon (Admin and Service Center parts screens) now has
  real screen-reader text instead of an `aria-label` on a bare SVG.
- The deactivate dialog no longer says the same thing twice.

Local test data changed during this pass: city **Ajmer** added; the four
`IdCheck` territories left over from earlier API checks deactivated; Jaipur
Central's coverage now lists Ajmer and 302002.

## 25. Reports & MIS (2026-09-17)

Section 16's reports, on screen, for Admin (**Reports & MIS**) and the
Service Center portal (**Reports**) — one shared page. Five tabs: Complaints,
Service centers (Admin only), Technicians, Products, Parts. Each shows headline
figures, charts and tables for the chosen dates and filters, and downloads as
**Excel or CSV** with exactly what the page shows.

### Gaps found in the report API, fixed before building the screens

The API existed and was tested, but reading it against section 16 turned up
numbers that did not mean what their labels said. Tests were written first;
32 of 42 failed before the fix.

- **The territory filter did nothing.** It was accepted and ignored, so a
  territory report showed every territory. A complaint records its city, so a
  territory now means the cities it holds today.
- **Cancelled complaints counted as open** in the by-city table.
- **The technician report mixed time periods.** Jobs were counted for the
  chosen dates, visits and parts for all time. A technician who handed a job
  over also vanished from the report, with the work they did on it.
- **"Revisit rate" measured the wrong thing.** For technicians it counted
  complaints sitting in Revisit Required at that moment (zero once the revisit
  was done); for centres it counted reopened complaints. It is now resolutions
  **sent back** ÷ resolutions submitted — by the centre's review or by Admin —
  and each rejection is credited to whoever submitted the rejected work.
- **SLA performance** counted open, not-yet-due complaints as met, and showed
  100% when nothing had closed. Now: **Closed within SLA** = closed without a
  breach ÷ closed, and a dash when nothing has closed. Averages and rates with
  nothing to measure are empty rather than 0.
- **Parts:** low stock was summed across centres (one centre out, another full
  = "not low"); it is now the number of centres at or below minimum. Usage by
  centre and by technician (both in section 16) were missing.
- **Products:** added section 16's "serial number history" (units with more
  than one complaint, linked to the latest) and the most common issues.
- **Exports** held only one table — no totals, no breakdowns. They now carry
  everything: a Summary sheet plus one sheet per table in Excel, sections in
  CSV. Numbers are stored as numbers (they were text, so Excel could not sum or
  sort them), filters are written by name ("City: Jaipur", not an id), and
  dates use the company timezone.

### What the dates mean

- Complaints, service centers, technicians, products: **complaints raised in
  the dates, and all the work done on them**. One rule for every column, so a
  row always describes one set of complaints.
- Parts: **parts used and requested in the dates**; stock is as it is now.

Each report says this under the filters, and the download says it too.

### Choices worth knowing

- **Filters live in the address bar**, so a filtered report survives a refresh
  and can be bookmarked or shared.
- **One "Filters" button, with chips.** Nine dropdowns in a row took four rows
  on a laptop. Set filters show as chips beside the dates, each removable.
- **Filters a report cannot use are not offered** there (parts have no
  priority or warranty), and one still set from another tab is named: "Priority
  is not used by this report."
- **The technician filter picks the technician's row**, rather than limiting
  complaints to their current jobs — which would hide their visits on jobs
  since handed on.
- **Complaints over time is a column chart**, not a line: each day is its own
  count and most days have none. Keyboard: focus the chart and use the arrow
  keys; the value is announced. Bars are days up to two months, **weeks**
  (starting Monday) up to six, then months, then years — weeks so that "last 90
  days" does not open with a bar holding a few days of a month.
- An Owner gets no Service centers tab (one row adds nothing) and no centre
  filter; the server scopes every figure to their centre regardless.

### Limits

- The technician filter lists up to 100 technicians (the users API maximum).
- The repeat-units table lists the top 500; the count above it is exact.
- A territory report follows today's city-to-territory mapping.

Checked in the browser as Admin at phone and laptop widths: every tab, the
filter panel and chips, the chart readout, and both downloads (fetched and
inspected, not saved to disk). The Service Center view is the same page; its
scoping is covered by the report tests. The JSON shape changed — `summary` is
now a list, with `breakdowns`, `trend`, `tables`, `filters` and
`ignoredFilters` — nothing else used it yet.

## 26. Admin Visits / Schedule (2026-09-17)

Section 4 lists **Visits / Schedule** in Admin's navigation without describing
it; section 9 describes the Service Center's version (schedule, reschedule,
view calendar/list, track visit status, see the technician). The Service
Center portal already had that screen, and the API already let Admin read every
centre's visits and reschedule or cancel one. So the screen became **one
shared page** (`components/visits/VisitSchedule.tsx`), as the complaint list
and reports did:

- **Admin** sees every centre, can filter by centre, and each visit names its
  technician and service center.
- **Both portals** gained **Past 7 days**: finished and cancelled visits with
  how each ended — work done, nobody was home, customer asked for another day,
  cancelled. A run of wasted trips is visible without opening each complaint.
- Today / Tomorrow / Next 7 days / All upcoming / Missed, "On site now" and the
  missed-visits warning work as before, now per centre for Admin.
- **Admin can reschedule or cancel** a booked visit — for when a customer rings
  the helpline. The API allowed this from the start; the dialogs moved to
  `components/visits/VisitDialogs.tsx` so both portals use the same ones.
  Booking a *new* visit stays with the service center (rule 5).
- On a phone the six view buttons become a dropdown; a scrolled strip hid the
  selected one.

### API changes (tests first; 2 of 4 new tests failed before)

- `GET /visits` returns `technicianName` and `serviceCenterName` on each visit,
  looked up once per page. A screen spanning centres could not rely on its own
  technician list, which stops at 100.
- `status` accepts several values: `status=COMPLETED,CANCELLED`. An unknown
  value is refused.
- Each visit card also carries `serviceCenterId`.

"Past 7 days" is by **booked** date, like the rest of the schedule: a visit
booked for next week and cancelled today is not listed there. The complaint's
timeline still records the cancellation, with its reason.

## 27. Audit Log and Settings (2026-09-17)

The last two Admin screens. Every screen in section 4's navigation now exists,
so the "being built" placeholder page was removed.

### Audit Log

Section 17's events have been recorded since the first modules, but they could
only be read one complaint at a time. The screen has two tabs:

- **Complaint activity** — every complaint's timeline, newest first, with the
  complaint linked. Filter by dates, person, kind of event (assignments,
  visits, parts, reviews, Happy Code, closing…) or complaint number.
- **System & sign-ins** — sign-ins and failed attempts, accounts, record
  changes, stock, SLA settings, Happy Code views. Filter by dates, person and
  kind.

API (tests first; all 10 new tests and one index check failed before):

- `GET /audit/activity` (Admin) — complaint activity across complaints; one or
  several actions, person, complaint number (an unknown number finds nothing,
  rather than everything), dates. New index `{ createdAt: -1, _id: -1 }`.
- `GET /audit` gained `category`, names each record (`entityName`: "Cooling Pad
  at Jaipur Central Service", not an id), and shows names inside changes
  ("Cities covered: Jaipur → Ajmer"). Filtering by person also finds events
  *about* their account, such as failed sign-ins, which have no actor yet.
- **Session renewals are hidden unless asked for** (`action=TOKEN_REFRESHED`).
  Every open screen renews its session every few minutes; they are still
  recorded.

Problems found on the way, fixed:

- Record updates were logged as `SERVICECENTER_UPDATED` / `PRODUCTMODEL_UPDATED`
  while creation used `SERVICE_CENTER_CREATED`, so filtering by action missed
  the edits. Now one scheme.
- Moving a job to another technician or centre stored the **previous** one as
  a database id and the new one as a name. Both are names now; older entries
  show "the previous technician".
- A stock count note named the centre by its id. Now by name.
- "Visit scheduled for 2026-09-16T13:00:00.000Z" — notes now use local time in
  words, and older notes are shown that way too.
- **The complaint timeline hid "work resumed".** It dropped every status-change
  entry, to avoid showing each action twice — but resuming work after parts
  arrive is recorded *only* as a status change. It now hides a status change
  only when an action with the same change sits beside it. The timeline and
  the audit log share one set of event names (`client/src/lib/activity.ts`).

### Settings

Section 4 names the page without describing it. It holds:

- **Your account** and **Change password** — Admin had no screen for changing
  their own password.
- **The rules in force**, read from the server's configuration through
  `GET /settings` (Admin): password length, how many wrong passwords lock an
  account and for how long (and that resetting a password unlocks it), how
  long a device stays signed in, Happy Code digits and tries, photo size, and
  the timezone. Admin is who staff call when locked out, so the page states
  the real numbers rather than help text that can drift.

Read-only on purpose: loosening sign-in lockout from a web page would let one
stolen Admin session weaken sign-in for everyone. No secret is ever in the
response (tested).

## 28. End-to-end walkthrough (2026-09-17)

One complaint taken from creation to closure through all three portals, with
the user signed in to each role in its own browser tab (ports 5174 Admin, 5175
Service Center, 5176 Technician — separate origins keep separate sessions):
created with the recommended centre, technician assigned, visit booked, visit
started, diagnosis, work, one Cooling Pad used, resolution submitted, part
usage confirmed (stock 24 → 23), work accepted, Happy Code verified, closed.
Then checked the dashboards, Visits, Reports, the technician's History and the
Audit Log.

### Found and fixed

- **Admin could not close any complaint from the screen.** After a correct
  Happy Code, "Close complaint" stayed disabled. The API built `nextActions`
  from the stored complaint, which keeps verification under
  `happyCode.verifiedAt`, while the status machine reads a flat
  `happyCodeVerifiedAt` — optional in its type, so it compiled and always read
  as unverified. Closing through the API worked (the tests close that way); the
  screen never offered it. Now every caller builds the view with
  `stateViewOf`, and the field is required so a raw complaint no longer
  compiles in its place. Test first: `nextActions.test.ts`.
- After verification, the banner still said "verify their Happy Code". It now
  says the customer confirmed and the complaint can be closed.
- The "Send via WhatsApp" card showed on closed and cancelled complaints.
- "Average time to close" rounded to a tenth of an hour, so an 8-minute job
  read as 6 minutes. Now two decimals.

### Noticed, not changed

- A technician can start a new visit while an earlier one is still in
  progress (a visit started yesterday was never finished). "On site now" shows
  it as started 18 hours ago, but nothing asks the technician about it when
  they start the next job.

Test data added: complaint CMP-2026-000007 (closed), one Cooling Pad used at
Jaipur Central (stock now 23).

## 29. Pre-launch review and fixes (2026-09-17)

Before handing the software to the client, four read-only reviews were run
(security; Admin portal; Service Center portal; Technician app) and every
finding was checked against the code before it was fixed. The client also
asked for two additions. Fixes were made in four file-partitioned streams plus
the lead's own, and each stream was reviewed again by an independent reviewer.

### Decided with the client

- **No WhatsApp API.** Customers are contacted with two one-click buttons
  wherever a customer appears (complaint lists, complaint pages, the
  technician's job screen, Customers): **Call** (`tel:+91…`) and **WhatsApp**
  (`https://wa.me/91…`; the chat opens empty, the person types and sends).
  Shown only for a valid 10-digit Indian mobile. The Happy Code message stays
  as it was: "Send via WhatsApp" opens WhatsApp with the message typed, and
  Admin presses send (`ContactButtons.tsx`, `core/whatsapp.ts`).
- **Deactivating a service center blocks its Owner and technicians.** Sign-in
  is refused with "Your service center has been deactivated. Please contact
  the Admin.", refresh is refused, and every request is refused as 401 so the
  app signs out. Reactivating restores access with nothing to undo. Checked in
  `authenticate`, login and refresh (`serviceCenterDeactivated`).
- **Service center details page** (Admin → Service Centers → click a centre,
  `/admin/service-centers/:id`, `GET /service-centers/:id/overview`, Admin
  only): contact with Call/WhatsApp, address, coverage, owner(s), technicians
  with open jobs and last sign-in, open complaints nearest deadline first,
  booked and missed visits, low stock and waiting part requests, and
  performance for a chosen period. Performance is read from the Service
  centers report filtered to the centre, so it cannot disagree with Reports.
  Counts use the dashboard's definitions (SLA breached = open and
  `sla.state` BREACHED; waiting requests = REQUESTED or APPROVED; low stock =
  available ≤ reorder level). Every figure links to the list it counted.

### Security

- **Customers are Admin only** (`/customers`, `/customers/:id`, history). Any
  signed-in technician could page through every customer's name, mobile and
  address. Serial history stays open to all roles for the technician's "View
  History", but outside Admin the unit must be in the caller's own work (else
  404) and no customer fields or closure history are returned.
- **Production refuses weak secrets**: placeholder, low-entropy or identical
  access/refresh JWT secrets stop the server starting when
  `NODE_ENV=production` (`productionSecretIssues`).
- **Login lockout is atomic**: one `findOneAndUpdate` counts the attempt and
  sets the lock, so parallel wrong passwords cannot exceed the limit. Known
  trade-off kept: the "locked" answer shows that a mobile has an account.
- **Sign-out ends that device's session on the server.** Each sign-in stores
  an `AuthSession`; both tokens carry its id (`sid`). `POST /auth/logout`
  deletes it; refresh refuses a token whose session is gone (same answer as a
  forged token). Other devices stay signed in; password change, reset and
  deactivation still end every session. Sessions expire with their refresh
  token (TTL) and are capped at 10 per person. Tokens issued before this have
  no `sid`, so everyone signs in once more. Not done: refresh-token rotation
  (two tabs renewing together would look like theft); an access token copied
  before sign-out works until it expires (15 minutes).
- **Sign-out clears cached data**, and a different person signing in on the
  same tab or phone starts with an empty cache (query keys say what was
  asked, not who asked). Technician visit drafts are keyed by user, complaint
  and visit.
- **Closed or cancelled complaints take no new work**: no technician
  assignment, no new part requests or usage, no approving or issuing parts.
  Usage recorded before closing can still be confirmed afterwards so stock
  stays right.
- **The old centre loses its foothold when a complaint moves**: rescheduling
  or cancelling a visit and deciding a part request re-check the complaint's
  scope, not only the record's stored centre.
- **Seed script** applies the real password rule to a supplied Admin password,
  forces a change on first sign-in, and masks credentials in printed URIs.

### Moving work between centres and technicians

- **Admin can move a complaint from any working status**: assigned,
  technician assigned, visit scheduled, in progress, on hold for parts, sent
  back, or submitted, as section 8 requires for a deactivated centre. Not
  from Admin confirmation: that work is accepted, so it is closed or sent back
  first. Moving requires a reason, cancels booked and started visits, withdraws
  part requests not yet issued (`PARTS_REQUEST_CANCELLED`), unassigns the
  technician and restarts a paused SLA clock. The old visit used to stay on
  the old centre's schedule, turn "Missed" and silently move to the new
  centre's technician under the old centre's name.
- **A reopened complaint with no centre can be assigned** without a reason;
  the reason box was hidden while the server demanded one. Moving a reopened
  complaint to a different centre still needs a reason.
- **Changing the technician ends the previous technician's visit under way**
  (cancelled, with the reason), and **Resume work** is refused when no visit
  of the current technician is under way ("book a follow-up visit"). Both
  closed the dead end where the new technician could never submit. The Owner
  can now reassign while someone is on site (the dialog warns first), which is
  needed when a technician falls ill or is deactivated mid-visit.
- The deactivation dialog links each stranded complaint as "Reassign", or
  "Confirm and close" for accepted work.

### Lists, dashboards and search

- **Dashboard figures and their lists share one definition** (`OPEN_COMPLAINT`,
  `SLA_BREACHED`, `raisedBetween` in `complaint.service.ts`). The complaint
  list takes `open=true`, `slaBreached=true`, `from`/`to`, `serviceCenterId`
  and `technicianId` in the URL, shown as clearable chips. "View SLA breaches"
  now opens the breached complaints instead of the SLA rules page.
- **Waiting part requests = REQUESTED or APPROVED** everywhere (dashboard,
  Parts page), shown as "Approved — to issue" once approved.
- **Mobile search matches the way numbers are shown** ("98765 43210",
  "+91 98765 43210", "098765…") through one helper, `core/search.ts`.
- **"Today" and the complaint-number year follow `APP_TIMEZONE`**
  (`core/time.ts`), not the host's clock; on a UTC server they rolled over at
  05:30 IST. The purchase-date picker uses the local date.

### Create complaint, records, parts

- **Service address is confirmed** (spec Workflow A step 8): the customer's
  saved address, or a different one for this complaint. Recommendations use
  the address chosen and it is always sent. A "new customer" whose mobile is
  already registered is refused and offered as the existing customer instead
  of being silently merged into it.
- Optional fields can be cleared (user email, part category): the client
  sends the empty value and the server unsets it.
- Part creation is audited; "Last delivery" moves only on a real delivery,
  not on a stock count; part decisions are recorded as approved, rejected,
  issued or unavailable instead of "Parts requested".

### Technician app on weak signal

- A failed background refresh keeps the job screen and the visit form, with
  a small "couldn't refresh" note, instead of replacing them with an error.
- A Submit or Start whose reply was lost re-checks the server before showing
  an error, so a retry does not repeat work already done.
- On a revisit, photos and parts are those of the current visit; earlier
  visits' parts show separately as history.
- The parts picker searches the server (it only ever saw the first 100 parts).
- Putting a job on hold refreshes the job screen; un-picking a part while it
  saves no longer throws or duplicates it.
- An oversized photo says "This photo is too large. The limit is N MB."
- The service worker only switches to a new release once its files are
  cached, and each portal shows an error screen with "Try again" instead of a
  blank page when a screen cannot load.

### Smaller corrections

- Validation errors carry the first problem in words (e.g. "Please give a
  reason of at least 3 characters") instead of "The request body failed
  validation"; booking a visit for a deactivated technician says so.
- The timeline records a cancelled visit as "Visit cancelled", keeps "Visit 3
  scheduled for …" when a reason is also given, and names part decisions.
- The Hold for parts dialog says whether the SLA clock pauses, from the SLA
  rule for the complaint's priority. The SLA page explains that pause settings
  reach open complaints while new time limits do not.
- "Must set a new password" instead of "Not signed in yet" for someone who has
  signed in before and was given a temporary password.

### Session renewal (found in the second walkthrough)

A renewal that failed for a temporary reason (server restarting, no signal)
signed the person out. `refreshSession` now returns renewed, rejected or
unavailable: only a refused refresh (400/401/403) clears the session; anything
else surfaces as a connection error and the session is kept (`api.ts`).

### Before going live (deployment, deferred with the client)

Not code changes, but required on the server: bind the API to localhost or
firewall port 4000 and set `trust proxy` to the real proxy count (otherwise
`X-Forwarded-For` defeats the login rate limit and forges audit IPs); set
`NODE_ENV=production` explicitly; restrict CORS to the app's own origin; add a
Content-Security-Policy; do not expose `/health/ready` details publicly.

Test data added: complaint CMP-2026-000009 for "WhatsApp Test Customer" (the
client's own mobile), created to demonstrate the Happy Code message.

## 30. Chosen dates on the Admin dashboard (2026-09-18)

Asked for by the client: the dashboard's Today / 7 / 30 / 90 days / All time
row now ends with **Choose dates**, which opens a From and a To box under it.

- **Whole days, either end optional.** From starts at 00:00 of that day and To
  ends at 23:59:59, so picking the same day twice means that day. "From 1
  August" with no end, and "up to 15 September" with no start, are both
  allowed; the end date cannot precede the start.
- **Applied on a button, not per keystroke**, so a half-entered period never
  reloads every panel with figures nobody asked for.
- **The choice lives in the address bar** (`?range=custom&from=…&to=…`), so a
  refresh keeps it and a period can be sent as a link — the same approach as
  the Reports page, whose `describeRange` writes the period in words under the
  row ("Complaints raised: 1 Aug – 15 Sep 2026").
- **Tiles keep the period**: clicking a figure opens the complaint list with
  the same `from`/`to`, so the list total matches the number just clicked.
- No server change was needed: `GET /dashboard` already accepted `from` and
  `to`, and both ends now have a test (`dashboardLists.test.ts`).
- The dashboard's dates narrow the complaint figures (complaints *raised* in
  the period). The "right now" panels — today's visits, missed visits, stock,
  waiting part requests — are current state and deliberately ignore the
  period, which is why the caption names what the dates cover.
- Only the Admin dashboard, decided with the client; the Service Center
  dashboard keeps its current-state view with no date filter.

## 31. Technician photos on the Admin page, service-centre ratings, centre filter (2026-09-18)

Three things the client asked for after the pre-launch pass.

### The technician's photos, everywhere the complaint is read

The Service Center portal already showed them; Admin did not. The grid and its
full-size viewer moved to `client/src/components/complaint/PhotosCard.tsx`
(`PhotosCard` for Admin's own card, `PhotosGrid` for the centre's work card),
so both portals show the same photos the same way. The centre's card now asks
for the visit under review (`visitId`), because an earlier trip's photos are
that trip's record, not this one's.

### Admin rates the centre's work

- **When.** Only on a **closed** complaint that has a service centre. Nothing
  is offered before that; the server refuses it in plain words.
- **What.** One to five whole stars and an optional note (≤1000 characters).
  Changeable: each change writes its own timeline entry with the old and new
  stars, and `revisions` counts them. Half stars were rejected — they only
  invite arguments about what 3.5 means — and each number carries a written
  meaning ("4 — Good") so a rating is not one person's private scale.
- **Where it is stored.** On the complaint, as `serviceRating`: one rating per
  complaint, every screen that shows one is already showing its complaint, and
  a centre's average is then one aggregation rather than a join.
- **Who sees it.** The centre reads it on the complaint (never changes it) and
  as an average on its dashboard. Admin sees it on the complaint, as an average
  on the dashboard — with a count of closed complaints still to rate — as
  "Avg. rating" and "Rated" on the centre's page, and as two columns in the
  Service centers report, exports included.
- **The note is cleared by leaving it out** when changing a rating, the same
  explicit-clear convention as a user's email.
- **A rating belongs to the closure it judged.** Reopening a complaint files
  the rating into `closureHistory` and clears it from the complaint. Otherwise
  a rating given to one centre could travel with a reopened complaint to
  another and land in *its* average. Because of that — and because closed
  complaints cannot be moved — every average can group by the complaint's own
  centre, with no risk of crediting the wrong one. The timeline keeps the
  rating either way.
- Stars are decoration: screen readers are given "4 out of 5", and the picker
  is a real radio group that works from the keyboard.

### One more filter: the service centre

Admin's dashboard and the complaint list both take `serviceCenterId`. On the
dashboard it narrows every figure — including section 9's operational panels,
which at first narrowed only for an Owner — and travels with the tile links,
so a tile's number and its list still agree. Deactivated centres appear in
both dropdowns marked "(inactive)", so a shared link naming one still shows
what is being filtered.

### API

- `POST /complaints/:id/rating` — Admin only. `{ stars: 1-5, note? }`.
  Responds like the other complaint actions (`{ complaint, nextActions }`).
- `GET /dashboard?serviceCenterId=…` — narrows only, and returns
  `ratings: { average (one decimal, null when none), rated, closedUnrated }`.
- `GET /reports/service-centers` — `byCenter` rows gain `avgRating` and
  `rated`; the summary gains a weighted `avgRating` across the centres in the
  report. `SummaryItem` learned the `decimal` format for it, which columns
  already had.

## 32. Typed cities, an Indian state list, warranty left, a customer's products (2026-09-18)

Three things the client asked for on seeing the software.

### Cities are typed; states are a list; the Territories page is gone

The spec (sections 8, 25) made cities and territories master data an Admin
builds before anyone can enter an address. The client does not want to
maintain that. Decided with them:

- **Every form takes a typed city and a state from a list** — customer,
  service center (its own city and its coverage), and the complaint's service
  address. The **Territories & Cities page is removed** from the menu and the
  routes; nothing else links to it.
- **The city record stays, but the server creates it.** A form sends
  `cityName` + `state`; `masters/geography.resolve.ts` finds the city
  (case-insensitive, within that state) or creates it — and, if needed, the
  state's territory first. So complaint recommendations, reports and filters
  keep working on city ids exactly as before, while nobody ever creates a
  city by hand. Every API that accepted `cityId` still does. Two people typing
  the same new city at the same moment produce one record: the city index is
  unique on name+state with a case-insensitive collation, and the loser of
  the race re-reads what the winner made.
- **A state must be one of India's 28 states and 8 union territories**
  (`core/india.ts`, mirrored in `client/src/lib/india.ts`; a test keeps the
  two identical). "UP", "U.P." and "Uttar pradesh" would otherwise be three
  places to every report and to the centre matching. Older names still
  resolve (Orissa → Odisha, Pondicherry → Puducherry). What is stored is the
  official spelling.
- **Territories are now one per state**, named after the state and created
  on demand, because cities and centres still require one. The word
  "Territory" no longer appears in the interface: the report filter reads
  **State**. A centre's territory follows its city; the form no longer asks.
- Coverage ("also serves these cities") is typed the same way, one city at a
  time, shown as removable chips.

### Warranty left, from the purchase date

- **Twelve months from the purchase date, unless the product or model says
  otherwise** (its `defaultWarrantyMonths`). The months are snapshotted onto
  the complaint (`productSnapshot.warrantyMonths`) when it is raised, so a
  later change to the product does not rewrite how long an old unit was
  covered. Complaints raised before this read as twelve months.
- Shown as "In warranty · 7 months left (ends 4 Jan 2027)" or "Out of
  warranty · ended 4 Jan 2026" on the complaint's Product card (Admin and
  Service Center alike), on the technician's job screen, and on the
  customer's products. Without a purchase date it says so instead of
  guessing.
- **The complaint's own `warrantyStatus` is unchanged and still governs the
  job** (spec section 12: Admin's decision when raising it, e.g. a goodwill
  in-warranty repair). The computed reading sits beside it, and when the two
  disagree the card says which one applies rather than hiding either. The
  maths lives once, in `client/src/lib/warranty.ts`.

### A customer's products

`GET /customers/:id/history` now also returns `products`: the customer's
units grouped by serial number from their complaints — product, model,
purchase date (the latest recorded), warranty months, complaint count, open
count, last complaint. Nothing is entered by hand: a product exists the
moment a complaint records it, which is what was asked ("show the customer's
product after the complaint is created"). The Customers screen shows them
above the complaint history.

Also fixed on the way: the seed script uses the same find-or-create as the
app, so the demo world cannot contain a city the app would not match.

### Recheck of the last two days (2026-09-18, evening)

Six independent reviews (security; workflow and ratings; cities, states and
warranty; dashboards and lists; parts, photos and the technician app; drift
between layers and documents), each finding judged by two further readers.
Six were raised, five confirmed and fixed, one refuted:

- A product with a warranty of **0 months** was snapshotted as "no value" and
  read as twelve months; both the snapshot and `warrantyPeriod` now treat 0
  as a real span (test added).
- The error boundary wrapped the whole Admin and Service Center layout, so a
  screen that failed to load took the navigation with it; it now wraps only
  the screen, as the technician layout already did.
- Admin's "deactivated technician" dialog promised a "Reassign" that Admin
  has no control for (only the centre reassigns technicians); it now says so
  and offers "Open".
- A rating change did not show "From 4 to 2" on the timeline.
- The Postman collection lacked the rating request.

Also run by hand: the seed script (idempotent, nothing to create), the
integrity check (clean), the end-to-end smoke test against the running server
(33/33), the full server suite (34 files, 529 tests) and the production
build. The centre page's heading now shows its all-time average rating
(`ratings` on the overview), at the client's request.

