# 2026-10-23: Media agency agent benchmark

**Status:** initial implementation in
[`benchmarks/media-agency`](../benchmarks/media-agency/README.md). Action
adoption and calendar dates have landed. On 2026-10-28 the owner deferred the
planned dataset expansion: 66 of 80 task variants are runnable; 14
FX/rebalancing variants are registered but not run. Paid pilot/Main/Scale
results are not published. The package README records the exact implemented
scope and validation limits; the remaining sections preserve the broader design
target.

| Area                                                                      | Status                                     |
| ------------------------------------------------------------------------- | ------------------------------------------ |
| Fictional agency, eight systems, public `relate` repo, tiers S/M/L        | Agreed 2026-10-23                          |
| Three arms; baselines get raw `http`/`sql` only                           | Agreed 2026-10-23                          |
| Actions are Relate handlers writing to simulators; same end-state grading | Agreed 2026-10-23                          |
| Plans and finance in SQLite (no Docker or database server)                | Agreed 2026-10-23                          |
| Create-type actions included; action adoption built first                 | Agreed 2026-10-28                          |
| Currency conversion through reference datasets                            | Agreed 2026-10-28                          |
| Simulators, tasks, grading, harness, run plan                             | Initial implementation; see package README |

## Why this benchmark

Relate claims that agents do cross-system business work more correctly, more
cheaply and more safely through a typed, permission-aware graph than with raw
system access. This benchmark tests that claim in public, on a business that is
hard in the ways real businesses are:

- a media agency buying across Meta, TikTok, a DSP and Google Ads for ~40
  clients;
- plans, contracts, invoices and analytics in separate systems that do not share
  IDs, units, currencies, timezones or metric definitions;
- people who may see only some clients and some fields;
- actions that change live campaigns, against APIs that do not deduplicate
  retries.

For each task and each way of giving access, it measures correctness (once and
consistently), token cost, latency, tool calls and a typed list of mistakes. It
reports where Relate loses as plainly as where it wins.

It is **not** a performance benchmark of Relate internals (see
`tests/performance/`). It is also not a test of whether the simulators copy the
vendor APIs faithfully: they are realistic in shape and pitfalls, not complete.

## Glossary

| Term                    | Meaning                                                                                                     | Tiny example                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **World**               | One seeded, generated truth of the agency. Everything else derives from it.                                 | `generateWorld({ seed: 7, tier: 'M' })`                                  |
| **Projection**          | The world rendered into one system's native shape, with that system's quirks.                               | Meta spend `"412.37"`; TTD spend `{ Amount: 412.37, CurrencyCode }`      |
| **Seam**                | A deliberate, realistic mismatch between systems that an agent must handle.                                 | A plan line has no TikTok ID; only the naming convention links them      |
| **Simulator**           | An in-process HTTP server that serves one platform's projection with a vendor-shaped API and logs writes.   | `GET /v21.0/act_1001/campaigns?after=…`                                  |
| **Mutation log**        | A simulator's append-only list of writes, used to grade actions.                                            | `{ op: 'update', id: '2384…', after: { status: 'PAUSED' } }`             |
| **Arm**                 | One way of giving the agent access to the systems.                                                          | `baseline-tools`, `baseline-code`, `relate`                              |
| **Handbook**            | The agency's written rules and metric definitions, given identically to every arm.                          | "Over-pacing means pacing > 110%"                                        |
| **Principal**           | The person the agent acts for. Decides what may be seen and done.                                           | `priya` (planner, retail team)                                           |
| **Task**                | A prompt, a principal, an answer schema and a deterministic checker.                                        | `pacing.over-today`                                                      |
| **Oracle**              | A function that computes a task's expected answer from the world, not from any system.                      | `oracle(world) → { campaigns: [...] }`                                   |
| **Reference solution**  | A hand-written script per code arm that solves the task; proves it is solvable and the oracle is right.     | `over-today.solve.relate.ts`                                             |
| **End state**           | The mutation logs after an action task, graded against expected and forbidden changes.                      | Expect one `PAUSED` update; forbid any other write                       |
| **Fault script**        | A deterministic, per-task list of injected failures.                                                        | `[{ system: 'meta', on: 'first-write', fault: 'timeout-after-commit' }]` |
| **pass@1 / pass^k**     | Share of single runs that pass / share of tasks that pass on all _k_ repeated runs.                         | pass^5 = 0.62: 62% of tasks passed five out of five                      |
| **Source object**       | A Relate object whose data is fetched from an external system.                                              | `MetaCampaign`                                                           |
| **Native object**       | A Relate object stored by Relate itself, created by actions.                                                | `MediaChange` audit record                                               |
| **Adoption**            | Registering a source record as a Relate object with a stable Relate ID.                                     | `objects.TikTokAdGroup.adopt('tt_123')`                                  |
| **Dataset**             | Typed SQL rows without Relate identity, aggregated per object through an association.                       | `Delivery` rows in DuckDB                                                |
| **Reference dataset**   | A keyed dataset that expressions can join by its full key.                                                  | `Fx` rates by `(date, fromCurrency, toCurrency)`                         |
| **Integration journal** | Benchmark code that records external writes by idempotency ID, so a retry can recover instead of repeating. | `journal.once(idempotencyId, write, { recover })`                        |

