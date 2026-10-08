# Inspector foundation and live model graph

**Status:** architecture and one-screen scope agreed on 2026-10-07; first
implementation landed the same day across `relate/diagnostics`, `@relate/node`
(`defineApp`, `startApp`), `@relate/cli` (`relate dev`) and `@relate/inspector`.
Source-location capture uses optional declaration provenance
(`new Error().stack`, resolved through source maps in the CLI child) and reports
`declaration` precision only. Type diagnostics remain a non-blocking follow-up:
the protocol carries their shape and the inspector renders them, but no checker
emits them yet. Telemetry, forwarded-origin verification against real proxies
and the benchmark fixtures are not implemented. Where the sections below say
"proposed", the implementation in the packages is the current source of truth.

## Outcome and scope

Run `pnpm relate dev`, open one local URL, and see the project's object types
and relationships. Saving a definition updates that graph without refreshing the
page. Invalid code leaves the last successfully compiled graph visible and shows
the error. The inspector remains available when application code cannot load.

The only screen in this scope is a **model graph**, built with React Flow
(`@xyflow/react`) and **ELK (`elkjs`)**, the same layout library Arc uses. These
are object-type nodes such as Customer, Invoice and AccountReview, not
individual customer records or a live picture of provider data.

Record browsing, action forms, activity screens, identity switching, operational
controls and MCP tools are outside this implementation scope. The architecture
must accommodate those capabilities without implementing them now.

Agreed foundation:

- React + Vite SPA; TanStack Router and Query for navigation and server state.
- Prebuilt browser assets shipped with `@relate/inspector`.
- Stable CLI/supervisor process with Hono, diagnostics and an SSE connection.
- Replaceable child process for loading the user's application definitions.
- Authoritative Manifest snapshots plus typed diffs; no page reload on code
  edits. Inspector upgrades may require an explicit page reload.
- `defineApp` belongs in `@relate/node`; graph authoring stays in `relate`.
- Browser code never imports the runtime, compiler, connectors or user modules.

**Proposed scope decision:** the first graph-only worker compiles definitions
without starting a live runtime. Relate itself needs no database, credentials or
provider requests for inspection; user imports may still require environment
variables or perform side effects (see the environment contract below). Live
runtime hosting remains the agreed extension of this process layout, with
activation and storage questions explicitly open below.

## How the definitions connect

There are four different things:

| Thing                                     | What it contains                                                          | What it does not do                                            |
| ----------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `GraphDefinition` from `defineGraph`      | Sources, object definitions, relationships, action contracts and policies | Open connections or serve requests                             |
| Proposed `AppDefinition` from `defineApp` | The graph plus a deferred recipe for runtime bindings                     | Start the application when imported                            |
| `CompiledModel` from `compile(graph)`     | A JSON Manifest and deterministic `definitionRevision`                    | Contain connector functions, secrets or action implementations |
| Live runtime from `createRuntime`         | Compiled model, executable bindings, storage and authorized operations    | Start the surrounding application's web server                 |

`defineApp` wraps a graph; it does not replace `defineGraph`. Both the inspector
and the live runtime use the same authored graph.

### 1. Define the business model

Existing authoring API, abbreviated to show composition. The imported object
definitions belong to the user's project; Customer is API-owned, Invoice is
Postgres-owned and AccountReview is Relate-owned. See the existing
[customer-graph model](../../dev/fixtures/customer-graph/source/model.ts) for
the full object/property declarations.

```ts
// src/relate/graph.ts
import { defineAccess, defineGraph } from 'relate';
import {
  Customer,
  Invoice,
  AccountReview,
  CustomerInvoices,
  CustomerReviews,
} from './objects.js';

const access = defineAccess({
  roles: ['reader'],
  fieldGroups: ['ordinary'],
  claims: {},
});

export const graph = defineGraph({
  id: 'business',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices, CustomerReviews },
  access,
  policies: {
    Customer: { read: { gate: access.role('reader') } },
    Invoice: { read: { gate: access.role('reader') } },
    AccountReview: { read: { gate: access.role('reader') } },
  },
});
```

This example deliberately uses simple read policies. Real applications retain
their own policies and field groups. No UI-specific copy of the model is needed.

### 2. Compile the graph for inspection

This API already exists:

```ts
import { compile } from 'relate/compiler';
import { graph } from './graph.js';

const model = compile(graph);
// model.manifest.objects: IDs, API names, labels, properties, source ownership
// model.manifest.relationships: IDs, endpoints and traversal names
// model.definitionRevision: deterministic hash of the complete manifest

const json = JSON.stringify(model); // transferable to the inspector
```

The Manifest is a validated description of the model. It is not the user's
TypeScript source or executable application. The browser receives this JSON,
maps objects to React Flow nodes, and maps relationships to edges.

### 3. Describe how the same graph becomes a live application

**Proposed API:** deferred `setup` keeps graph inspection independent of runtime
resources. The lifecycle names are a proposal, not existing exports.

```ts
// src/relate/app.ts
import { defineApp } from '@relate/node';
import { graph } from './graph.js';

export default defineApp({
  graph,
  async setup({ onDispose }) {
    // Imported only when a live runtime is requested.
    const { openBindings } = await import('./bindings.js');
    const bindings = await openBindings();
    onDispose(() => bindings.close());

    return {
      connections: bindings.connections,
      store: bindings.store,
      // actionImplementations: [...] when the application has actions
    };
  },
});
```

`openBindings` is application code, not a Relate API. For example, it creates
connectors and uses the existing `connect` helper:

```ts
import { connect } from '@relate/node';

const connection = connect(customers, {
  connectionId: 'crm-primary',
  connector: crmConnector,
});
// customers is the SAME source definition used by Customer.
// crmConnector supplies executable fetch behavior; it is not in the Manifest.
```

The inspector reads `appDefinition.graph` and compiles it. It does not call
`setup`. A live host calls `setup`, then composes the runtime using its returned
bindings and that graph. `defineApp` itself is an inert, typed descriptor.

Top-level imports must also be safe to evaluate. The CLI cannot stop a user's
imported module from opening a socket or reading credentials as a side effect.
Put that work in `setup`; move runtime-only imports there when necessary.

### 4. Start the runtime inside the actual application

The current callable path is already:

```ts
const relate = createRuntime({ graph, connections, store });
const customer = await relate
  .as(authenticatedPrincipal)
  .objects.Customer.get(customerId, { select: ['name'] });
await relate.close();
```

The caller owns an injected store and connector cleanup. `close()` drains the
runtime's accepted operations; it does not close borrowed resources.

**Proposed lifecycle convenience** for the descriptor above:

```ts
// src/server.ts — the developer's existing application entry point
import { startApp } from '@relate/node';
import appDefinition from './relate/app.js';

const relate = await startApp(appDefinition);
// Existing routes/services receive `relate` through normal dependency injection.
// The application still owns its HTTP listener, authentication and shutdown.

// On application shutdown:
await relate.close(); // drain operations, then run registered setup cleanup
```

`startApp` would run setup once, compose the existing runtime and own the
cleanup registered for that start. Setup failure must release resources already
registered; `openBindings` must clean up its own partially opened resources if
it fails before returning. This convenience does not change the existing
borrowed-store contract of direct `createRuntime` calls.

The graph-only inspector needs only `defineApp` and its `graph`; implementing
`startApp` is not a prerequisite for drawing the model.

## Relate inside a bigger application

The inspector does **not** scan an arbitrary web application to discover runtime
instances, import its server entry point, or extract code from a running
process. The developer supplies an explicit entry module that exports a
definition.

