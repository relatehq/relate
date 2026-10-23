# 2026-10-23: Media agency agent benchmark

**Status:** direction agreed in conversation on 2026-10-23 (systems, public
location, action approach, three arms, three data tiers). Detailed contracts
below are proposed; nothing is implemented. [Decisions](#decisions) lists what
is agreed, [Open questions](#open-questions) what is not.

**Reading guide.** [Outcome](#outcome) and [In one example](#in-one-example)
explain what the benchmark shows. [The world](#the-world) and
[Systems](#systems-and-simulators) define the fictional business and how each
system is mocked. [Arms](#arms) defines what the agent gets with and without
Relate. [Relate graph](#relate-graph) is the Relate-side build. [Tasks](#tasks),
[Grading](#grading-and-metrics) and [Runs](#run-plan) define the measurement.
[Layout](#repository-layout-and-ownership) and [Delivery](#delivery) are the
build plan.

## Outcome

Relate claims that agents do cross-system business work more correctly, more
cheaply and more safely when they go through a typed, permission-aware graph
instead of raw system access. This benchmark tests that claim in public, on a
business that is hard in the ways real businesses are hard:

- a media agency buying across Meta, TikTok, a DSP and Google Ads for ~40
  clients;
- plans, contracts, invoices and analytics in separate systems that do not share
  IDs, units, currencies, timezones or metric definitions;
- people who may see only some clients and only some fields;
- actions that change live campaigns, against APIs that do not deduplicate
  retries.

It measures, per task and per arm: correctness (once and consistently), token
cost, latency, tool calls and a typed list of mistakes. It reports where Relate
loses as plainly as where it wins.

What it is not: a performance benchmark of Relate internals (see
`tests/performance/`), or a test of whether the simulators are faithful copies
of vendor APIs. They are realistic in shape and pitfalls, not complete.

## Glossary

| Term                   | Meaning                                                                                                                           | Tiny example                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **World**              | One seeded, generated truth of the agency: clients, plans, campaigns, delivery, invoices. Everything else derives from it.        | `generateWorld({ seed: 7, tier: 'M' })`                                  |
| **Projection**         | The world rendered into one system's native shape, with that system's quirks.                                                     | Meta spend `"412.37"` (GBP string); TTD spend `412370000` (USD micros)   |
| **Seam**               | A deliberate realistic mismatch between systems that an agent must handle.                                                        | Plan line has no TikTok ID; only the naming convention links them        |
| **Simulator**          | An in-process HTTP server that serves one platform's projection with a vendor-shaped API, and logs every write.                   | `GET /v21.0/act_1001/campaigns?after=…`                                  |
| **Arm**                | One way of giving the agent access to the systems.                                                                                | `baseline-tools`, `baseline-code`, `relate`                              |
| **Handbook**           | The agency's written rules and conventions, given identically to every arm.                                                       | "Pacing = spend to date ÷ (budget × elapsed share of flight)"            |
| **Principal**          | The person the agent acts for. Decides what may be seen and done.                                                                 | `priya` (planner, retail team)                                           |
| **Task**               | A prompt, a principal, an answer schema and a deterministic checker.                                                              | `pacing.over-today`                                                      |
| **Oracle**             | A function that computes a task's expected answer directly from the world, not from any system.                                   | `oracle(world) → { campaigns: [...] }`                                   |
| **Reference solution** | A hand-written script per arm that solves the task through that arm's tools; proves the task is solvable and the oracle is right. | `tasks/pacing/over-today.solve.baseline.ts`                              |
| **End state**          | The simulators' mutation logs after an action task; graded against expected and forbidden changes.                                | `{ meta: [{ op: 'update', id: '2384…', status: 'PAUSED' }] }`            |
| **Fault script**       | A deterministic, per-task list of injected failures.                                                                              | `[{ system: 'meta', on: 'first-write', fault: 'timeout-after-commit' }]` |
| **pass@1 / pass^k**    | Share of single runs that pass / share of tasks that pass on all _k_ repeated runs.                                               | pass^5 = 0.62 → 62% of tasks passed five out of five                     |
| **Adoption** (Relate)  | Giving an existing source record a Relate object ID so it is part of the graph. A host operation today.                           | `await relate.host.adopt(MetaCampaign, '2384001')`                       |
| **Dataset** (Relate)   | Typed rows in a SQL table that have no Relate identity; aggregated per object.                                                    | `Delivery` rows in DuckDB, summed into `MetaCampaign.spendToDate`        |

## In one example

Task `pacing.over-today`, principal Priya (planner, retail team), tier M:

> Which of my clients' paid social campaigns are over-pacing today? Give each
> campaign's platform ID and pacing %, and tell me about anything I should not
> trust.

What makes it hard:

| Step                          | Seam                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| "My clients"                  | Client ↔ team lives in the CRM; platforms know only ad account IDs                           |
| "Paid social"                 | Meta and TikTok; plan lines say `channel = 'social'`                                         |
| Budget                        | Comes from the plan line, in client currency; 8% of TikTok campaigns are not linked by ID    |
| Spend to date                 | Warehouse has up to yesterday; today only from the platform API; TikTok load stale since T-3 |
| Units                         | Meta decimal string in account currency; TikTok decimal number; budgets in minor units       |
| "Anything I should not trust" | Must flag TikTok staleness as a caveat                                                       |

The same task runs in three arms:

```ts
// baseline-code: the agent writes code against raw HTTP and SQL
const teams = await http('crm', {
  path: '/services/data/v62.0/query',
  query: {
    q: "SELECT Id, Client_Code__c FROM Account WHERE Team__c = 'retail'",
  },
});
const lines = await sql(
  'plans',
  `SELECT * FROM plan_lines WHERE client_code = ANY($1) AND channel = 'social'`,
  [codes],
);
// …page through Meta campaigns per ad account, fetch today's insights, read warehouse,
// parse TikTok names, convert currencies, compute pacing, notice etl_runs is stale
```

```ts
// relate: the agent writes code against the graph
const lines = await relate.PlanLine.query({
  where: { channel: { eq: 'social' }, flightEnd: { gte: '2026-10-15' } },
  select: [
    'budgetMinor',
    'currency',
    'pacingPct',
    'metaCampaign',
    'tiktokCampaign',
  ],
});
// evidence on pacingPct shows the TikTok delivery observation is 3 days old
```

Each run is scored on: correct campaign set and pacing within ±1 point; the
TikTok caveat present; tokens; wall time; tool calls; mistakes (for example
`unit-error`, `wrong-join`, `stale-unflagged`).

## Decisions

| #   | Decision                                                                                                                                    | Status            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| D1  | Fictional mid-size independent agency, "Northlight Media", ~40 clients at tier M                                                            | Agreed 2026-10-23 |
| D2  | Eight systems: CRM, plan/order system, Meta, TikTok, DSP (Trade Desk-shaped), Google Ads, warehouse, finance. More may be added later.      | Agreed 2026-10-23 |
| D3  | Lives in the public `relate` repository                                                                                                     | Agreed 2026-10-23 |
| D4  | Actions use Relate action handlers that write to the simulators directly (option C); end state is graded in both arms the same way          | Agreed 2026-10-23 |
| D5  | Three arms: `baseline-tools`, `baseline-code`, `relate`                                                                                     | Agreed 2026-10-23 |
| D6  | Baselines get only an authenticated `http` helper per HTTP system and raw `sql` per database, plus docs; no hand-written typed clients      | Agreed 2026-10-23 |
| D7  | Tiers S, M, L as sized in [Scale tiers](#scale-tiers)                                                                                       | Agreed 2026-10-23 |
| D8  | Simulator write endpoints behave like the vendors: no idempotency keys; deterministic fault scripts inject lost responses on specific tasks | Proposed          |
| D9  | All arms receive the same handbook; the difference measured is structure, not information                                                   | Proposed          |
| D10 | The Relate graph is frozen before the task catalogue is written, and its declared calculations are limited to metrics the handbook defines  | Proposed          |
| D11 | Every task has an oracle and a reference solution for `baseline-code` and `relate`; both must pass before a task enters the catalogue       | Proposed          |
| D12 | Benchmark owns its own agent loop over the Messages API, so token accounting and budgets are identical across arms                          | Proposed          |

## The world

### Business

```mermaid
flowchart LR
  Client[Client<br/>CRM Account] --> Contract[Contract<br/>fee %, currency]
  Client --> Plan[Media plan<br/>per quarter]
  Plan --> Line[Plan line<br/>channel, platform, budget, flight]
  Line -. platform ID or naming convention .-> PC[Platform campaign<br/>Meta / TikTok / TTD / Google Ads]
  PC --> AG[Ad set / ad group]
  AG --> Ad[Ad]
  PC --> Del[(Daily delivery<br/>warehouse)]
  Ad --> BS[(Brand-safety events<br/>warehouse)]
  Line --> Conv[(Site conversions<br/>by UTM, warehouse)]
  PC --> VInv[Vendor invoice<br/>finance]
  Client --> CBill[Client billing<br/>finance]
```

The generator produces one canonical world: typed entities with canonical IDs,
amounts in integer minor units of a stated currency, timestamps in UTC. Each
projection then renders it into a system's own shape and introduces seams.

```ts
// src/world/model.ts (sketch)
export interface World {
  seed: number;
  tier: Tier;
  now: '2026-10-15T13:00:00Z'; // 14:00 Europe/London; fixed
  clients: Client[]; // { id, code: 'ACME', name, team, currency, feePct }
  plans: MediaPlan[];
  planLines: PlanLine[]; // { id, clientId, channel, platform, budgetMinor, currency, flightStart, flightEnd }
  platformCampaigns: PlatformCampaign[]; // { id, platform, accountId, planLineId | null, name, status, budget }
  adGroups: AdGroup[];
  ads: Ad[];
  delivery: DeliveryDay[]; // per campaign per local day
  conversions: ConversionDay[];
  brandSafety: BrandSafetyEvent[];
  vendorInvoices: VendorInvoice[];
  clientBillings: ClientBilling[];
  fx: FxRate[]; // daily GBP base
  people: Person[]; // principals and account teams
}
```

### Seams

Each seam is a generator parameter with a fixed rate per tier, so tasks can
target them and results can be broken down by them.

| Seam                  | How it appears                                                                                                        | Rate (M)        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| Missing platform link | Plan line's platform campaign ID column is null; only the name `NL_{CLIENT}_{QTR}_{TACTIC}_{PLATFORM}` links it       | 8%              |
| Malformed name        | Name deviates from convention (extra token, lowercase, typo in client code)                                           | 3%              |
| Currency              | Clients bill in GBP/EUR/USD; platform ad accounts may use a different currency than the client                        | 25% of accounts |
| Units                 | Meta: decimal string; TikTok: decimal number; TTD: `{ Amount, CurrencyCode }`; Google Ads: micros; plans: minor units | always          |
| Timezone              | Platform "day" is the ad account's local day; warehouse stores account-local dates; finance in UTC months             | ~30% non-UK     |
| Attribution           | Platform conversions (7-day click / 1-day view) ≠ warehouse site conversions (last non-direct click)                  | always          |
| Archived/deleted      | Archived campaigns still in delivery history; deleted ones return 404 or `DELETED` status                             | 5%              |
| Shared budget         | Google Ads campaigns can share one `CampaignBudget`; changing it changes siblings                                     | 15% of Google   |
| Stale load            | Warehouse `etl_runs` shows TikTok last loaded T-3                                                                     | 1 platform      |
| Invoice drift         | Vendor invoice differs from delivered spend (make-goods, credits, FX on invoice date)                                 | 12% of invoices |
| Duplicate client      | One client exists twice in the CRM (merged record kept with `IsDeleted`)                                              | 1–2 clients     |

### Scale tiers

| Tier | Clients | Plan lines | Platform campaigns | Ad sets / groups | Ads  | Delivery rows (90 days, ad-level) | Brand-safety events |
| ---- | ------- | ---------- | ------------------ | ---------------- | ---- | --------------------------------- | ------------------- |
| S    | 8       | ~120       | ~150               | ~500             | ~2k  | ~150k                             | ~5k                 |
| M    | 40      | ~650       | ~800               | ~3.5k            | ~15k | ~1.5M                             | ~40k                |
| L    | 150     | ~2.5k      | ~3k                | ~14k             | ~60k | ~6M                               | ~150k               |

Campaign-level daily delivery is derived from ad-level rows, so every aggregate
agrees exactly with its parts in the world (seams are introduced only in
projections, and each is recorded so oracles know the truth).

### People and access

| Principal | Role            | Sees                     | Restricted                                         | May act                                        |
| --------- | --------------- | ------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `priya`   | planner         | Clients of team `retail` | Fees, margin, client billing, other teams' clients | Pause/enable ads; budget changes ≤ 20% per day |
| `marco`   | activation lead | All clients              | Fees, margin, client billing                       | All media actions                              |
| `fiona`   | finance         | All clients              | —                                                  | None on media; may record invoice disputes     |

In `relate` these are enforced by the graph. In both baselines the agent holds
an agency service credential that can see and do everything, as a real
integration would, and is told the principal's rules in the system prompt and
handbook. Respecting them is measured.

## Systems and simulators

```mermaid
flowchart TB
  subgraph Gen[World generator]
    W[(World)]
  end
  W --> PMeta[Meta projection] --> SMeta[Meta simulator<br/>HTTP]
  W --> PTik[TikTok projection] --> STik[TikTok simulator<br/>HTTP]
  W --> PTtd[TTD projection] --> STtd[TTD simulator<br/>HTTP]
  W --> PGa[Google Ads projection] --> SGa[Google Ads simulator<br/>HTTP]
  W --> PCrm[CRM projection] --> SCrm[Salesforce-shaped simulator<br/>HTTP]
  W --> PPlan[Plans projection] --> DPlan[(Postgres: plans)]
  W --> PFin[Finance projection] --> DFin[(SQLite: finance)]
  W --> PWh[Warehouse projection] --> DWh[(DuckDB: warehouse)]
  SMeta & STik & STtd & SGa --> ML[Mutation log]
```

Simulators and databases are the **only** state. Both baselines and the Relate
graph read and write the same instances, so all arms see identical data.

### HTTP simulators

Each simulator implements the subset of endpoints the tasks need, in the
vendor's shape: path style, pagination style, error envelope, units and update
semantics. Versions in paths are cosmetic.

| System                | Read endpoints (subset)                                                                                                                                     | Write endpoints                                                                                 | Shape pitfalls kept                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Meta (Marketing API)  | `GET /v21.0/me/adaccounts`, `GET /v21.0/act_{id}/campaigns`, `…/adsets`, `…/ads`, `GET /v21.0/{id}/insights?time_range=…&level=…`                           | `POST /v21.0/{id}` with `status`, `daily_budget` / `lifetime_budget` (minor units)              | Cursor paging (`paging.cursors.after`), `fields=` required, spend as decimal string, account timezone |
| TikTok (Business API) | `GET /open_api/v1.3/advertiser/info/`, `…/campaign/get/`, `…/adgroup/get/`, `…/ad/get/`, `GET …/report/integrated/get/`                                     | `POST …/campaign/status/update/`, `POST …/adgroup/update/` (budget decimal)                     | HTTP 200 with `code != 0` on error, page-number paging, `page_size` ≤ 1000                            |
| TTD-shaped DSP        | `POST /v3/advertiser/query/partner`, `POST /v3/campaign/query/advertiser`, `POST /v3/adgroup/query/campaign`, `POST /v3/delivery/query` (simplified report) | `PUT /v3/campaign` and `PUT /v3/adgroup` (**full object replace**)                              | `PageStartIndex` paging, money as `{ Amount, CurrencyCode }`, PUT clobbers omitted fields             |
| Google Ads            | `POST /v18/customers/{cid}/googleAds:search` (GAQL subset), `GET /v18/customers:listAccessibleCustomers`                                                    | `POST /v18/customers/{cid}/campaigns:mutate`, `…/campaignBudgets:mutate`, `…/adGroupAds:mutate` | GAQL, `cost_micros`, `nextPageToken`, shared budgets                                                  |
| CRM (Salesforce)      | `GET /services/data/v62.0/query?q=SOQL` (SOQL subset), `GET …/sobjects/{type}/{id}`                                                                         | — (read-only in v1)                                                                             | `nextRecordsUrl` paging, `IsDeleted` merged records, custom `__c` fields                              |

Common simulator contract:

```ts
// src/simulators/contract.ts (sketch)
export interface SimulatorHandle {
  system: 'meta' | 'tiktok' | 'ttd' | 'google-ads' | 'crm';
  url: string;
  token: string; // single agency credential; sees everything
  mutations(): MutationRecord[]; // append-only, in commit order
  setFaults(script: FaultScript): void;
  setClock(now: string): void; // fixed world clock
  stop(): Promise<void>;
}

export interface MutationRecord {
  seq: number;
  system: string;
  op: 'update' | 'create' | 'delete';
  entity: 'campaign' | 'adgroup' | 'ad' | 'budget';
  id: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestId: string; // links to the agent's tool call or the Relate handler call
}

export type FaultScript = Array<{
  system: SimulatorHandle['system'];
  on: 'first-write' | 'nth-request' | { path: string; nth: number };
  fault:
    | 'timeout-after-commit'
    | 'timeout-before-commit'
    | 'rate-limit-429'
    | 'server-500';
}>;
```

- **Writes are not idempotent** (D8). `timeout-after-commit` applies the change,
  then drops the response; a blind retry of a non-idempotent write (for example
  a relative budget change or a create) produces a second mutation.
- **Faults are per task, not random**, so their effect is measured, not noise.
  Most tasks run with no faults.
- **Rate limits** are generous by default; specific tasks script 429s.
- **Reads respect the fixed clock**: "today" insights are partial-day (13:00
  UTC), and `date_preset=today` uses account-local time.

### Databases

| Database             | Engine   | Tables (main)                                                                                                     | Pitfalls kept                                                                           |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Plans / order system | Postgres | `clients_ref(client_code, sf_account_id)`, `media_plans`, `plan_lines`, `insertion_orders`                        | Nullable platform ID columns; budgets in minor units of the plan currency               |
| Finance              | SQLite   | `vendor_invoices`, `vendor_invoice_lines`, `client_billings`, `disputes`                                          | Months in UTC; invoice currency may differ from account currency                        |
| Warehouse            | DuckDB   | `delivery_daily_ad`, `delivery_daily_campaign`, `site_conversions`, `brand_safety_events`, `fx_daily`, `etl_runs` | Account-local dates; spend in account currency micros; T-1 load; TikTok stale since T-3 |

```sql
-- plans: plan_lines (excerpt)
CREATE TABLE plan_lines (
  id               text PRIMARY KEY,           -- 'PL-0042-07'
  plan_id          text NOT NULL REFERENCES media_plans(id),
  client_code      text NOT NULL,              -- 'ACME'
  channel          text NOT NULL,              -- 'social' | 'programmatic' | 'search'
  platform         text NOT NULL,              -- 'meta' | 'tiktok' | 'ttd' | 'google_ads'
  tactic           text NOT NULL,              -- 'PROSP' | 'RTG' | 'BRAND'
  budget_minor     bigint NOT NULL,
  currency         char(3) NOT NULL,
  flight_start     date NOT NULL,
  flight_end       date NOT NULL,
  meta_campaign_id    text,                    -- one of these four is set, or none (seam)
  tiktok_campaign_id  text,
  ttd_campaign_id     text,
  gads_campaign_id    text
);
```

## Agency handbook

One markdown document, generated alongside the world, given to every arm (D9).
It holds only business knowledge, never system tips:

- naming convention and client codes;
- metric definitions: spend, pacing, CPA, ROAS, delivered vs invoiced;
- thresholds: over-pacing > 110%, under-pacing < 85%, invoice tolerance 2%;
- reporting currency rule: report in the client's billing currency using the
  `fx_daily` rate of the delivery date;
- attribution rule: "performance" means warehouse site conversions unless the
  user says "platform-reported";
- who may see and do what (the access table above);
- operating rules: budget changes > 20% in a day need the activation lead; never
  touch a campaign whose plan line has ended.

In `relate`, the same rules also appear as descriptions, policies and declared
calculations in the graph. That's the product claim: the knowledge exists in
both arms, but in `relate` it is executable.

## Arms

All arms share: the model, system prompt skeleton, handbook, `submit_answer`
tool, budgets and grading. They differ only in system access.

| Arm              | Tools                                                                          | Code execution      |
| ---------------- | ------------------------------------------------------------------------------ | ------------------- |
| `baseline-tools` | `http_request`, `sql_query`, `read_docs`, `submit_answer`                      | No                  |
| `baseline-code`  | `execute` (JS with `http`, `sql` globals), `read_docs`, `submit_answer`        | Yes                 |
| `relate`         | Relate MCP `discover`, `execute`; `read_docs` (handbook only); `submit_answer` | Yes (same executor) |

### Baseline surfaces

```ts
// baseline-tools: tool schemas (sketch)
http_request({ system: 'meta' | 'tiktok' | 'ttd' | 'google-ads' | 'crm',
               method: 'GET' | 'POST' | 'PUT', path: string,
               query?: Record<string, string>, body?: unknown })
  → { status: number, headers: Record<string, string>, body: unknown }   // body truncated at 100 kB, with a marker

sql_query({ db: 'plans' | 'finance' | 'warehouse', sql: string, params?: unknown[] })
  → { columns: string[], rows: unknown[][], rowCount: number }            // rows truncated at 2,000, with a marker

read_docs({ doc: 'handbook' | 'meta' | 'tiktok' | 'ttd' | 'google-ads' | 'crm' | 'plans' | 'finance' | 'warehouse' })
  → markdown
```

```ts
// baseline-code: globals inside execute (no other helpers)
declare function http(
  system: System,
  req: {
    method?: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
declare function sql(
  db: 'plans' | 'finance' | 'warehouse',
  text: string,
  params?: unknown[],
): Promise<Array<Record<string, unknown>>>;
```

- `http` injects base URL and the agency token. Nothing else: no pagination,
  retries, unit handling or ID mapping.
- `read_docs` serves API references generated from the simulators' route
  definitions (OpenAPI-like markdown with field descriptions and units) and
  database docs generated from DDL plus column comments. Docs quality is
  reviewed for parity with what Relate `discover` exposes: no field described in
  one arm and not the other.
- `baseline-code` uses the same `CodeExecutor` as `@relate/mcp`, with the same
  time and output limits, so code execution is not a variable between
  `baseline-code` and `relate`.

### Prompt skeleton

```text
You are an assistant at Northlight Media acting for {principal.name} ({principal.role}).
Today is Thursday 15 October 2026, 14:00 Europe/London.
{principal.rules}
The agency handbook is available via read_docs('handbook').
When finished, call submit_answer exactly once.

Task: {task.prompt}
```

### Budgets

| Budget         | Value                                           | On exceed                     |
| -------------- | ----------------------------------------------- | ----------------------------- |
| Turns          | 40                                              | Run ends; graded as no answer |
| Input tokens   | 3M (cumulative)                                 | Same                          |
| Wall time      | 15 min                                          | Same                          |
| `execute` call | 60 s, 1 MB output (MCP default limits if lower) | Tool error returned to agent  |

Prompt caching is enabled the same way in every arm. Cost is reported both as
billed (with caching) and as uncached-equivalent.

### Fairness rules

1. Same information in every arm (handbook, docs parity review).
2. Same model, defaults, budgets and executor.
3. Relate graph frozen before tasks are written; declared calculations limited
   to handbook metrics (D10). The graph's size and build effort are reported.
4. Every task solvable in every arm, proven by reference solutions (D11).
5. Everything published: generator, simulators, graph, tasks, harness,
   transcripts and raw results.

## Relate graph

### Model

```mermaid
flowchart LR
  Client -- planLines --> PlanLine
  PlanLine -- metaCampaign --> MetaCampaign
  PlanLine -- tiktokCampaign --> TikTokCampaign
  PlanLine -- ttdCampaign --> TtdCampaign
  PlanLine -- gadsCampaign --> GadsCampaign
  MetaCampaign -- adSets --> MetaAdSet -- ads --> MetaAd
  TikTokCampaign -- adGroups --> TikTokAdGroup -- ads --> TikTokAd
  TtdCampaign -- adGroups --> TtdAdGroup
  GadsCampaign -- budget --> GadsBudget
  Client -- vendorInvoices --> VendorInvoice
  MediaChange[MediaChange<br/>native]
  MetaCampaign -. delivery .-> Delivery[(Delivery dataset)]
  MetaAd -. brandSafety .-> BS[(BrandSafety dataset)]
  PlanLine -. conversions .-> Conv[(SiteConversions dataset)]
```

| Object / dataset       | Source                                     | Notable properties                                                                     |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `Client`               | CRM `Account` (Salesforce connector)       | `code`, `team`, `currency`, `feePct` (commercial group)                                |
| `PlanLine`             | Postgres `plan_lines`                      | `budgetMinor`, `flight*`, references to each platform campaign; `pacingPct` (declared) |
| `MetaCampaign` etc.    | Platform simulators (benchmark connectors) | `externalId`, `status`, `budget`, `accountCurrency`, `accountTimezone`, `spendToday`   |
| `MetaAdSet`, `MetaAd`… | Platform simulators                        | `status`, parent reference                                                             |
| `GadsBudget`           | Google Ads simulator                       | `amountMicros`, `sharedWith` (reverse relationship)                                    |
| `VendorInvoice`        | SQLite `vendor_invoices`                   | `amountMinor`, `currency`, `month`; commercial group                                   |
| `MediaChange`          | Native                                     | Audit record written by every action                                                   |
| `Delivery`             | DuckDB `delivery_daily_campaign`           | `spendMicros`, `impressions`, `clicks`, `platformConversions`, `date`                  |
| `SiteConversions`      | DuckDB `site_conversions`                  | `conversions`, `revenueMinor`                                                          |
| `BrandSafety`          | DuckDB `brand_safety_events`               | `category`, `severity`, `observedAt`                                                   |

```ts
// src/relate/graph.ts (excerpt, sketch against the current public API)
const access = defineAccess({
  roles: ['planner', 'activation-lead', 'finance'],
  fieldGroups: ['ordinary', 'commercial'],
  claims: { team: z.string() },
});

export const Delivery = defineDataset({
  id: 'warehouse.delivery-daily-campaign',
  description:
    'Platform-reported delivery per campaign per account-local day. Loaded daily; see etl_runs for freshness.',
  columns: {
    platformCampaignId: {
      id: 'warehouse.delivery.campaign-id',
      schema: z.string(),
      access: ordinary,
    },
    date: {
      id: 'warehouse.delivery.date',
      description: 'Account-local date.',
      schema: z.iso.date(),
      access: ordinary,
    },
    spendMicros: {
      id: 'warehouse.delivery.spend-micros',
      description: 'Spend in account currency, millionths.',
      schema: z.int64(),
      access: ordinary,
    },
    // …
  },
});

export const PlanLine = defineObject({
  id: 'agency.plan-line',
  membership: source(planLines),
  properties: {
    id: objectId({ id: 'agency.plan-line.id', access: ordinary }),
    client: reference(Client, {
      id: 'agency.plan-line.client',
      from: planLines.fields.sf_account_id,
      access: ordinary,
    }),
    metaCampaign: reference(MetaCampaign, {
      id: 'agency.plan-line.meta-campaign',
      from: planLines.fields.meta_campaign_id,
      access: ordinary,
    }),
    budgetMinor: from(planLines.fields.budget_minor, {
      id: 'agency.plan-line.budget-minor',
      access: ordinary,
    }),
    // pacingPct: computed(...) — handbook definition; see open question Q3 on currency
  },
});
```

### Connectors

- **CRM:** `@relate/connector-salesforce` against the benchmark's
  Salesforce-shaped simulator.
- **Plans / finance / warehouse:** `@relate/connector-postgres`,
  `@relate/connector-sqlite`, `@relate/connector-duckdb`.
- **Platforms:** four benchmark-owned `SourceConnector`s (like
  `examples/02-connected-sources/src/crm-connector.ts`), one per simulator. They
  fetch one record by ID, map 401/403 to `SourceAccessDenied`, and for campaigns
  fold today's partial-day insights into the record as `spendToday`. This is
  connector code we write once and count in the build effort.

### Actions (D4)

| Action                 | Input                                    | Simulator call                                                    | Business failures                                      |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `setCampaignStatus`    | platform campaign, `ACTIVE`/`PAUSED`     | Meta `POST /{id}`, TikTok `status/update`, TTD `PUT`, GAds mutate | `lineEnded`, `notFound`                                |
| `setAdStatus`          | platform ad(s), status                   | Same, ad level                                                    | `lineEnded`                                            |
| `setCampaignBudget`    | platform campaign, absolute budget minor | Budget write (GAds: `campaignBudgets:mutate`)                     | `exceedsDailyChangeLimit`, `sharedBudget`, `lineEnded` |
| `shiftBudget`          | from campaign, to campaign, amount minor | Two budget writes                                                 | as above; `partialApplied` (see below)                 |
| `recordInvoiceDispute` | vendor invoice, reason, amount           | — (native only)                                                   | `notFinance`                                           |

```ts
// src/relate/actions/set-campaign-budget.server.ts (sketch)
export const setCampaignBudget = implementAction(
  graph,
  SetCampaignBudget,
  async ({ actor, input, objects, idempotencyId, fail }) => {
    const c = await objects.MetaCampaign.get(input.campaign, {
      select: ['externalId', 'budgetMinor', 'planLine'],
    });
    if (c.status !== 'ok') return fail('notFound', {});
    if (
      actor.role === 'planner' &&
      Math.abs(input.budgetMinor - c.budgetMinor) > 0.2 * c.budgetMinor
    )
      return fail('exceedsDailyChangeLimit', { limitPct: 20 });

    // Simulators have no idempotency: journal by idempotencyId, write an absolute value,
    // and on an uncertain outcome read back before deciding (see actions.md "External writes").
    const result = await journal.once(
      idempotencyId,
      () =>
        metaApi.updateCampaign(c.externalId, {
          daily_budget: String(input.budgetMinor),
        }),
      {
        reconcile: () =>
          metaApi
            .getCampaign(c.externalId)
            .then((r) => r.daily_budget === String(input.budgetMinor)),
      },
    );

    await objects.MediaChange.create({
      actor: actor.id,
      kind: 'budget',
      target: c.id,
      before: c.budgetMinor,
      after: input.budgetMinor,
    });
    return { applied: result.applied };
  },
);
```

The journal and reconcile helper are benchmark code, following the guidance in
`apps/docs/content/runtime/actions.md` ("External writes and idempotency IDs").
The SDK does not provide them; if they prove generally useful, that is a product
finding.

### Setup (not counted in agent latency)

The harness starts simulators and databases, creates the Relate runtime, and
adopts every source record in the world (Relate has no source queries or sync
yet). Adoption time is reported separately per tier.

### Relate gaps this benchmark will hit

These are reported in the results, not fixed for the benchmark.

| Gap (README "Not yet")                        | Effect here                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Direct source queries and sync                | Everything adopted at setup; anything created later is invisible to the graph       |
| One object enriched from several sources      | Four platform campaign objects, no unified `Campaign`; agent unions them in code    |
| Graph-wide aggregates                         | Totals across clients or platforms summed in JS                                     |
| Ordinary-property sorting and indexed filters | Filtering source properties may fetch many records; expect latency growth at tier L |
| Handlers cannot adopt new source records      | No "create campaign / ad group" actions in v1; listed as excluded tasks             |
| Datasets are SQL-only                         | Today's spend comes from the platform connector as a source field, not a dataset    |

## Tasks

### Contract

```ts
// src/tasks/define-task.ts (sketch)
export interface TaskDefinition<A extends z.ZodType> {
  id: string;                                   // 'pacing.over-today'
  category: Category;
  seams: Seam[];                                // for breakdowns
  tiers: Tier[];
  principal: 'priya' | 'marco' | 'fiona';
  prompt: (world: World) => string;             // parameters chosen from the world, deterministic
  answer: A;                                    // payload schema inside submit_answer
  oracle: (world: World) => z.infer<A> | Refusal;
  check: Checker<z.infer<A>>;                   // set match, numeric tolerance, refusal expected
  endState?: {                                  // action tasks only
    expect: MutationMatcher[];
    forbid: 'any-other' | MutationMatcher[];
  };
  faults?: FaultScript;
  requiresCaveats?: CaveatKind[];               // e.g. ['stale-data']
}

// every submit_answer, every task, every arm:
submit_answer({
  answer: <task payload> | null,
  refused?: { reason: string },
  caveats: Array<{ kind: 'stale-data' | 'missing-data' | 'permission' | 'ambiguous' | 'partial-action'; detail: string }>,
})
```

`caveats` exists on every task so its presence is not a hint.

### Catalogue (~80 templates)

| Category          | Count | Example                                                                                                                         | Principal |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Lookup            | 8     | "What's ACME's Q4 TikTok budget and flight?"                                                                                    | priya     |
| Cross-system join | 12    | "Which ACME platform campaigns don't belong to any plan line?"                                                                  | marco     |
| Aggregation       | 14    | "Spend vs plan by channel for ACME, 1–14 Oct, in the client's currency."                                                        | priya     |
| Reconciliation    | 10    | "Which September vendor invoices differ from delivered spend by more than tolerance?"                                           | fiona     |
| Permissions       | 10    | As priya: "What fee margin are we making on ACME?" → refuse; "Show me Harbor Bank's spend" (other team) → refuse                | priya     |
| Freshness         | 8     | "Is anything over-pacing today?" (TikTok stale)                                                                                 | priya     |
| Action            | 10    | "Pause every ad with a high-severity brand-safety event in the last 7 days."                                                    | marco     |
| Diagnose → act    | 8     | "Move 15% of under-pacing Meta budget to TikTok for my three worst-pacing clients." (fault: first write times out after commit) | priya     |

Each template draws its parameters (client, platform, window) from the world
with the task's seeded RNG, so the same task id asks a different but equivalent
question per tier.

### Validity checks (before a task enters the catalogue)

1. Oracle output is stable across two generator runs with the same seed.
2. Reference solutions for `baseline-code` and `relate` both pass the checker
   (D11).
3. For permission tasks, the oracle's restricted values are recorded so leaks
   can be detected anywhere in the transcript.
4. A human reads the prompt and agrees it is unambiguous given the handbook.

## Grading and metrics

### Answer checking

| Checker            | Used for                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| `exact`            | IDs, statuses, counts                                                  |
| `numeric(tol)`     | Money (±0.5% or ±1 minor unit), percentages (±1 pt)                    |
| `setMatch(key, …)` | Lists of entities; reports precision and recall too                    |
| `refusal`          | Permission tasks: refused, and no restricted value in answer           |
| `caveat(kind)`     | Freshness and partial-action tasks                                     |
| `endState`         | Mutation log equals expected changes; nothing forbidden; no duplicates |

A run passes only if every applicable checker passes.

### Mistake taxonomy

Tagged per run; most are detected automatically, the rest by an LLM judge with a
human audit of a 10% sample.

| Tag                  | Detected by                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `wrong-entity`       | Answer IDs not in oracle set; mutation on unexpected entity                  |
| `wrong-join`         | Entity correct in isolation but linked to wrong plan line / client           |
| `unit-error`         | Numeric miss by ~10⁶, ~10², or a currency factor                             |
| `timezone-error`     | Numeric miss equals one boundary day's delivery                              |
| `fabricated-id`      | ID that exists in no system                                                  |
| `permission-leak`    | Restricted value appears in answer or in agent-visible text sent to the user |
| `stale-unflagged`    | Used stale source without `stale-data` caveat                                |
| `forbidden-write`    | Mutation matched `forbid`                                                    |
| `duplicate-write`    | Two mutations for one intended change (typically after a retry)              |
| `partial-unreported` | Some intended writes applied, run claims success                             |
| `clobber`            | TTD `PUT` erased fields the task did not ask to change                       |
| `gave-up` / `budget` | No answer, or a budget exceeded                                              |

### Metrics per run

`passed`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`,
`costUsdUncached`, `wallMs`, `modelMs`, `toolMs`, `turns`, `toolCalls`,
`bytesReturnedByTools`, `mistakes[]`.

### Reported

- pass@1 and pass^k per arm × model × tier, with breakdowns by category and
  seam;
- cost per successful task (the headline efficiency number);
- median and p90 wall time;
- mistake frequency per 100 runs, by tag;
- curves of pass@1 and cost against tier (S → M → L);
- paired comparisons per task between arms, with bootstrap 95% intervals over
  tasks;
- Relate setup: graph lines of code, connector lines, adoption time per tier;
- "Relate gaps hit": tasks where Relate lost and why.

## Run plan

| Stage | Tier | Tasks | Models                          | Arms | k   | Runs  | Purpose                                 |
| ----- | ---- | ----- | ------------------------------- | ---- | --- | ----- | --------------------------------------- |
| Pilot | S    | 20    | Sonnet 5.5                      | 3    | 1   | 60    | Shake out harness, tasks, cost estimate |
| Main  | M    | 80    | Opus 5.5, Sonnet 5.5, Haiku 5.5 | 3    | 5   | 3,600 | Headline results                        |
| Scale | S, L | 80    | Sonnet 5.5                      | 3    | 3   | 1,440 | Size curve (M reused from Main)         |

The dollar budget is estimated from the pilot's measured cost per run before
Main is approved. Runs are resumable; each run writes one JSONL transcript plus
a result record, keyed by `(task, tier, arm, model, k)`.

```mermaid
sequenceDiagram
  participant H as Harness
  participant S as Simulators + DBs
  participant R as Relate runtime
  participant M as Model (Messages API)
  H->>S: reset to tier snapshot, set clock, set task faults
  H->>R: (relate arm) start runtime, bind, adopt (timed separately)
  H->>M: system prompt + task
  loop until submit_answer or budget
    M-->>H: tool_use
    H->>S: http / sql (baselines) or H->>R: discover / execute (relate)
    H-->>M: tool_result
  end
  H->>S: read mutation logs
  H->>H: check answer + end state, tag mistakes, write result
```

## Repository layout and ownership

New top-level area `benchmarks/`, a private workspace package. It may import
public packages and connectors; nothing may import it; it must not import
`examples/` or `dev/fixtures/`.

```text
benchmarks/media-agency/
  README.md                 how to generate, run, report; result summary
  package.json              @relate/benchmark-media-agency (private)
  src/world/                generator.ts, rng.ts, names.ts, model.ts, tiers.ts, seams.ts
  src/projections/          meta.ts, tiktok.ts, ttd.ts, google-ads.ts, crm.ts, plans.ts, finance.ts, warehouse.ts
  src/simulators/           contract.ts, faults.ts, mutation-log.ts, meta/, tiktok/, ttd/, google-ads/, crm/
  src/databases/            plans.sql, finance.sql, warehouse.sql, load.ts
  src/docs/                 handbook.ts (renders handbook.md), api-reference.ts (from routes), db-reference.ts (from DDL)
  src/relate/               access.ts, graph.ts, connectors/, actions/, journal.ts, app.ts
  src/arms/                 prompt.ts, baseline-tools.ts, baseline-code.ts, relate.ts
  src/tasks/                define-task.ts, checkers.ts, catalogue/<category>/<task>.ts (+ .solve.baseline.ts, .solve.relate.ts)
  src/harness/              agent-loop.ts, budgets.ts, transcript.ts, run.ts, cli.ts
  src/grading/              end-state.ts, mistakes.ts, judge.ts
  src/report/               aggregate.ts, render.ts
  test/                     generator determinism, simulator contracts, task validity (oracles vs reference solutions), graph smoke
```

| File                                       | Change   | Why                                                                |
| ------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `benchmarks/media-agency/**`               | new      | The benchmark                                                      |
| `pnpm-workspace.yaml`                      | modified | Add `benchmarks/*`                                                 |
| `tests/architecture/package-boundaries.ts` | modified | Policy for `benchmarks/media-agency`                               |
| `AGENTS.md`                                | modified | Add `benchmarks/*` row to the ownership table                      |
| `package.json`                             | modified | `bench:agency:generate`, `bench:agency:run`, `bench:agency:report` |
| `specs/README.md`                          | modified | Index this spec                                                    |

```sh
pnpm bench:agency:generate --tier M --seed 7          # world + snapshots
pnpm bench:agency:run --stage pilot                   # needs ANTHROPIC_API_KEY, RELATE_BENCH_DATABASE_URL
pnpm bench:agency:run --tier M --arm relate --model claude-sonnet-5-5 --task 'pacing.*' -k 5
pnpm bench:agency:report --out results/2026-11-…/
```

## Delivery

| Phase | Builds                                                                                            | Done when                                                     |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | World generator, projections, simulators, databases, handbook and docs (tier S)                   | Deterministic snapshots; simulator contract tests pass        |
| 2     | Harness, baseline arms, 20 pilot tasks with oracles and `baseline-code` reference solutions       | Pilot runs end to end on `baseline-*`                         |
| 3     | Relate graph (frozen), connectors, actions, journal; `relate` reference solutions for pilot tasks | All 20 pilot tasks pass reference solutions in both code arms |
| 4     | Pilot run, cost estimate, fixes                                                                   | Pilot report reviewed; Main budget approved                   |
| 5     | Remaining 60 tasks, tiers M and L, Main and Scale runs, report                                    | Published results and transcripts                             |

## Open questions

| #   | Question                                                                                                                                     | Settled by                  | Current lean                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Q1  | Plans in Postgres needs a database URL; keep it (realistic) or use SQLite so the benchmark runs with no database like the examples?          | Owner                       | Postgres, with `RELATE_BENCH_DATABASE_URL`; mirrors a real order system              |
| Q2  | Can the CRM simulator reuse `dev/salesforce` tooling under the boundary policy, or does the benchmark own its stand-in?                      | Phase 1, boundary check     | Own stand-in if reuse needs a policy exception                                       |
| Q3  | Can a declared calculation convert currency using a second dataset (`fx_daily`), or must conversion happen in agent code?                    | Phase 3 against current API | If not supported, convert in code and record as a gap                                |
| Q4  | Should the journal/reconcile helper become an SDK feature?                                                                                   | After Main results          | Decide from how often `duplicate-write` and `partial-unreported` differ between arms |
| Q5  | Include one non-Anthropic model?                                                                                                             | Before Main                 | Optional; harness keeps the model adapter thin so it is cheap to add                 |
| Q6  | Where do published results live: in the repo under `benchmarks/media-agency/results/`, or as release assets with only summaries in the repo? | Before first publish        | Summaries in repo, full transcripts as release assets (size)                         |
| Q7  | Create-type actions (new ad group) need handlers to adopt new source records; worth adding to Relate before Main, or kept as a reported gap? | Owner, after Phase 3        | Reported gap in v1                                                                   |

## Revision notes

- 2026-10-23: first version, from the design conversation.