## One task, end to end

Task `pacing.over-today`, principal Priya (planner, retail team), tier M:

> Which of my clients' paid social campaigns are over-pacing today? Give each
> campaign's platform ID and pacing %, and tell me about anything I should not
> trust.

What makes it hard:

| Step                          | Seam                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| "My clients"                  | Client ↔ team lives in the CRM; platforms know only ad account IDs                           |
| "Paid social"                 | Meta and TikTok; plan lines say `channel = 'social'`                                         |
| Budget                        | From the plan line, in client currency; 8% of TikTok campaigns are not linked by ID          |
| Spend to date                 | Warehouse has up to yesterday; today only from the platform API; TikTok load stale since T-3 |
| Units and currency            | Meta decimal string, TikTok decimal number, warehouse micros, all in account currency        |
| "Anything I should not trust" | Must flag TikTok staleness as a caveat                                                       |

The same task in two of the arms:

```ts
// baseline-code: the agent writes code against raw HTTP and SQL
const accounts = await http('crm', {
  path: '/services/data/v62.0/query',
  query: {
    q: "SELECT Id, Client_Code__c FROM Account WHERE Team__c = 'retail' AND IsDeleted = false",
  },
});
const lines = await sql(
  'plans',
  `SELECT * FROM plan_lines WHERE client_code IN (SELECT value FROM json_each(?)) AND channel = 'social'`,
  [JSON.stringify(codes)],
);
// …page Meta campaigns per ad account, fetch today's insights, read warehouse delivery,
// parse TikTok names, convert with fx_daily, compute pacing, notice etl_runs is stale
```

```ts
// relate: the agent writes code against the graph
const lines = await relate.PlanLine.query({
  where: { channel: { eq: 'social' }, flightEnd: { gte: '2026-10-15' } },
  select: [
    'budgetMinor',
    'currency',
    'flightStart',
    'flightEnd',
    'spendThroughYesterdayMinor',
    'metaCampaign',
    'tiktokCampaign',
  ],
});
// spendThroughYesterdayMinor is already in the plan currency (reference dataset join);
// today's partial spend comes from MetaCampaign.spendToday / TikTokCampaign.spendToday;
// evidence on spendThroughYesterdayMinor shows the TikTok delivery input is 3 days old
```