```text
my-product/
  package.json
  relate.config.ts
  src/
    server.ts                  existing web server
    routes/                    existing application routes
    relate/
      objects.ts               sources, objects and relationships
      graph.ts                 defineGraph(...)
      app.ts                   defineApp({ graph, setup })
      bindings.ts              connector/storage setup and cleanup
```

```ts
// relate.config.ts — proposed CLI convention
export { default } from './src/relate/app.js';
```

```sh
# Proposed commands; the CLI is currently a scaffold.
pnpm relate dev
pnpm relate dev --config ./packages/business/relate.config.ts
```

Both consumers import the same module:

```text
src/server.ts ── imports app.ts ── starts live runtime ── existing app routes
relate dev   ── imports app.ts ── compiles app.graph  ── inspector model graph
```

These are separate evaluations in separate processes, not shared live objects.
The model graph describes the selected source code; it does not claim that a
separately running application has loaded that same revision. The existing app
keeps its own development server and reload mechanism.

If Relate definitions currently live inside `server.ts`, extract them into an
importable module and have both entry points use it. Do not import `server.ts`
from `relate.config.ts`, because that would start the whole application again.
Shared graph packages work the same way: the config explicitly imports the
selected graph/app export. One config selects one graph for this scope.

A project that only wants to inspect its model can use:

```ts
// No setup or connectors are necessary for model inspection.
export default defineApp({ graph });
```

An actual live start still requires all connections and capabilities required by
that model. A missing binding must fail startup, not quietly supply a fake.

**Future attachment mode:** inspecting the actual runtime of a larger app needs
that app to expose an authenticated inspection endpoint. The inspector then
attaches over HTTP; it cannot infer private in-memory state from a filename. The
same SPA can be mounted in a Hono host, using narrow server capabilities.
Attachment, production authentication and live operations are not part of this
graph-only scope. This distinction prevents accidentally starting two sets of
consumers, schedulers or provider effects.

## Package ownership and dependencies

| Location                            | Responsibility                                                                  | Why it belongs here                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/relate`                   | Existing graph authoring, compiler and `relate/model` contract                  | The business model must work without a CLI, browser or HTTP server      |
| `packages/runtime`                  | Existing compiled-model execution, authorization and storage contracts          | Execution must work embedded or through any transport                   |
| `packages/postgres`                 | Existing persistent store and migrations                                        | Database behavior belongs to the storage adapter                        |
| `packages/node`                     | Existing `connect`/`createRuntime`; proposed `defineApp` and lifecycle helpers  | Owns application composition and executable resource bindings           |
| `packages/protocol`                 | Consumer requests, results and evidence                                         | Shared by HTTP, SDK and MCP consumers; independent of inspector hosting |
| `packages/http` + `packages/client` | Planned consumer HTTP transport and client                                      | Browser reads/actions must exercise the same contracts customers use    |
| `packages/cli`                      | Command parsing, Hono supervisor, watching/building, child lifecycle            | Local processes and filesystem work are CLI responsibilities            |
| `apps/inspector`                    | SPA, graph mapping/layout, browser-safe inspection DTOs and asset-serving entry | Owns this developer tool without making the runtime depend on it        |

Proposed inspector layout, to create as implementation lands:

```text
apps/inspector/
  README.md
  SPEC.md
  vite.config.ts
  src/
    main.tsx
    graph/                     Manifest -> nodes/edges, React Flow view
    layout/                    ELK adapter and layout Web Worker
    connection/                snapshot and SSE client
    protocol.ts                validated snapshot/event/diff DTOs
    server.ts                  packaged assets, base-path-aware Hono mount
```

The package exposes separate browser-safe `@relate/inspector/protocol` and
server-only `@relate/inspector/server` entry points. Their exact export names
are proposed. DTOs may depend on `relate/model`, which contains portable
validation, and the proposed platform-neutral `relate/diagnostics` contract, but
never on `relate/compiler` or `@relate/node`.

Do not put an inspector DTO importing `Manifest` into `@relate/protocol` without
revisiting the dependency graph: `relate` already depends on that package. Keep
inspection DTO ownership in the inspector package to avoid this cycle.

Allowed direction:

```text
CLI -> inspector/server, inspector/protocol, node, relate/compiler
browser -> inspector/protocol -> relate/model
browser -> inspector/protocol -> relate/diagnostics
relate authoring, compiler, model -> relate/diagnostics
node -> relate/compiler, runtime
runtime -> relate/model, protocol
```

When consumer screens exist, the browser also uses `@relate/client`. It never
uses the dev channel as a shortcut around consumer authorization. Server-side
inspection adapters can accept narrow host capabilities; the prohibition on
runtime imports applies to browser code.

## Structured diagnostics: required compiler work

The current compiler and Manifest validator throw plain errors such as
`Unknown policy role` and `Invalid native reference`. Their stacks identify
Relate's validation code, not the authored definition that failed. Source maps
cannot reconstruct that missing association. Syntax/import errors and semantic
model errors therefore require different diagnostic paths.

The inspector must not ship the semantic-error experience by parsing those
messages or displaying `relate/dist/compiler.js` as the user's error location.
Structured issues are work owned by `packages/relate`, required alongside the
inspector's error rendering. The following contracts are proposed and not
implemented exports.

### Portable issue and exception contract

Introduce a platform-neutral `relate/diagnostics` subpath in the existing
`relate` package. It owns issue types and validation error classes. It imports
no compiler, Node APIs, filesystem helpers or inspector code. This lets both
authoring helpers and the browser share the contract without importing the
Node-dependent compiler.

```ts
// Proposed exports from relate/diagnostics.
// Representative codes; implementation must enumerate supported validations.
type ModelIssueCode =
  | 'policy.unknown-role'
  | 'relationship.invalid-endpoints'
  | 'object.object-id-count'
  | 'reference.invalid-target'
  | 'definition.duplicate-id'
  | 'manifest.invalid-shape';

type IssuePath = {
  root: 'graph' | 'definition' | 'manifest';
  segments: readonly (string | number)[];
};

type SourceSite = {
  file: string;
  line: number; // one-based
  column: number; // one-based
  precision: 'declaration' | 'expression';
};

type ModelIssue = {
  code: ModelIssueCode;
  message: string;
  definitionId?: string;
  path?: IssuePath;
  site?: SourceSite;
};

class CompileError extends Error {
  readonly issues: readonly ModelIssue[];

