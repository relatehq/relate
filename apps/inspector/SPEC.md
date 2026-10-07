# Inspector foundation and live model graph

**Status:** architecture and one-screen scope agreed on 2026-10-07;
configuration and protocol signatures below are proposed. This is a
specification, not an implemented or published inspector.

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
- Authoritative Manifest snapshots plus typed diffs; no browser page reload.
- `defineApp` belongs in `@relate/node`; graph authoring stays in `relate`.
- Browser code never imports the runtime, compiler, connectors or user modules.

**Proposed scope decision:** the first graph-only worker compiles definitions
without starting a live runtime. It needs no database, credentials or provider
requests. Live runtime hosting remains the agreed extension of this process
layout, with activation and storage questions explicitly open below.

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
validation, but never on `relate/compiler` or `@relate/node`.

Do not put an inspector DTO importing `Manifest` into `@relate/protocol` without
revisiting the dependency graph: `relate` already depends on that package. Keep
inspection DTO ownership in the inspector package to avoid this cycle.

Allowed direction:

```text
CLI -> inspector/server, inspector/protocol, node, relate/compiler
browser -> inspector/protocol -> relate/model
node -> relate/compiler, runtime
runtime -> relate/model, protocol
```

When consumer screens exist, the browser also uses `@relate/client`. It never
uses the dev channel as a shortcut around consumer authorization. Server-side
inspection adapters can accept narrow host capabilities; the prohibition on
runtime imports applies to browser code.

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

Debounce saves, assign each attempt an ID, and publish only the newest
successful candidate. Ignore a late result from an older build or child. Stop
superseded children; one failed candidate must not stop the host or event
stream.

The first scope publishes **compiled models**, not live runtime activations:

```ts
// Proposed wire shapes, validated at runtime as well as typed in TypeScript.
import type { Manifest } from 'relate/model';

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
      diagnostic: Diagnostic | null;
    }
  | {
      type: 'model';
      model: ModelSnapshot;
      fromGeneration: number | null;
      diff: ManifestDiff;
      durationMs: number;
    }
  | { type: 'diagnostic'; attempt: number; diagnostic: Diagnostic }
);

type Diagnostic = {
  code: string;
  message: string;
  frame?: { file: string; line: number; column: number; excerpt: string };
};
```

Successful accepted evaluations advance `generation`, even if the definition
hash is unchanged. Failed attempts do not advance it. Diff arrays contain stable
definition IDs. The complete snapshot is authoritative; diffs describe changes
for rendering and do not have to patch a previous manifest successfully.

Every SSE connection begins with an atomically captured snapshot and sequence,
then receives subsequent events in order. Snapshot and subscription registration
must not leave a race where an update is lost. On reconnect send a fresh
snapshot, including the current diagnostic; durable event replay is unnecessary
for this screen. Ignore duplicates and resynchronize on a sequence gap. A new
`instanceId` resets sequence/generation comparisons. `/dev/snapshot` returns the
same current state for explicit resynchronization.

Compile errors display next to the last accepted graph. An initial error shows
an empty graph state with its diagnostic. Successful recovery clears the error.
Display connection loss separately from invalid source code. Diagnostics should
use source maps and project-relative paths; full diagnostic metadata is for
authorized local development, never an unrestricted public endpoint.

Use a loopback host, same-origin browser requests, Host/Origin validation and a
local session bootstrap. The UI receives model metadata and sanitized errors,
not provider credentials, arbitrary filesystem access or environment dumps. The
Manifest can include policy structure, so this is trusted model inspection, not
the consumer's authorized discovery response.

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