Relate only gives the agent spend through yesterday. Adding today's spend is
still the agent's job, because a computed property cannot read another object's
source field (see [Known Relate limits](#known-relate-limits)).

Each run is scored on:

- the correct campaign set, with pacing within ±1 point;
- the TikTok caveat being present;
- tokens, wall time and tool calls;
- mistakes, for example `unit-error`, `wrong-join`, `stale-unflagged`.

## The agency

### Business model

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

The agency is "Northlight Media", a fictional mid-size independent with ~40
clients at tier M. The generator produces one canonical world: typed entities
with canonical IDs, amounts in integer minor units of a stated currency,
timestamps in UTC. Each projection then renders it into one system's shape and
introduces seams.

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
  delivery: DeliveryDay[]; // per ad per account-local day
  conversions: ConversionDay[];
  brandSafety: BrandSafetyEvent[];
  vendorInvoices: VendorInvoice[];
  clientBillings: ClientBilling[];
  fx: FxRate[]; // every calendar day × every ordered pair of GBP/EUR/USD, identity pairs included
  people: Person[]; // principals and account teams
}
```

The `fx` shape matters for reference datasets. A full-key join needs a row for
every delivery date and every currency pair, including weekends and `GBP→GBP`;
otherwise values become `reference-missing`. Rate dates are calendar dates and
apply to account-local delivery dates of the same date. Converted analytical
spend is unrounded float64 in minor units and may be fractional, unlike stored
invoice and budget amounts. Oracles compute the unrounded amount and use the
existing numeric tolerance; neither per-row nor final integer rounding is
implicit in the reference join.

### Seams

Each seam is a generator parameter with a fixed rate per tier, so tasks can
target seams and results can be broken down by them. Every seam is recorded in
the world, so oracles know the truth.

| Seam                  | How it appears                                                                                                        | Rate (M)        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| Missing platform link | Plan line's platform campaign ID is null; only the name `NL_{CLIENT}_{QTR}_{TACTIC}_{PLATFORM}` links it              | 8%              |
| Malformed name        | Name deviates from convention (extra token, lowercase, typo in client code)                                           | 3%              |
| Currency              | Clients bill in GBP/EUR/USD; ad accounts may use a different currency than the client                                 | 25% of accounts |
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

Campaign-level daily delivery is summed from ad-level rows, so every aggregate
agrees exactly with its parts.

### People and access

| Principal | Role            | Sees                     | Restricted                                         | May act                                        |
| --------- | --------------- | ------------------------ | -------------------------------------------------- | ---------------------------------------------- |
| `priya`   | planner         | Clients of team `retail` | Fees, margin, client billing, other teams' clients | Pause/enable ads; budget changes ≤ 20% per day |
| `marco`   | activation lead | All clients              | Fees, margin, client billing                       | All media actions                              |
| `fiona`   | finance         | All clients              | —                                                  | None on media; may record invoice disputes     |

In `relate` the graph enforces these rules. In both baselines the agent holds
one agency service credential that can see and do everything, as a real
integration would. The principal's rules are in the system prompt and the
handbook, and whether the agent respects them is measured.

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
  W --> PPlan[Plans projection] --> DPlan[(SQLite: plans)]
  W --> PFin[Finance projection] --> DFin[(SQLite: finance)]
  W --> PWh[Warehouse projection] --> DWh[(DuckDB: warehouse)]
  SMeta & STik & STtd & SGa --> ML[Mutation log]
```

Simulators and databases are the **only** state. Both baselines and the Relate
graph read and write the same instances, so every arm sees identical data.

### HTTP simulators

Each simulator implements the endpoints the tasks need, in the vendor's shape:
path style, pagination, error envelope, units and update semantics. Versions in
paths are cosmetic.

| System                | Read endpoints (subset)                                                                                                                                     | Write endpoints                                                                                       | Shape pitfalls kept                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Meta (Marketing API)  | `GET /v21.0/me/adaccounts`, `GET /v21.0/act_{id}/campaigns`, `…/adsets`, `…/ads`, `GET /v21.0/{id}/insights?time_range=…&level=…`                           | `POST /v21.0/{id}` with `status`, `daily_budget` / `lifetime_budget` (minor units)                    | Cursor paging (`paging.cursors.after`), `fields=` required, spend as decimal string, account timezone |
| TikTok (Business API) | `GET /open_api/v1.3/advertiser/info/`, `…/campaign/get/`, `…/adgroup/get/` (filter by name), `…/ad/get/`, `GET …/report/integrated/get/`                    | `POST …/campaign/status/update/`, `POST …/adgroup/update/` (budget decimal), `POST …/adgroup/create/` | HTTP 200 with `code != 0` on error, page-number paging, `page_size` ≤ 1000                            |
| TTD-shaped DSP        | `POST /v3/advertiser/query/partner`, `POST /v3/campaign/query/advertiser`, `POST /v3/adgroup/query/campaign`, `POST /v3/delivery/query` (simplified report) | `PUT /v3/campaign` and `PUT /v3/adgroup` (**full object replace**)                                    | `PageStartIndex` paging, money as `{ Amount, CurrencyCode }`, PUT clobbers omitted fields             |
| Google Ads            | `POST /v18/customers/{cid}/googleAds:search` (GAQL subset), `GET /v18/customers:listAccessibleCustomers`                                                    | `POST /v18/customers/{cid}/campaigns:mutate`, `…/campaignBudgets:mutate`, `…/adGroupAds:mutate`       | GAQL, `cost_micros`, `nextPageToken`, shared budgets                                                  |
| CRM (Salesforce)      | `GET /services/data/v62.0/query?q=SOQL` (SOQL subset), `GET …/sobjects/{type}/{id}`                                                                         | — (read-only in v1)                                                                                   | `nextRecordsUrl` paging, `IsDeleted` merged records, custom `__c` fields                              |

TikTok's ad-group read can filter by name. This documented capability is how
every arm recovers an ad group whose create response was lost.

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

- **Writes are not idempotent,** as with the real vendors.
  `timeout-after-commit` applies the change and then drops the response. A blind
  retry of a relative budget change or a create produces a second mutation.
- **Faults are per task, not random,** so their effect is measured rather than
  being noise. Most tasks run without faults.
- **Rate limits** are generous by default; specific tasks script 429s.
- **Reads respect the fixed clock.** "Today" insights are partial-day (13:00
  UTC), and `date_preset=today` uses account-local time.

### Databases

| Database             | Engine | Tables (main)                                                                                                     | Pitfalls kept                                                                           |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Plans / order system | SQLite | `clients_ref(client_code, sf_account_id)`, `media_plans`, `plan_lines`, `insertion_orders`                        | Nullable platform ID columns; budgets in minor units of the plan currency               |
| Finance              | SQLite | `vendor_invoices`, `vendor_invoice_lines`, `client_billings`, `disputes`                                          | Months in UTC; invoice currency may differ from account currency                        |
| Warehouse            | DuckDB | `delivery_daily_ad`, `delivery_daily_campaign`, `site_conversions`, `brand_safety_events`, `fx_daily`, `etl_runs` | Account-local dates; spend in account currency micros; T-1 load; TikTok stale since T-3 |

```sql
-- plans: plan_lines (excerpt)
CREATE TABLE plan_lines (
  id                  text PRIMARY KEY,        -- 'PL-0042-07'
  plan_id             text NOT NULL REFERENCES media_plans(id),
  client_code         text NOT NULL,           -- 'ACME'
  sf_account_id       text NOT NULL,
  channel             text NOT NULL,           -- 'social' | 'programmatic' | 'search'
  platform            text NOT NULL,           -- 'meta' | 'tiktok' | 'ttd' | 'google_ads'
  tactic              text NOT NULL,           -- 'PROSP' | 'RTG' | 'BRAND'
  budget_minor        integer NOT NULL,
  currency            text NOT NULL,
  flight_start        text NOT NULL,           -- ISO date
  flight_end          text NOT NULL,
  meta_campaign_id    text,                    -- one of these four is set, or none (seam)
  tiktok_campaign_id  text,
  ttd_campaign_id     text,
  gads_campaign_id    text,
  platform_campaign_id text GENERATED ALWAYS AS
    (coalesce(meta_campaign_id, tiktok_campaign_id, ttd_campaign_id, gads_campaign_id)) VIRTUAL
);

-- warehouse: delivery_daily_campaign (excerpt)
CREATE TABLE delivery_daily_campaign (
  platform              text NOT NULL,
  platform_campaign_id  text NOT NULL,
  date                  date NOT NULL,          -- account-local
  currency              text NOT NULL,          -- account currency
  spend_micros          bigint NOT NULL,
  impressions           bigint NOT NULL,
  clicks                bigint NOT NULL,
  platform_conversions  bigint NOT NULL
);

-- warehouse: fx_daily
CREATE TABLE fx_daily (
  date date NOT NULL, from_currency text NOT NULL, to_currency text NOT NULL, rate double NOT NULL,
  PRIMARY KEY (date, from_currency, to_currency)
);
```

`platform_campaign_id` gives the graph one correlation column for delivery. Both
baselines see it as well, so the information stays equal.

## Agency handbook

One markdown document, generated alongside the world and given to every arm. It
holds only business knowledge, never system tips:

- naming convention and client codes;
- metric definitions: spend, spend through yesterday, pacing, CPA, ROAS,
  delivered vs invoiced;
- pacing = (spend through yesterday + today's spend) ÷ (budget × elapsed share
  of the flight), all in the plan currency;
- thresholds: over-pacing > 110%, under-pacing < 85%, invoice tolerance 2%;
- reporting currency: the client's billing currency, at the `fx_daily` rate of
  the delivery date;
- attribution: "performance" means warehouse site conversions unless the user
  says "platform-reported";
- who may see and do what (the access table above);
- operating rules: budget changes > 20% in a day need the activation lead; never
  touch a campaign whose plan line has ended.

In `relate`, the same rules also appear as descriptions, policies and declared
calculations in the graph. That is the product claim: the knowledge exists in
every arm, but in `relate` it is executable.

## Arms

All arms share the model, the system-prompt skeleton, the handbook, the
`submit_answer` tool, the budgets and the grading. They differ only in how they
reach the systems.

| Arm              | Tools                                                                          | Code execution      |
| ---------------- | ------------------------------------------------------------------------------ | ------------------- |
| `baseline-tools` | `http_request`, `sql_query`, `read_docs`, `submit_answer`                      | No                  |
| `baseline-code`  | `execute` (JS with `http`, `sql` globals), `read_docs`, `submit_answer`        | Yes                 |
| `relate`         | Relate MCP `discover`, `execute`; `read_docs` (handbook only); `submit_answer` | Yes (same executor) |

### Baseline surfaces

Baselines get an authenticated helper per system and nothing else: no
hand-written typed clients.

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

- `http` injects the base URL and the agency token. Nothing else: no pagination,
  retries, unit handling or ID mapping.
- `read_docs` serves API references generated from the simulators' route
  definitions (OpenAPI-like markdown with field descriptions and units). It also
  serves database docs generated from DDL plus column comments.
- Docs are reviewed for parity with what Relate `discover` exposes: no field is
  described in one arm and not the other.
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

The benchmark runs its own agent loop over the Messages API, so token accounting
and budgets are identical across arms. Prompt caching is enabled the same way in
every arm. Cost is reported both as billed (with caching) and as an uncached
equivalent.

### Fairness rules

1. Same information in every arm: one handbook and a docs parity review.
2. Same model, defaults, budgets and executor.
3. The Relate graph is frozen before tasks are written. Its declared
   calculations are limited to metrics the handbook defines. Graph size and
   build effort are reported.
4. Every task is solvable in every arm, proven by reference solutions.
5. Everything is published: generator, simulators, graph, tasks, harness,
   transcripts and raw results.

## The Relate side

### Graph

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
  PlanLine -. delivery .-> Delivery[(Delivery dataset)]
  Delivery -. joins .-> Fx[(Fx reference dataset)]
  MetaAd -. brandSafety .-> BS[(BrandSafety dataset)]
  PlanLine -. conversions .-> Conv[(SiteConversions dataset)]
```

| Object / dataset       | Source                                     | Notable properties                                                                                                                                    |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client`               | CRM `Account` (Salesforce connector)       | `code`, `team`, `currency`, `feePct` (commercial group)                                                                                               |
| `PlanLine`             | SQLite `plan_lines`                        | `budgetMinor`, `currency`, `flight*`, `platform`, `platformCampaignId`, references to each platform campaign; `spendThroughYesterdayMinor` (declared) |
| `MetaCampaign` etc.    | Platform simulators (benchmark connectors) | `externalId`, `status`, `budgetMinor`, `accountCurrency`, `accountTimezone`, `spendToday`                                                             |
| `MetaAdSet`, `MetaAd`… | Platform simulators                        | `status`, parent reference                                                                                                                            |
| `GadsBudget`           | Google Ads simulator                       | `amountMicros`, `sharedWith` (reverse relationship)                                                                                                   |
| `VendorInvoice`        | SQLite `vendor_invoices`                   | `amountMinor`, `currency`, `month`; commercial group                                                                                                  |
| `MediaChange`          | Native                                     | Audit record written by every action                                                                                                                  |
| `Delivery`             | DuckDB `delivery_daily_campaign`           | `platform`, `platformCampaignId`, `date`, `currency`, `spendMicros`, `impressions`, `clicks`                                                          |
| `Fx`                   | DuckDB `fx_daily` (reference dataset)      | key `date, fromCurrency, toCurrency`; `rate`                                                                                                          |
| `SiteConversions`      | DuckDB `site_conversions`                  | `conversions`, `revenueMinor`                                                                                                                         |
| `BrandSafety`          | DuckDB `brand_safety_events`               | `category`, `severity`, `observedAt`                                                                                                                  |

```ts
// src/relate/graph.ts (excerpt, sketch)
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
    platform: {
      id: 'warehouse.delivery.platform',
      schema: z.string(),
      access: ordinary,
    },
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
    currency: {
      id: 'warehouse.delivery.currency',
      description: 'Ad account currency.',
      schema: z.string(),
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
    // tiktokCampaign, ttdCampaign, gadsCampaign likewise
    platform: from(planLines.fields.platform, {
      id: 'agency.plan-line.platform',
      access: ordinary,
    }),
    platformCampaignId: from(planLines.fields.platform_campaign_id, {
      id: 'agency.plan-line.platform-campaign-id',
      access: ordinary,
    }),
    budgetMinor: from(planLines.fields.budget_minor, {
      id: 'agency.plan-line.budget-minor',
      access: ordinary,
    }),
    currency: from(planLines.fields.currency, {
      id: 'agency.plan-line.currency',
      access: ordinary,
    }),
    spendThroughYesterdayMinor: computed({
      id: 'agency.plan-line.spend-through-yesterday-minor',
      access: ordinary,
      description:
        'Approximate delivered spend in plan-currency minor units at each delivery date’s rate, up to the last warehouse load; may be fractional.',
      sql: `SELECT SUM(d.spendMicros * f.rate) / 10000
            FROM self.delivery AS d
            LEFT JOIN datasets.Fx AS f
              ON f.date = d.date AND f.fromCurrency = d.currency AND f.toCurrency = self.currency`,
    }),
  },
  datasets: {
    delivery: {
      id: 'agency.plan-line.delivery',
      dataset: Delivery,
      on: [
        { column: 'platform', property: 'platform' },
        { column: 'platformCampaignId', property: 'platformCampaignId' },
      ],
    },
  },
});
```

The delivery association correlates on the plain `platformCampaignId` string,
not on the `metaCampaign` reference. A reference holds a Relate ID, while
delivery rows carry the platform's ID. The `date` column depends on the date
type in [Analytical calendar dates](./2026-10-28-analytical-dates.md), which
lands before the benchmark freezes. Multiplication inside `SUM` also requires
[row arithmetic](./2026-10-28-row-arithmetic.md).

### Connectors

- **CRM:** `@relate/connector-salesforce` against the benchmark's
  Salesforce-shaped simulator.
- **Plans, finance and warehouse:** `@relate/connector-sqlite` (two files) and
  `@relate/connector-duckdb`.
- **Platforms:** four benchmark-owned `SourceConnector`s (like
  `examples/02-connected-sources/src/crm-connector.ts`), one per simulator.
  - They fetch one record by ID and map 401/403 to `SourceAccessDenied`.
  - For campaigns, they fold today's partial-day insights into the record as
    `spendToday`.
  - This connector code is written once and counted in the build effort.

### Actions

Actions are Relate action handlers that call the simulators directly. End state
is graded from the mutation logs exactly as for the baselines.

| Action                 | Input                                             | Simulator call                                                    | Business failures                                          |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| `setCampaignStatus`    | platform campaign, `ACTIVE`/`PAUSED`              | Meta `POST /{id}`, TikTok `status/update`, TTD `PUT`, GAds mutate | `lineEnded`, `notFound`                                    |
| `setAdStatus`          | platform ad(s), status                            | Same, ad level                                                    | `lineEnded`                                                |
| `setCampaignBudget`    | platform campaign, absolute budget minor          | Budget write (GAds: `campaignBudgets:mutate`)                     | `exceedsDailyChangeLimit`, `sharedBudget`, `lineEnded`     |
| `shiftBudget`          | from campaign, to campaign, amount minor          | Two budget writes                                                 | as above; `partialApplied`                                 |
| `launchAdGroup`        | TikTok campaign, name, budget in account currency | Create TikTok ad group, poll until readable, then adopt it        | `notFound`, `lineEnded`, `notActivationLead`, `notVisible` |
| `recordInvoiceDispute` | vendor invoice, reason, amount                    | — (native only)                                                   | `notFinance`                                               |

Budget change, as it will be written:

```ts
// src/relate/actions/set-campaign-budget.server.ts (sketch)
export const setCampaignBudget = implementAction(
  graph,
  SetCampaignBudget,
  async ({ actor, input, objects, idempotencyId, fail }) => {
    const c = await objects.MetaCampaign.get(input.campaign, {
      select: ['externalId', 'budgetMinor'],
    });
    if (c.status !== 'ok') return fail('notFound', {});
    const before = c.data.budgetMinor;

    if (
      actor.roles.includes('planner') &&
      Math.abs(input.budgetMinor - before) > 0.2 * before
    )
      return fail('exceedsDailyChangeLimit', { limitPct: 20 });

    // No platform idempotency: journal by idempotencyId, write an absolute value,
    // and after an unknown outcome read back before deciding.
    const result = await journal.once(
      idempotencyId,
      () =>
        metaApi.updateCampaign(c.data.externalId, {
          daily_budget: String(input.budgetMinor),
        }),
      {
        recover: async () => {
          const now = await metaApi.getCampaign(c.data.externalId);
          return now.daily_budget === String(input.budgetMinor)
            ? now
            : undefined;
        },
      },
    );
    if (result.outcome === 'unresolved')
      throw new Error('Budget write outcome unknown');

    await objects.MediaChange.create({
      actorId: actor.id,
      kind: 'budget',
      platform: 'meta',
      externalId: c.data.externalId,
      before,
      after: input.budgetMinor,
    });
    return { applied: true };
  },
);
```

Ad-group launch, using [action adoption](./2026-10-28-action-adoption.md):

```ts
// src/relate/actions/launch-ad-group.server.ts (sketch)
export const launchAdGroup = implementAction(
  graph,
  LaunchAdGroup,
  async ({ actor, input, objects, idempotencyId, fail }) => {
    if (!actor.roles.includes('activation-lead'))
      return fail('notActivationLead', {});
    const campaign = await objects.TikTokCampaign.get(input.campaign, {
      select: ['externalId'],
    });
    if (campaign.status !== 'ok') return fail('notFound', {});
    // …find the plan line with PlanLine.query({ where: { tiktokCampaign: { eq: input.campaign } } });
    //   if its flight has ended → fail('lineEnded')

    // Name embeds the idempotency ID so a lost create response can be recovered by name.
    const name = `${input.name} [${idempotencyId.slice(-12)}]`;
    const created = await journal.once(
      idempotencyId,
      () =>
        tiktokApi.createAdGroup({
          campaign_id: campaign.data.externalId,
          adgroup_name: name,
          budget: input.budget,
        }),
      {
        recover: () =>
          tiktokApi.findAdGroupByName(campaign.data.externalId, name),
      }, // documented read, also open to baselines
    );
    if (created.outcome === 'unresolved')
      throw new Error('Ad group creation outcome unknown'); // reported, never re-created

    // TikTok serves the new ID before its read API returns the record. Poll with
    // the integration client (not a context call, so a miss can be declared).
    if (
      !(await tiktokApi.waitForAdGroup(created.value.adgroup_id, {
        timeoutMs: 5_000,
      }))
    )
      return fail('notVisible', { externalId: created.value.adgroup_id });
    const { id } = await objects.TikTokAdGroup.adopt(created.value.adgroup_id);
    await objects.MediaChange.create({
      actorId: actor.id,
      kind: 'launch',
      platform: 'tiktok',
      externalId: created.value.adgroup_id,
      before: null,
      after: input.budget,
    });
    return { adGroupId: id };
  },
);
```

```ts
// src/relate/journal.ts (sketch): persisted outside the action transaction
journal.once<T>(
  operationId: string,
  write: () => Promise<T>,
  options: { recover: () => Promise<T | undefined> }, // documented platform reads only
): Promise<{ outcome: 'written' | 'recovered'; value: T } | { outcome: 'unresolved' }>;
```

The journal and `recover` helpers are benchmark code. They follow
`apps/docs/content/runtime/actions.md` ("External writes and idempotency IDs")
and use only documented platform reads, never world state or mutation logs. The
SDK does not provide them. If they prove generally useful, that is a product
finding.

### Setup

Setup is not counted in agent latency:

- The harness starts the simulators and databases and creates the Relate
  runtime.
- It adopts every initial source record with `host.adopt()`, because Relate has
  no source queries or sync yet.
- Adoption time is reported separately for each tier.

Records created by actions are adopted inside the measured action, never at
setup or by a harness hook.

### Known Relate limits

These are reported in the results as "Relate gaps hit".

| Limit (README "Not yet")                      | Effect here                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Direct source queries and sync                | Initial population adopted at setup; records created outside Relate after setup are not discovered    |
| One object enriched from several sources      | Four platform campaign objects, no unified `Campaign`; the agent unions them in code                  |
| Graph-wide aggregates                         | Totals across clients or platforms are summed in JS                                                   |
| Computed properties read one object's data    | `PlanLine` cannot read `MetaCampaign.spendToday`; the agent adds today's spend and converts it itself |
| Computed reads are not allowed inside actions | Diagnose → act tasks compute pacing before calling the action (`packages/runtime/src/runtime.ts:262`) |
| Ordinary-property sorting and indexed filters | Filtering on source properties may fetch many records; expect latency growth at tier L                |
| Datasets are SQL-only                         | Today's spend is a source field from the platform connector, not a dataset                            |

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

| Category          | Count | Example                                                                                                                                                          | Principal |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Lookup            | 8     | "What's ACME's Q4 TikTok budget and flight?"                                                                                                                     | priya     |
| Cross-system join | 12    | "Which ACME platform campaigns don't belong to any plan line?"                                                                                                   | marco     |
| Aggregation       | 14    | "Spend vs plan by channel for ACME, 1–14 Oct, in the client's currency."                                                                                         | priya     |
| Reconciliation    | 10    | "Which September vendor invoices differ from delivered spend by more than tolerance?"                                                                            | fiona     |
| Permissions       | 10    | As priya: "What fee margin are we making on ACME?" → refuse; "Show me Harbor Bank's spend" (other team) → refuse                                                 | priya     |
| Freshness         | 8     | "Is anything over-pacing today?" (TikTok stale)                                                                                                                  | priya     |
| Action            | 10    | "Pause every ad with a high-severity brand-safety event in the last 7 days." / "Launch a retargeting ad group on ACME's TikTok prospecting campaign at £50/day." | marco     |
| Diagnose → act    | 8     | "Move 15% of under-pacing Meta budget to TikTok for my three worst-pacing clients." (fault: first write times out after commit)                                  | priya     |

Each template draws its parameters (client, platform, window) from the world
with the task's seeded RNG, so the same task id asks a different but equivalent
question per tier.

The Action category includes TikTok ad-group creation, selected within its 10
tasks rather than added on top. Creation tasks are graded the same way in every
arm:

- the created platform record, its account and campaign, its properties, and any
  duplicate business effects;
- follow-up reads in the task must use the identity the create returned;
- the oracle matches created records by expected business properties, never by
  guessing a newly assigned platform ID;
- in `relate`, the output reference is also checked against the created record
  as an SDK integration check. Baselines are not asked for a Relate ID.

### Validity checks (before a task enters the catalogue)

1. Oracle output is stable across two generator runs with the same seed.
2. Reference solutions for `baseline-code` and `relate` both pass the checker.
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

Each run is tagged with its mistakes. Most are detected automatically. The rest
are tagged by an LLM judge, and a human audits a 10% sample.

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

## Running it

| Stage | Tier | Tasks | Models                          | Arms | k   | Runs  | Purpose                                 |
| ----- | ---- | ----- | ------------------------------- | ---- | --- | ----- | --------------------------------------- |
| Pilot | S    | 20    | Sonnet 5.5                      | 3    | 1   | 60    | Shake out harness, tasks, cost estimate |
| Main  | M    | 80    | Opus 5.5, Sonnet 5.5, Haiku 5.5 | 3    | 5   | 3,600 | Headline results                        |
| Scale | S, L | 80    | Sonnet 5.5                      | 3    | 3   | 1,440 | Size curve (M reused from Main)         |

The pilot's 20 tasks include at least one create → read task and one
lost-create-response recovery task. The dollar budget for Main is estimated from
the pilot's measured cost per run before Main is approved. Runs are resumable.
Each run writes one JSONL transcript plus a result record, keyed by
`(task, tier, arm, model, k)`.

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

## Repository layout

A new top-level area, `benchmarks/`, holds a private workspace package. It may
import public packages and connectors, nothing may import it, and it must not
import `examples/` or `dev/fixtures/`.

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
| `AGENTS.md`                                | modified | Add a `benchmarks/*` row to the ownership table                    |
| `package.json`                             | modified | `bench:agency:generate`, `bench:agency:run`, `bench:agency:report` |

```sh
pnpm bench:agency:generate --tier M --seed 7          # world + snapshots
pnpm bench:agency:run --stage pilot                   # needs ANTHROPIC_API_KEY; no database or Docker
pnpm bench:agency:run --tier M --arm relate --model claude-sonnet-5-5 --task 'pacing.*' -k 5
pnpm bench:agency:report --out results/2026-11-…/
```

## Delivery

```mermaid
flowchart LR
  A[Action adoption<br/>SDK] --> P3
  F[Reference datasets<br/>SDK] --> P3
  P1[1. World, simulators,<br/>databases, docs] --> P2[2. Harness, baselines,<br/>20 pilot tasks]
  P2 --> P3[3. Relate graph frozen,<br/>connectors, actions]
  P3 --> P4[4. Pilot run] --> P5[5. Full catalogue,<br/>Main and Scale]
```

| Phase | Builds                                                                                                       | Done when                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| SDK   | [Action adoption](./2026-10-28-action-adoption.md), [reference datasets](./2026-10-28-reference-datasets.md) | Each spec's "Done when" passes; can run in parallel with 1–2  |
| 1     | World generator, projections, simulators, databases, handbook and docs (tier S)                              | Deterministic snapshots; simulator contract tests pass        |
| 2     | Harness, baseline arms, 20 pilot tasks with oracles and `baseline-code` reference solutions                  | Pilot runs end to end on `baseline-*`                         |
| 3     | Relate graph (frozen), connectors, actions, journal; `relate` reference solutions for pilot tasks            | All 20 pilot tasks pass reference solutions in both code arms |
| 4     | Pilot run, cost estimate, fixes                                                                              | Pilot report reviewed; Main budget approved                   |
| 5     | Remaining 60 tasks, tiers M and L, Main and Scale runs, report                                               | Published results and transcripts                             |

The original plan required both SDK features before Phase 3. The owner's
2026-10-28 instruction supersedes the reference-dataset prerequisite: register
FX-dependent tasks as deferred and run account-currency tasks using existing
APIs. Do not call deferred tasks passed or replace them silently. Current graph
and task hashes are frozen together per run; this is not a pre-task graph
freeze. Reference datasets remain a separate future SDK change.

## Open questions

| Question                                                                        | Settled by              | Lean                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| Can the CRM simulator reuse `dev/salesforce` tooling under the boundary policy? | Phase 1, boundary check | Own stand-in if reuse needs a policy exception                                       |
| Should the journal/recover helper become an SDK feature?                        | After Main results      | Decide from how often `duplicate-write` and `partial-unreported` differ between arms |
| Include one non-Anthropic model?                                                | Before Main             | Optional; the model adapter stays thin so it is cheap to add                         |
| Where do published results live?                                                | Before first publish    | Summaries in `benchmarks/media-agency/results/`, full transcripts as release assets  |

## Revision notes

- 2026-10-23: first version, from the design conversation.
- 2026-10-28: required action-level adoption before the benchmark; included
  TikTok ad-group creation in the pilot; settled currency conversion with keyed
  reference datasets.
- 2026-10-28: restructured for a reader new to the project:
  - Moved action adoption and reference datasets into their own specs and
    replaced numbered decisions with a status table.
  - Corrected the sketches against the source: `actor.roles`, `result.data`, the
    `currency` column on `Delivery`, correlation by platform ID instead of a
    reference property, and spend through yesterday instead of a pacing property
    that would have needed another object's field.
  - Added the `fx_daily` completeness requirement and the `platform_campaign_id`
    column.
  - Made both SDK features prerequisites of the graph freeze.