  constructor(issues: readonly ModelIssue[]) {
    if (issues.length === 0) throw new Error('CompileError needs an issue');
    super(issues.map((issue) => issue.message).join('\n'));
    this.name = 'CompileError';
    this.issues = Object.freeze([...issues]);
  }
}
```

`CompileError` covers expected authored-definition and compilation validation
failures. `relate/compiler` may re-export the same class, not define a second
copy. `relate/model` uses a separate `ManifestValidationError` with the same
`issues` contract for invalid serialized input. Unexpected implementation
exceptions remain internal failures; do not relabel every thrown exception as a
user model mistake.

Codes are stable machine-readable identifiers; consumers must not branch on
message text. Messages name the failing registry entry and offending value.
Supply definition IDs and paths whenever known; optionality covers cases such as
a malformed root or a definition whose ID is invalid. IDs must be unambiguous
before the UI uses them for highlighting.

### Concrete semantic-error examples

Suppose a model assembled through JavaScript or dynamic configuration gives
`Invoice.read` the role `finanse`, while the graph declares `finance`.
TypeScript can catch many mistakes in typed authoring, but runtime validation
must still provide this context when invalid definitions reach it:

```ts
const issue: ModelIssue = {
  code: 'policy.unknown-role',
  message: "Policy Invoice.read uses unknown role 'finanse'",
  definitionId: 'example.invoice',
  path: {
    root: 'graph',
    segments: ['policies', 'Invoice', 'read', 'gate'],
  },
  site: {
    file: 'src/relate/graph.ts',
    line: 24,
    column: 22,
    precision: 'declaration',
  },
};
```

The message and path point to the policy. A declaration site at line 24 might
identify `defineGraph(...)`, not the nested role expression. The UI must label
that link **Graph declared here**, not underline it as the exact bad field. Only
`precision: 'expression'` permits an exact-expression location claim.

Other required examples:

| Invalid definition                                               | Issue code and contextual message                                                                               | Path and graph behavior                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CustomerInvoices` references an unregistered Invoice object     | `relationship.invalid-endpoints`: `Relationship CustomerInvoices targets unregistered object 'example.invoice'` | Graph path `['relationships', 'CustomerInvoices']`; highlight edge `example.customer-invoices` only if its ID is unambiguous and present in the last good graph |
| Customer has no `objectId()` property                            | `object.object-id-count`: `Object 'example.customer' requires exactly one objectId() property; found 0`         | Definition path `['properties']`; highlight node `example.customer` if present                                                                                  |
| AccountReview has a native reference to an unregistered Customer | `reference.invalid-target`: `Property AccountReview.customer references unregistered object 'example.customer'` | Graph path `['objects', 'AccountReview', 'properties', 'customer']`; identify the owning AccountReview node                                                     |

Some errors happen **before `compile()` is called**. Today `defineObject` throws
immediately when the object-ID count is invalid. Its proposed error must carry
the supplied object ID and a definition-relative path, even though the graph
registry has not been assembled. The worker catches structured validation errors
during both module import and compilation; it must not misclassify this as a
generic import-resolution failure.

Do not fabricate the registry key `Customer` during that early failure: the
author might later register that definition under a different API name.

### Authoring paths and Manifest paths

Paths name their root explicitly because authored objects and serialized
manifests have different shapes. For the same policy mistake:

```ts
// CompileError: addresses the graph supplied to compile(graph).
const authoredPath: IssuePath = {
  root: 'graph',
  segments: ['policies', 'Invoice', 'read', 'gate'],
};

// ManifestValidationError: addresses the JSON supplied to validateManifest().
const manifestPath: IssuePath = {
  root: 'manifest',
  segments: ['policies', 'example.invoice', 'read', 'role'],
};
```

`model.ts` owns structured schema and semantic validation of JSON, including
conversion of schema-validator issues into the public issue vocabulary. It
cannot know where a `defineGraph()` call occurred. When compilation lowers the
graph to a Manifest, the compiler retains enough correspondence to map Manifest
paths back to authored definitions and registry keys. If a path cannot be
translated, retain its explicit Manifest root; never present it as an authored
path. Duplicate or invalid IDs must not create a guessed mapping.

### Source provenance and code frames

`defineSource`, `defineObject`, `defineRelationship`, `defineGraph` and action
definitions need an optional provenance mechanism owned by `relate`. An internal
side table keyed by definition object is a candidate. Source paths, stacks and
capture metadata must stay outside the Manifest and its hash. Moving a file,
enabling capture or changing source maps must not change `definitionRevision`
for an otherwise identical model.

**Open mechanism:** development-only capture of declaration stacks, explicit
source metadata or build-time instrumentation. A stack captured with
`new Error().stack` is a candidate, not an agreed guarantee of exact locations.
Validate wrappers, shared definition factories, generated definitions and linked
packages before selecting it. Do not add unconditional stack-capture cost or
Node imports to the ordinary portable authoring path.

The host must enable any capture before evaluating the user's modules. Raw
capture metadata stays in the child; the Node tooling resolves usable sites
through source maps there. The compiler associates issues with their authored
definitions and may attach a resolved site through a host-provided resolver. The
exact resolver/capture API remains proposed; the compiler must also work without
it.

The CLI diagnostic adapter reads bounded excerpts from the corresponding build
attempt's source content, normalizes project-relative paths and produces `frame`
when a site and matching source are available. If the file has changed since
that attempt and no matching source snapshot is available, omit the frame rather
than point at different code. A missing source map, unreadable file or
unresolvable site must not hide the semantic issue. No filesystem or source-map
resolution belongs in the browser.

Without provenance, the example remains actionable:

```text
policy.unknown-role
Policy Invoice.read uses unknown role 'finanse'
Graph path: policies.Invoice.read.gate
Definition: example.invoice
Source location unavailable
```

### Ownership of the complete diagnostic path

| Owner                                                                   | Required responsibility                                                                                                                                | Must not own                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/relate/src/diagnostics.ts` (new, proposed subpath)            | Stable issue codes, path/site types, `CompileError` and `ManifestValidationError`                                                                      | Node dependencies, file excerpts or inspector DTOs                                 |
| `packages/relate` authoring helpers                                     | Optional declaration provenance; structured early validation errors such as missing `objectId()`                                                       | Opening source files, starting hosts, importing the compiler                       |
| `packages/relate/src/compiler.ts`                                       | Contextual issues, independent-issue collection, definition identity, authored paths and translation from lowered Manifest paths                       | HTTP/SSE, editor launching or parsing human error messages                         |
| `packages/relate/src/model.ts`                                          | Structured shape/semantic issues for serialized Manifest input                                                                                         | Assuming an authored call site exists or importing Node tooling                    |
| `packages/node`                                                         | Preserve structured compile failures through `createRuntime` and future app startup; perform the already-specified resource cleanup on startup failure | Inventing semantic diagnostics or replacing errors with generic strings            |
| `packages/cli` worker and supervisor                                    | Enable provenance before user evaluation; own source-map resolution, attempt identity, safe excerpts and explicit issue serialization across IPC/SSE   | Model validation rules or forcing a usable site for every error                    |
| `apps/inspector` protocol                                               | Validate serializable issue lists and optional frames in snapshots/events; share portable types from `relate/diagnostics`                              | Importing compiler/runtime modules into the browser                                |
| `apps/inspector` graph UI                                               | Show all reported issues, navigate available sites, highlight known nodes/edges in the last good graph and clear recovered errors                      | Inferring IDs from messages or reading the local filesystem                        |
| `packages/runtime`, `packages/postgres`                                 | Retain their execution/storage responsibilities; consume structured model validation where already applicable                                          | Compiler provenance, source mapping or changes to storage for diagnostics          |
| `packages/protocol`, `packages/http`, `packages/client`, `packages/mcp` | Keep consumer errors/evidence separate; any future diagnostic exposure requires an authorized development/admin adapter                                | Broadcasting source frames or policy metadata through ordinary consumer operations |

The CLI explicitly copies error fields into a validated plain-data payload. Do
not rely on `JSON.stringify(error)`, exception prototypes surviving IPC, or
`instanceof` across processes. `instanceof CompileError` is useful inside the
worker; the supervisor/browser use validated discriminants and issue fields.

### Multiple issues and failure recovery

Use an issue list from the outset. Collect independent failures when the graph
is available: a bad Invoice policy and an invalid CustomerReviews relationship
should be reported together. Validate prerequisites first and skip dependent
checks when those prerequisites fail. An absent relationship endpoint must not
produce a cascade of fabricated traversal failures. Deduplicate issues reported
at authoring and Manifest-validation stages and return them in deterministic
path/code order. Never return a partially valid `CompiledModel` as success.

An exception thrown while importing definitions can stop module evaluation. In
that case report the structured issues available from that exception; do not
promise all errors across modules that never executed. Invalid root shapes can
similarly prevent deeper validation. Unexpected worker failures remain distinct
from semantic issues.

If attempt 8 fails while generation 7 is displayed, keep generation 7 and mark
the issue list as belonging to attempt 8. Highlight only unambiguous IDs present
in generation 7; a new broken definition still appears in the list without a
node highlight. On a successful newer attempt, clear all prior issues and
highlights atomically with the new model. Discard late diagnostics from older
attempts just as late model results are discarded.

## Terminal and local-server contract

The terminal is a first-class client of the same supervisor state as the
browser. The following behavior is specified for `relate dev`; these flags and
commands are not implemented yet. All times below are illustrative output, not
benchmarks.

### Startup, reloads and errors

```text
$ pnpm relate dev
  Relate dev
  Project    /work/my-product
  Config     relate.config.ts
  Inspector  http://127.0.0.1:4318
  Watching   application definitions
  Loading    attempt 1

  ready  gen 1  business  3 objects · 2 sources · 2 relationships  142ms
  update src/relate/objects.ts  gen 2  +AccountReview.score  61ms
  update src/relate/graph.ts    gen 3  ~policy Invoice.read  74ms
  error  src/relate/graph.ts    attempt 4  1 issue; keeping gen 3
    policy.unknown-role: Policy Invoice.read uses unknown role 'finanse'
    src/relate/graph.ts:24:22 (graph declaration)
    Graph path: policies.Invoice.read.gate
  update src/relate/graph.ts    gen 4  ~policy Invoice.read  58ms
```

The banner prints the resolved project/config and the **actual bound URL** once.
Start the stable listener and print its URL before evaluating user definitions,
so a first-load failure still has a working inspector. Missing config, invalid
flags, lock failure and listener failure are startup errors; report an
actionable message and exit. Do not print an API URL in the graph-only scope:
the consumer API is not running yet.

Print one completion line for the initial accepted model, and one for each
accepted reload or failed current attempt. Coalesce saves into one attempt and
do not announce superseded results as successful reloads. For multiple changed
files, print the first project-relative path plus `(+N files)`.

The success line contains the accepted generation, a bounded diff summary and
elapsed milliseconds. Use `+` for additions, `~` for changes and `-` for
removals. Summarize at most three changes, followed by `(+N changes)` when
necessary. Resolve display names through stable IDs in the old/new manifests.
The typed diff identifies affected objects/relationships; compare their
properties for summaries such as `+AccountReview.score`. For `otherChanged`,
compare the remaining Manifest sections to identify policy/source/action
changes. This shared summary calculation belongs in the CLI, not a parser of
console output. When the hash is unchanged, print `model unchanged`; do not
imply that executable code is unchanged or that a type check passed.

`durationMs` measures from the start of the accepted build attempt, after
debounce, through worker loading/compilation and acceptance by the supervisor.
Use the same duration in the terminal and model event. It excludes browser
delivery, ELK layout and rendering; measure those separately. A failed attempt
has no new generation and explicitly names the last displayed generation, or
`no model yet` on initial failure.

Print structured diagnostic codes/messages and each available location in
`path:line:column` form. Keep that token unobscured so editors/terminals can
recognize it; hyperlinks can supplement but cannot replace plain text. Resolve
terminal paths relative to the invoking working directory, or print an absolute
path when needed for unambiguous clicking. Browser paths remain
project-relative. Label declaration sites as declarations; print expression
frames only at their reported precision. If no site exists, print the definition
ID and rooted path without inventing a clickable location. Print multiple issues
in their stable order, with optional bounded excerpts.

The terminal and SSE adapter consume the same accepted model/failure state;
neither reconstructs it from the other's text. A successful compile clears only
the failed-attempt diagnostics. When the separate type-checking follow-up ships,
report its own revision and warning count without delaying the reload line or
clearing warnings on model publication.

Output is append-only: do not clear the terminal or erase user logs on reload.
TTY output may add color and symbols; redirected output uses plain text with no
ANSI escapes, spinners or cursor controls. Standard output carries the banner,
successful lifecycle lines and child stdout. Standard error carries warnings,
failed-attempt diagnostics, startup errors and child stderr. Ordering is
preserved within each stream; do not promise total ordering across both streams.

### Port selection and browser opening

```sh
pnpm relate dev                 # default 4318, with bounded fallback
pnpm relate dev --port 4500     # exactly 4500, or fail
pnpm relate dev --open          # open the actual inspector URL once
```

- Bind to `127.0.0.1`. A remote bind/`--host` option is outside this scope.
- Without `--port`, try **4318 through 4327 inclusive**. Attempt to bind each
  candidate directly; do not probe, release and later rebind the same port.
  Retry only address-in-use failures. Other bind errors fail with their cause.
- If fallback is needed, print `Port 4318 is in use; using 4319` (with the
  actual ports). If all candidates are occupied, list the attempted range and
  suggest `--port <number>`. Never stop the process occupying a port.
- An explicit `--port` must be an integer from 1 through 65535. Invalid values
  fail before starting the server. An occupied explicit port fails; never
  silently move an explicitly addressed server.
- The selected port remains stable for the supervisor's lifetime. Replacing a
  worker must not release or reacquire the public listening port.
- Without `--open`, print the URL and do not launch a browser. With it, open
  once after the listener and session bootstrap are ready, even if compilation
  has failed. The error screen is useful in that case. Do not reopen after
  reloads.
- If browser launch fails, warn and keep serving; the printed URL remains
  usable. A verified existing server may also be opened by a second `--open`
  invocation.

### One server per project

For this command, project identity is the canonical real path of the directory
containing the resolved config file. Configs in the same directory share one
lock; a config in a different directory explicitly selects another project.
Symlinked paths resolve to the same project, while separate worktrees are
separate projects. Print the resolved project root in the banner so this rule is
visible.

Acquire a project lock **before** selecting a port, starting a watcher or
spawning a child. Store the lock and owner metadata under
`<projectRoot>/.relate/dev/`; this directory must be gitignored. Owner metadata
includes the supervisor PID, process-start identity, an unguessable owner ID,
config path, lifecycle state and actual URL once listening. Update metadata
atomically. The locking primitive must provide exclusive acquisition; checking
whether a metadata file exists and then writing it is insufficient.

On a second invocation, verify the recorded owner using process identity and the
local server's instance identity before treating it as a running server:

```text
Relate dev is already running for /work/my-product
Inspector  http://127.0.0.1:4319
Config     relate.config.ts
PID        28417
Use the existing server; stop it with Ctrl+C in its owning terminal to restart.
```

The second command starts no watcher or child and exits successfully. `--open`
opens that verified URL. If a different config or explicit port was requested,
report the mismatch and exit with an error; do not reconfigure or replace the
existing owner. Never open an unverified URL read from stale metadata.

Handle the startup window: if another owner is alive but has not published a
URL, wait at most five seconds for its listening state, then report
`already starting` with its PID/config and exit with an error. A missing URL or
slow compilation is not proof of a stale lock.

After a crash, recover a lock automatically only when its original owner is
demonstrably gone. A PID alone is insufficient because it can be reused.
Unreachable HTTP, elapsed time or incomplete metadata alone are also
insufficient. If ownership cannot be established, report the lock path and
reason and leave it intact. Stale-lock reclamation must itself be exclusive so
two recovering commands cannot both start. The precise lock library and
platform-specific process-identity mechanism remain implementation choices,
validated on supported platforms before release.

Shutdown stops accepting reloads, closes watchers, stops and reaps owned child
processes, closes the listener, then releases only this supervisor's lock.
Release the lock on startup failure too. Never remove a newer owner's metadata
or kill an unrelated process. In the graph-only scope allow five seconds for
owned children to stop, then terminate remaining owned children; a second Ctrl+C
skips that grace period. Live execution will need its separately specified
draining/uncertain-outcome rules before using forced shutdown.

Normal completion, a successful duplicate invocation and graceful Ctrl+C exit
with status 0. Invalid CLI arguments exit with status 2. Fatal startup or
supervisor failures exit with status 1. Authored-code errors keep the dev host
alive awaiting the next edit; they do not exit the command or release its lock.

### Child stdout and stderr

```text
[app attempt 5 stdout] Loading customer definitions
[app attempt 5 stderr] Fixture configuration is incomplete
```

Pipe child stdout/stderr and prefix **each line** with its attempt and stream.
Forward stdout to the parent's stdout and stderr to its stderr. Use streaming
UTF-8 decoding, handle partial lines, and flush a final unterminated line on
child exit. Bound line and queue buffers so a noisy child cannot consume
unbounded supervisor memory. Any truncation/drop must be explicit, with a count;
never silently suppress user output. Logs already emitted by superseded attempts
remain in history with their attempt IDs.

Model results and structured diagnostics travel on a dedicated child IPC
channel, never by parsing stdout. A user's `console.log`, including JSON-looking
text, cannot become a model event. Printing to stderr does not itself fail an
attempt; a structured failure or unexpected exit does. Render each structured
failure once rather than also dumping the same exception as a second raw stack.
Forwarded application logs are user-authored output, not a guarantee that all
embedded secrets can be redacted automatically.

The graph-only child loads definitions; it does not call deferred setup merely
to produce logs. Browser log streaming and a log viewer are outside this scope.

### Environment inherited by the child

The CLI inherits its launching environment and passes it to each application
child. It does not discover or automatically load `.env`, `.env.local`, or
framework-specific environment files. The first scope uses the project's own
environment loader rather than introducing `relate dev --env-file`. In this
repository that is dotenvx:

```sh
pnpm exec dotenvx run -f .env -- pnpm relate dev
```

Environment-file paths follow the loader's working-directory rules. Variables
are loaded before the supervisor starts; editing that file requires restarting
this command. The same inherited environment reaches every replacement child. No
values are substituted into browser assets or sent in session/model payloads.

For example, importing an application-wide `env.ts` that immediately validates
`CRM_API_KEY` can fail before `compile()` runs. Report that as an import
failure, with the last good graph retained; do not bypass the application's
validation or fabricate credentials. Prefer importing that module and validating
runtime-only credentials inside `setup()`. The credential-free acceptance
fixture demonstrates safe definition imports, not a guarantee about arbitrary
application modules.

### Ownership

`packages/cli` owns argument parsing, project identity, locks, port binding,
browser launch, the terminal renderer, subprocess streams and shutdown. Its
supervisor produces the common model/failure state consumed by both terminal and
SSE adapters. CLI unit and process tests own these behavioral checks.

`packages/relate` supplies structured semantic issues; it never prints a banner
or chooses a port. `packages/node` retains application lifecycle ownership;
embedding Relate does not acquire a dev-server lock or intercept console output.
`apps/inspector` owns browser assets and its validated event contract, not
terminal formatting or filesystem locks. Runtime, storage and consumer transport
packages require no new responsibilities for this terminal contract.

## Processes, reload and events

```text
relate dev: stable Node process
  Hono: SPA + /dev/snapshot + /dev/events
  watcher + incremental application build + diagnostics
  child: import config -> compile(app.graph) -> return CompiledModel
```

The worker is an application-loading child process, not a browser Web Worker.
The ELK Web Worker runs separately in the browser and only computes layout.

The CLI owns one watcher/rebuild pipeline; do not nest `tsx watch` under another
watch supervisor. Incremental esbuild plus fresh Node children is the proposed
starting implementation. Watch the selected config and its resolved imports,
including imported TypeScript modules and linked workspace dependencies. Respect
Node ESM/package exports and project resolution rules. For a workspace package
exporting built JavaScript, its source-to-output build must also run in watch
mode; document that requirement rather than silently overriding exports.
Non-imported files used at evaluation time need an explicit watch-file option.

### Why esbuild rather than native type stripping

The repository pins Node 26, which can execute erasable TypeScript directly.
Native stripping alone does not implement the project's module-resolution
contract: an authored `import './graph.js'` must resolve to `graph.ts` during
source evaluation, and tsconfig path aliases must resolve as configured. Node
requires actual file extensions and does not read tsconfig path mappings. See
[Node's TypeScript documentation](https://nodejs.org/api/typescript.html).

Use esbuild's Node-targeted ESM bundling for the selected source entry,
retaining source maps and respecting package exports. Its
[metafile](https://esbuild.github.io/api/#metafile) supplies bundled input paths
for dependency tracking. It is not a complete watch set: external packages,
explicit runtime-read files, and paths needed to recover from failed resolution
need handling too. Preserve the last successful dependency set across a failed
build, and watch relevant config/resolution inputs so creating a previously
missing module can recover without restarting. Native stripping plus a custom
resolver/watcher remains possible, but adds machinery esbuild already supplies.

### Bounded application evaluation

The supervisor starts a **30,000 ms** wall-clock deadline when it spawns each
application child. It covers child startup, module evaluation (including
unsettled top-level await) and compilation until receipt of a valid model or
structured failure. The supervisor owns the timer so an infinite loop in the
child cannot block it. Bundling happens before spawning and is measured
separately from this evaluation deadline.

`relate dev --eval-timeout 60000` overrides the deadline in milliseconds;
require an integer from 1 through 2147483647 (the timer limit). On expiry,
reject that attempt, emit one
`{ kind: 'worker', code: 'worker.timeout', severity: 'error' }` diagnostic and
terminate the owned child. Force termination if it has not exited within two
seconds; suppress a second crash diagnostic caused by that termination. Keep the
inspector and last good graph available, reap the child, and allow the next edit
to start a fresh attempt. Ignore late results and clear timers on every
completion or cancellation path. A superseded attempt is cancelled, not reported
as a timeout. This deadline does not promise to undo import-time external
effects.

Debounce saves, assign each attempt an ID, and publish only the newest
successful candidate. Ignore a late result from an older build or child. Stop
superseded children; one failed candidate must not stop the host or event
stream.

The first scope publishes **compiled models**, not live runtime activations:

```ts
// Proposed wire shapes, validated at runtime as well as typed in TypeScript.
import type { Manifest } from 'relate/model';
import type { ModelIssue, SourceSite } from 'relate/diagnostics'; // proposed

type ModelSnapshot = {
  generation: number;
  definitionRevision: string;
  manifest: Manifest;
};

type ManifestDiff = {
  objects: { added: string[]; changed: string[]; removed: string[] };
  relationships: { added: string[]; changed: string[]; removed: string[] };
  // True for any other manifest change, including policy/source/action changes.
  otherChanged: boolean;
};

type DevEvent = {
  protocolVersion: 1;
  instanceId: string;
  sequence: number;
} & (
  | {
      type: 'snapshot';
      model: ModelSnapshot | null;
      failure: { attempt: number; diagnostics: readonly Diagnostic[] } | null;
      // Follow-up scope; absent until the type checker ships.
      typecheck?: { revision: number; diagnostics: readonly Diagnostic[] };
    }
  | {
      type: 'model';
      model: ModelSnapshot;
      fromGeneration: number | null;
      diff: ManifestDiff;
      durationMs: number;
    }
  | { type: 'diagnostics'; attempt: number; diagnostics: readonly Diagnostic[] }
  | {
      // Follow-up scope; see "Type diagnostics: a non-blocking side channel".
      type: 'typecheck';
      revision: number;
      diagnostics: readonly Diagnostic[];
    }
);

type Diagnostic = (
  | ({ kind: 'compile' } & ModelIssue)
  | {
      kind: 'syntax' | 'import' | 'worker' | 'layout' | 'type';
      code: string;
      message: string;
      site?: SourceSite;
    }
) & {
  severity: 'error' | 'warning';
  frame?: SourceSite & { excerpt: string };
};
```

Each structured compiler issue becomes one `kind: 'compile'` diagnostic with its
code, message, identity and path preserved. Syntax/import tools supply their own
codes and may supply precise frames. Worker exceptions are sanitized separately.
Frame precision must match the associated site. Layout diagnostics use the same
presentation shape locally; ELK failures do not become compiler failures or
advance the supervisor's generation.

`kind` answers "what failed" and groups diagnostics into the three states the UI
must tell apart: `compile`, `syntax`, `import` and `type` mean the authored code
has a problem; `worker` means the loader failed, not the code; connection loss
is client state and is never a `Diagnostic`. Do not add kinds for loader failure
reasons. A crashed, timed-out or out-of-memory child is one `worker` diagnostic
whose `code` carries the reason, for example `worker.crash`, `worker.timeout` or
`worker.oom`, with a sanitized message. Codes, not kinds, are the stable
identifiers consumers branch on.

`severity` answers "did this stop the model from publishing". Every diagnostic
in `failure` or in a `diagnostics` event is `severity: 'error'`: the attempt
failed and the last accepted graph stays on screen. `type` diagnostics are
always `severity: 'warning'`: the model published and the warning rides beside
it. The field is explicit rather than derived from `kind` so a future kind can
choose either side without a protocol change, and so the UI never has to encode
that mapping itself.

Successful accepted evaluations advance `generation`, even if the definition
hash is unchanged. Failed attempts do not advance it. Diff arrays contain stable
definition IDs. The complete snapshot is authoritative; diffs describe changes
for rendering and do not have to patch a previous manifest successfully.

Every SSE connection begins with an atomically captured snapshot and sequence,
then receives subsequent events in order. Snapshot and subscription registration
must not leave a race where an update is lost. On reconnect send a fresh
snapshot, including the current failure and its issue list; durable event replay
is unnecessary for this screen. Ignore duplicates and resynchronize on a
sequence gap. A new `instanceId` resets sequence/generation comparisons.
`/dev/snapshot` returns the same current state for explicit resynchronization.

Compile issues display next to the last accepted graph. An initial failure shows
an empty graph state with its issue list. Successful recovery clears the issues.
The UI distinguishes three states and must not blur them: the authored code is
invalid (`compile`, `syntax`, `import`, `type`), the loader failed (`worker`),
and the connection dropped (client state, no diagnostic). A `worker` diagnostic
must not read as a mistake in the user's code. Code frames are available only
when source provenance can be resolved; a declaration frame must not claim
exact-expression accuracy. Contextual messages and paths remain available
without frames. Full diagnostic metadata is for authorized local development,
never an unrestricted public endpoint.

### Type diagnostics: a non-blocking side channel

**Decision:** the first implementation shows Manifest validity, not type
correctness. Type diagnostics are a specified follow-up with the protocol shape
reserved above, so adding them later is additive and not a breaking change.

esbuild strips types without checking them. Relate's authoring API relies on
inference, so some authoring mistakes exist only as type errors: a property key
that is not on the object, a reference typed against the wrong definition, an
action input that does not match its schema. Those modules compile, the child
imports them, and the graph updates as if nothing were wrong. The graph screen
is partly protected because the compiler's runtime validation reports the
semantic mistakes that matter to the Manifest, such as
`reference.invalid-target`, with structured issues. Type checking adds the
mistakes runtime validation cannot see, and it is not a correctness gate for the
model graph. The developer's editor already shows these errors; the inspector's
job is to put them beside the graph so a save that "worked" is not mistaken for
a save that is right.

When implemented, the CLI runs one type checker in watch mode beside the build
pipeline, using the user's `tsconfig` and project references, with `noEmit` and
no `transpileOnly` shortcut. Use the TypeScript compiler API or `tsc --watch`; a
faster native checker is an implementation choice, not a contract. Reduce its
output to the module set the build pipeline watches. The checker sees the whole
program, and an error in an unrelated file is noise on this screen. Each
reported error becomes one `kind: 'type'`, `severity: 'warning'` diagnostic
whose `code` is the checker's diagnostic number, for example `ts.2322`, with the
checker's message, a `site` of `expression` precision and a frame when the
excerpt can be read.

Type diagnostics travel on their own event and never share the build attempt's
lifecycle:

```ts
// Follow-up scope. Reserved in DevEvent above.
type TypecheckEvent = {
  type: 'typecheck';
  // Monotonic per instance; a new program version replaces all prior type
  // diagnostics. Unrelated to `attempt` and `generation`.
  revision: number;
  diagnostics: readonly (Diagnostic & { kind: 'type'; severity: 'warning' })[];
};
```

Rules that follow from the separate lifecycle:

- A `typecheck` event is a complete replacement, never a delta. An empty list
  means the program is clean at that revision.
- Type diagnostics never appear in `failure` or in a `diagnostics` event, and a
  successful attempt does not clear them. Only a newer `typecheck` revision
  does. The build and the checker finish at different times, and clearing
  warnings on publish would hide them for most of the edit cycle.
- Type diagnostics never block publishing, never advance or hold back
  `generation`, and are never treated as late by attempt ordering. Discard only
  a `typecheck` event whose `revision` is older than the one displayed.
- The reconnect snapshot carries the current type diagnostics and revision
  alongside the current model and failure. A fresh connection sees the same
  three states as a long-lived one.
- The UI shows them as a separate warning count, such as a "3 type errors" pill,
  visually distinct from the blocking error list. A type diagnostic may
  highlight a node when its `site` resolves to a definition's declaration, under
  the same unambiguous-ID rule as compile issues.
- Type diagnostics carry file paths and excerpts from the user's project, so the
  same loopback, Host/Origin and local-session restrictions apply.

Checker latency is expected to be seconds on a real project, well above the
build-to-graph path. That is acceptable because the channel is advisory. Do not
delay the model event to wait for the checker, and do not run the checker inside
the application-loading child, which is replaced on every attempt.

## Local session and forwarded access

The CLI owns authentication and request validation; the inspector owns the
bootstrap exchange and session-expired presentation. The Manifest can include
policy structure, so this is trusted model inspection, not the consumer's
authorized discovery response.

Generate a cryptographically random bootstrap token of at least 256 bits per
supervisor instance. The terminal's Inspector URL and `--open` URL carry it in
the fragment, for example `http://127.0.0.1:4318/#token=<token>` (the earlier
banner omits the fragment for readability). Serve only the static bootstrap
shell without a session. The browser removes the fragment with `replaceState`
and exchanges the token in a same-origin POST to `/dev/session` for an opaque
HttpOnly, SameSite=Strict session cookie. Use Secure cookies over HTTPS and a
cookie name unique to the instance, since cookies are not isolated by port. The
token is reusable for this instance so another tab can be opened; it and all
sessions expire when that supervisor exits. A normal refresh uses the cookie.
Opening the bare URL without a cookie shows instructions to use the terminal's
link; merely visiting localhost must not grant a session.

All metadata, snapshot, SSE and diagnostic endpoints require the session.
Validate Host against the configured origins on every request and validate
Origin on the bootstrap POST and any future mutating request. For requests
carrying Origin, require an exact permitted same-origin match; do not enable
cross-origin API access. Reject cross-site fetches, and use a restrictive CSP
and `Referrer-Policy: no-referrer` on the shell. Never put the bootstrap token
in query parameters, analytics, model events or request logs. Its deliberate
terminal output is a local access capability. Keep any token material needed for
duplicate-command `--open` in owner-only local storage, available only after
verifying the running instance; do not add it to a public identity endpoint. The
ordinary duplicate-server message may show the clean URL.

Default to the printed loopback origin. Forwarded access is opt-in through a
repeatable **exact origin** option, for example:

```sh
pnpm relate dev --allowed-origin https://my-private-forward.example
```

This changes accepted browser origins, not the loopback bind address. Require an
explicit scheme and host, with an optional port normalized to the scheme
default, and no wildcard, credentials, path, query or fragment; allow HTTP only
for loopback origins and HTTPS for remote origins. The forwarding proxy must
preserve the configured external Host; do not trust arbitrary `X-Forwarded-*`
headers. Browser Origin must agree with that Host and the allowlist. Document
this forwarding requirement rather than claiming every VS Code Remote or
Codespaces proxy works automatically. A local forwarded port that changes the
browser origin also needs its exact origin allowed. Open the forwarded origin
with the terminal token fragment; `--open` continues to target the locally bound
URL. Keep remote forwarding private/authenticated. Hosted third-party UIs
connecting cross-origin remain outside scope.

## Inspector upgrades and asset caching

The inspector package and supervisor declare their supported protocol versions.
Validate the small version envelope before decoding a model payload. If an open
tab encounters an unsupported `protocolVersion`, stop applying events, retain
its last graph as stale, and show **Inspector updated — reload to continue**. An
explicit reload fetches the new shell; do not loop automatic page reloads. A
compatible new supervisor instance needs snapshot resynchronization after
re-authentication. If a restart invalidates the cookie, retain the graph as
stale and direct the user to the new terminal link; do not keep retrying an
unauthorized SSE connection.

Serve content-hashed assets with
`Cache-Control: public, max-age=31536000, immutable`, and HTML with
`Cache-Control: no-cache` so it revalidates. Session and dev API responses use
`no-store`. Missing asset paths must return 404, never the SPA HTML fallback.
Catch dynamic-import/chunk failures and offer the same explicit recovery action:
old lazy chunks may disappear during a package upgrade even with correct cache
headers. Do not cache the app using a service worker in the first scope. The CLI
owns response headers and asset routing; the inspector owns version checks and
recovery UI. Code edits still update the graph without a page reload.

## Telemetry: deferred, with an explicit opt-out

Telemetry is a planned capability, not a permanent no-telemetry promise. It is
outside the initial graph-only implementation. Before enabling collection,
publish the event schema, destination, retention, identifier policy and default
behavior; the initial scope does not settle the provider or default-on policy.
The CLI help, README and inspector must explain what is collected and how to
turn it off in the same release that introduces it.

Reserve these equivalent ways to disable collection when telemetry ships:

```sh
RELATE_TELEMETRY_DISABLED=1 pnpm relate dev
DO_NOT_TRACK=1 pnpm relate dev
pnpm relate dev --no-telemetry
```

Any disable signal wins over other settings. An exported environment variable is
the persistent shell/CI choice; the flag applies to that invocation. Resolve the
decision before initializing telemetry, and pass only the effective boolean to
the browser. Disabling covers CLI and browser events, crash uploads and queued
delivery: do not initialize a collector, enqueue events or transmit old queued
events while disabled. Restart an existing supervisor after changing its
environment/flags; a duplicate invocation must not silently change its policy.
No background upload process may outlive the supervisor.

Candidate events are tool/version usage and aggregate timing/count metrics. Use
an explicit field allowlist. Never collect source text, Manifest contents,
object/property names, filesystem paths, environment values, console output, raw
diagnostic messages/stacks, session tokens or application records. An
identifier, if needed, requires its own documented lifecycle; do not describe
pseudonymous data as anonymous. Telemetry failure must never block startup,
reload or shutdown. The CLI owns the effective policy and transport; the
inspector emits only approved events through that policy. Authoring/runtime
packages must not acquire telemetry side effects merely by being imported.

## One graph screen

- Object nodes use `object.id` as React Flow identity. Show label, API name and
  property names/types, with source/native ownership metadata where available.
- Relationship edges use `relationship.id` and its declared endpoints. Show
  forward/reverse traversal names and cardinalities. Do not invent relationship
  edges merely because a property references another object.
- Pan, zoom, select and an explicit Fit control are sufficient. This is not a
  model editor: dragging or reconnecting an edge must not change application
  code.
- Keep selection and viewport on code updates. Clear selection only if its
  definition is removed. Updating labels must not recreate node identities.
- Fit automatically on the first nonempty model only. Do not reset the camera on
  every successful build.

Arc's current reference is
[`ontology-elk-layout.ts`](../../../arc/apps/web/src/features/ontology/ontology-elk-layout.ts).
It imports `elkjs/lib/elk.bundled.js` and uses the `layered` algorithm, with
direction, edge routing, spacing and a fixed random seed. Its dependencies are
recorded in [Arc's web package](../../../arc/apps/web/package.json). This is a
library/algorithm reference, not a dependency on Arc source code.

Use ELK layered layout, initially left-to-right, in a browser Web Worker. Worker
execution is our proposed integration; Arc's inspected adapter alone does not
establish that it uses a browser worker. Supply node dimensions, sort by stable
IDs, and use a fixed seed. React Flow owns interaction; ELK computes placement.
See
[React Flow's layout guidance](https://reactflow.dev/learn/layouting/layouting)
and [ELK's worker support](https://github.com/kieler/elkjs).

Relayout for topology or node-size changes; retain coordinates for presentation
changes that do not affect dimensions. Tag layout requests with the model
generation and discard obsolete results. Replace nodes/edges together and keep
the last valid layout if the new layout fails, with a visible diagnostic.
Deterministic layout is not a promise that unrelated nodes never move after a
topology change. Preserve the camera and animate position changes where useful;
respect reduced-motion preferences.

## Why Vite replaces Next.js for the inspector

**Agreed:** the new OSS inspector uses React/Vite. Next.js continues to own
docs. The internal Next.js prototype remains historical behavioral evidence.

The inspector is an interactive client of explicit metadata and runtime APIs. It
does not currently need SSR, Server Components or Server Actions. Static assets
can be shipped once in the inspector package and served by the existing Hono
supervisor or a future production mount. Users do not install or run a Next
development server to inspect their application.

Vite builds the SPA at package build time. `relate dev` serves those prebuilt
files; it only rebuilds the user's selected modules. Inspector contributors use
Vite's own frontend HMR when editing the inspector. These are separate reload
loops. Package assets locally and support a configurable base path; verify the
installed package without relying on monorepo source aliases or a CDN.

Next can also export static assets, but its server features and some dynamic
route patterns do not work in static-export mode. We would be using it mainly as
an SPA build wrapper. Vite makes this packaging boundary direct. See
[Vite production builds](https://vite.dev/guide/build) and
[Next static export constraints](https://nextjs.org/docs/app/guides/static-exports).
Historical prototype bundling problems are supporting context, not evidence that
Next cannot implement this product.

## Live runtime extension and open decisions

The process layout later permits the worker to start the runtime and serve
`@relate/http`, with the supervisor proxying `/api`. Business reads/actions use
the public client; host commands use separate named capabilities. The same SPA
can attach to a production host without exposing development routes.

Before enabling live execution during reload, specify:

1. Persistent local storage and resource ownership across child replacement.
2. Model compatibility and migration/activation. Current stores reject an
   installed graph with a different definition revision, including in memory.
3. Draining accepted operations, action generation preconditions and cleanup.
4. Separate compiled-model and active-runtime revisions. A model displayed in
   the inspector is not proof of successful runtime activation.
5. Principal-scoped data invalidation. An unchanged Manifest does not mean
   connector or action behavior is unchanged.

These decisions do not block a compile-only model view and must not be silently
resolved through data resets. In-process Vite module re-evaluation remains a
possible optimization inside the worker; it is not required for the foundation.
No reload latency or implementation-duration estimate is yet benchmarked.

## Acceptance evidence for implementation

- CLI process tests: unresolved top-level await and a synchronous infinite loop
  time out without blocking the supervisor. Verify the override, forced child
  termination, one failure event, cancellation and recovery on the next edit.
- Environment tests: externally loaded variables reach every replacement child;
  missing import-time variables produce recoverable diagnostics. Environment
  values never enter assets or session/model payloads, and setup stays deferred.
- Installed-package NodeNext fixture: `import './graph.js'` resolves to authored
  `graph.ts`; verify tsconfig aliases, package exports, missing-import recovery
  and subsequent edits without relying on monorepo aliases.
- Browser/process tests: bare unauthenticated requests cannot read metadata;
  token exchange, cookie refresh, instance restart and duplicate `--open` work.
  Reject wrong token/Host/Origin and untrusted forwarded headers. Exercise an
  explicitly allowed HTTPS forwarding proxy and a local forwarded-port origin.
- Browser/HTTP tests: an old SPA with an unsupported protocol offers one
  explicit reload; compatible restarts resynchronize. Verify cache headers,
  missing-chunk recovery, asset 404s, and nested base paths for sessions and
  static assets.
- Benchmark fixtures: representative 10-, 50- and 100-object graphs with
  relationships and realistic property counts. Record cold load and repeated
  edits, separately measuring build/compile, ELK and update-to-visible latency,
  plus camera/selection preservation and main-thread responsiveness. Record
  machine/browser and graph shape; establish budgets from measurements rather
  than treating prototype timings as guarantees for this implementation.
- Before telemetry ships: tests prove every opt-out prevents initialization,
  queueing and uploads in both CLI/browser, including previously queued events.
  Verify documented schemas against payloads and keep telemetry outages off the
  reload path. Initial-scope CLI/browser assets contain no telemetry collector.
- CLI process tests: startup prints the actual URL before the first model;
  failed initial compilation leaves that URL available. Success/failure lines
  agree with SSE generations, attempts and duration values. No consumer API URL
  is advertised in graph-only mode.
- CLI process tests: an occupied default port falls back within 4318–4327;
  exhaustion and occupied explicit ports fail clearly. Reload retains the same
  listener. `--open` uses the bound URL once; launch failure leaves the host up.
- CLI process tests: simultaneous starts for the same real project create one
  supervisor/watcher; aliases and alternate configs in that root share its lock.
  Separate worktrees can run independently. Verify duplicate `--open`,
  config/port mismatch, startup-in-progress, crash recovery, PID reuse and
  concurrent stale-lock reclamation without disturbing unrelated processes.
- CLI process tests: `console.log` and stderr are prefixed and forwarded across
  split UTF-8 chunks, partial lines and child replacement. JSON-looking logs
  cannot become protocol messages; stderr alone does not fail a build. Check
  bounded buffering and explicit truncation under sustained child output.
- CLI process tests: redirected output is readable plain text, reloads do not
  erase log history, path/line/column tokens remain usable from a different
  invocation directory, and shutdown releases the owned listener/lock and reaps
  children. Verify the documented exit statuses.
- Install the packed CLI/inspector in an independent fixture; one command serves
  the graph without a frontend build, database, credentials or provider calls.
- A fixture representing a larger web app exposes its definition through a
  config export; inspection does not start the app's listener or call setup.
- Customer, Invoice and AccountReview nodes and declared relationships match the
  compiled Manifest; an empty graph is a valid state.
- Add/remove a relationship or object, rename a label, and edit an imported
  module: the graph updates without page navigation or viewport reset.
- Verify a linked workspace package's documented build/watch path updates the
  graph; avoid claiming that only root-file watching is sufficient.
- Syntax/compile errors and worker crashes leave the host and last graph alive;
  correcting the source clears diagnostics and publishes the new model.
- A crashed, timed-out and out-of-memory child each produce one `worker`
  diagnostic with the matching `worker.*` code and `severity: 'error'`; the UI
  presents it as a loader failure, not as an error in the user's code.
- Protocol tests: every diagnostic in `failure` or a `diagnostics` event has
  `severity: 'error'`; a `typecheck` event or snapshot field is accepted and
  rendered as warnings without blocking the model, even before the checker
  ships. Type warnings survive a successful attempt and are replaced only by a
  newer `typecheck` revision.
- `packages/relate/test`: invalid policies, native references and relationships
  produce stable codes, contextual messages, correct IDs and rooted paths.
  Missing `objectId()` also produces a structured issue during authoring/import.
- `packages/relate/test`: direct invalid-Manifest input reports Manifest paths;
  graph compilation translates applicable paths to authored registry keys.
  Independent mistakes aggregate without cascades; failed imports do not claim
  to report errors in modules that never executed.
- `packages/relate/test`: provenance enabled/disabled, moved source files and
  different source maps do not change an otherwise identical Manifest/revision.
- `packages/node/test`: embedded runtime construction preserves structured
  compilation failures. Future app-startup tests verify registered cleanup on
  failure rather than replacing useful issues with a generic startup error.
- CLI tests: normalize syntax, import, authoring and compilation failures;
  preserve multiple issues through actual child-process serialization; discard
  late diagnostics and omit frames when matching source content is unavailable.
- Inspector browser tests: an error for an existing object highlights that node
  without changing the camera; new/ambiguous IDs do not highlight the wrong
  node. Reconnection restores the current failed attempt and all issues;
  recovery clears them. Declaration links, exact-expression frames and missing
  locations are visibly distinguishable within the same graph screen.
- Rapid saves, slow compilation and slow ELK responses never restore an older
  model or layout over a newer accepted one.
- Reconnect after missed events or host restart and recover from a snapshot.
- Inspect emitted browser assets for forbidden runtime/compiler imports and
  secrets; verify both root and nested asset base paths.
- Browser verification covers graph rendering, selection/camera preservation,
  keyboard controls, error recovery and reduced motion. Measure reload time
  through visible graph update, separately from compile time.

## Source and implementation pointers

- Existing [compiler](../../packages/relate/src/compiler.ts) and
  [Manifest contract](../../packages/relate/src/model.ts).
- Existing [Node composition](../../packages/node/src/index.ts) and
  [storage contract](../../packages/runtime/src/storage.ts).
- Scaffold [CLI](../../packages/cli/README.md),
  [HTTP transport](../../packages/http/README.md) and
  [client](../../packages/client/README.md).
- [Mastra development lifecycle](https://github.com/mastra-ai/mastra/blob/main/packages/cli/src/commands/dev/dev.ts):
  build/watch and child replacement are useful precedents, not a guarantee that
  our UI must refresh its page.
- [Dagster process architecture](https://dagster.io/docs/deployment/oss/oss-deployment-architecture):
  separates webserver, code metadata and execution lifecycles. Relate's specific
  two-process layout and push-based Manifest protocol are our design.

Primary sources and local Arc layout inspected on 2026-10-07. No implementation
or performance benchmark was performed as part of writing this specification.
