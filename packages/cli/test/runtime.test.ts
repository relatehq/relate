/**
 * Process tests for the runtime host: real children started from the built
 * CLI, each test writing its own application module.
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  createActivityLog,
  createRuntimeController,
  defaultRuntimeHostPath,
  encodeRuntimeHostArguments,
  withActivityContext,
} from '@relate/cli';
import type { ActivityLog, RuntimeController } from '@relate/cli';
import type { RuntimeStatus } from '@relate/inspector/protocol';
import { startApp } from '@relate/node';
import { ActionError, ReadError } from '@relate/protocol';
import { compile } from 'relate/compiler';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A native Note object, an action that creates one and two principals. */
function noteApp(
  options: { setup?: string; implementation?: string; input?: string } = {},
) {
  return `import { z } from 'zod';
import {
  defineAccess, defineAction, defineApp, defineGraph, defineObject,
  implementAction, native, nativeMembership, objectId,
} from 'relate';

const access = defineAccess({
  roles: ['reader', 'writer'],
  fieldGroups: ['ordinary'],
  claims: { team: z.string() },
});
export const Note = defineObject({
  id: 'notes.note',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    body: native(z.string(), { id: 'note.body' }),
  },
});
const AddNote = defineAction({
  id: 'notes.add',
  input: ${options.input ?? 'z.object({ body: z.string() })'},
  output: z.object({ ok: z.boolean() }),
  creates: [Note],
  policy: { execute: access.role('writer') },
});
export const graph = defineGraph({
  id: 'notes',
  objects: { Note },
  actions: { addNote: AddNote },
  access,
  policies: {
    Note: {
      read: { gate: access.role('reader') },
      create: { gate: access.role('writer') },
    },
  },
  principals: {
    alice: { roles: ['reader', 'writer'], claims: { team: 'core' } },
    bob: { roles: [] },
  },
});
const addNote = implementAction(graph, AddNote, ${
    options.implementation ??
    `async ({ input, objects }) => {
  await objects.Note.create({ body: input.body });

  return { ok: true };
}`
  });

export default defineApp({
  graph,
  setup: ${
    options.setup ??
    `() => ({ connections: [], actionImplementations: [addNote] })`
  },
});
`;
}

interface Project {
  readonly root: string;
  readonly configPath: string;
  /** Write one accepted build and return it with a release spy. */
  build(source: string): Promise<{
    readonly path: string;
    readonly released: () => boolean;
    readonly bundle: { readonly path: string; release(): Promise<void> };
  }>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createProject(): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), 'relate-runtime-test-'));
  let builds = 0;

  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

  return {
    root,
    configPath: join(root, 'relate.config.ts'),
    async build(source) {
      builds += 1;
      const path = join(root, `build-${builds}.mjs`);
      let released = false;

      await writeFile(path, source);

      return {
        path,
        released: () => released,
        bundle: {
          path,
          release: async () => {
            released = true;
          },
        },
      };
    },
  };
}

function createController(
  project: Project,
  options: {
    seed?: boolean;
    env?: NodeJS.ProcessEnv;
    drainTimeoutMs?: number;
    startTimeoutMs?: number;
    activity?: ActivityLog;
  } = {},
) {
  const statuses: RuntimeStatus[] = [];
  const stdout: string[] = [];
  const controller: RuntimeController = createRuntimeController({
    projectRoot: project.root,
    configPath: project.configPath,
    env: options.env ?? process.env,
    onStatus: (status) => statuses.push(status),
    writeStdout: (line) => stdout.push(line),
    writeStderr: () => {},
    seed: options.seed ?? false,
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.drainTimeoutMs !== undefined
      ? { drainTimeoutMs: options.drainTimeoutMs }
      : {}),
    ...(options.startTimeoutMs !== undefined
      ? { startTimeoutMs: options.startTimeoutMs }
      : {}),
  });

  cleanups.push(() => controller.stop());

  const waitFor = async (
    predicate: (status: RuntimeStatus) => boolean,
    timeoutMs = 15_000,
  ): Promise<RuntimeStatus> => {
    const started = Date.now();

    for (;;) {
      const found = statuses.find(predicate);

      if (found) return found;

      if (Date.now() - started > timeoutMs)
        throw new Error(
          `Timed out waiting for a runtime status: ${JSON.stringify(statuses)}`,
        );

      await new Promise((done) => setTimeout(done, 20));
    }
  };

  return { controller, statuses, stdout, waitFor };
}

it('starts the application and serves graph operations for a declared principal', async () => {
  const project = await createProject();
  const build = await project.build(noteApp());
  const { controller, waitFor } = createController(project);

  await controller.restart({ generation: 1, bundle: build.bundle });
  const running = await waitFor((s) => s.state === 'running');
  const alice = await controller.binding('alice');
  const receipt = await alice.operations.invoke('notes.add', {
    input: { body: 'Call the customer' },
    idempotencyKey: 'first',
  });
  const page = await alice.operations.query('notes.note');

  expect(running).toMatchObject({
    generation: 1,
    store: 'memory',
    dataReset: false,
    diagnostics: [],
  });
  expect(alice).toMatchObject({
    runtimeId: running.runtimeId,
    definitionRevision: running.definitionRevision,
    principal: 'alice',
  });
  expect(receipt).toMatchObject({ state: 'succeeded', output: { ok: true } });
  expect(page.data).toHaveLength(1);
  // A principal the running runtime does not declare (e.g. added after it started).
  await expect(controller.binding('mallory')).rejects.toMatchObject({
    name: 'RuntimeUnavailableError',
    reason: 'unknown-principal',
    retryable: true,
    message: expect.stringContaining(
      "does not declare principal 'mallory'; it serves alice, bob",
    ),
  });
});

it('serves a discovery snapshot equal to runtime.operations(principal).discovery', async () => {
  const project = await createProject();
  const build = await project.build(noteApp());
  const { controller, waitFor } = createController(project);
  const app = (await import(pathToFileURL(build.path).href)).default;
  const model = compile(app.graph);
  const local = await startApp(app);

  cleanups.push(() => local.close());

  await controller.restart({ generation: 1, bundle: build.bundle });
  await waitFor((s) => s.state === 'running');
  const bindings = {
    alice: await controller.binding('alice'),
    bob: await controller.binding('bob'),
  };

  for (const [name, binding] of Object.entries(bindings)) {
    const expected = local.operations({
      id: name,
      ...model.principals[name]!,
    }).discovery;
    const actual = binding.operations.discovery;

    expect(actual.describe()).toEqual(expected.describe());
    expect(actual.describeObject('notes.note')).toEqual(
      expected.describeObject('notes.note'),
    );
    expect(actual.describeAction('notes.add')).toEqual(
      expected.describeAction('notes.add'),
    );
    expect(actual.describeObject('missing')).toBeUndefined();
  }

  expect(bindings.alice.description).toEqual(
    JSON.parse(JSON.stringify(model.consumer)),
  );
  expect(
    Object.keys(bindings.bob.operations.discovery.describe().objects),
  ).toEqual([]);
});

it('ignores the seed export without opt-in, including in ordinary startApp', async () => {
  const project = await createProject();
  const build = await project.build(`${noteApp()}
export function seed() { throw new Error('Seed must not run'); }
`);
  const { controller, waitFor } = createController(project);
  const local = await startApp(
    (await import(pathToFileURL(build.path).href)).default,
  );

  cleanups.push(() => local.close());
  await controller.restart({ generation: 1, bundle: build.bundle });
  await waitFor((s) => s.state === 'running');
  const binding = await controller.binding('alice');

  expect((await binding.operations.query('notes.note')).data).toEqual([]);
});

it('reports a missing application before a missing seed in the runtime host', async () => {
  const project = await createProject();
  // Defensive host check; an ordinary invalid edit is rejected by the compile worker.
  const build = await project.build('export const unrelated = true;');
  const { controller, waitFor } = createController(project, { seed: true });

  await controller.restart({ generation: 1, bundle: build.bundle });
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({ code: 'runtime.no-definition' }),
  ]);
});

it.each([
  [
    'unhandled-rejection',
    "relate.host.adopt({}, 'missing'); await new Promise((done) => setTimeout(done, 100));",
  ],
  ['uncaught', "setTimeout(() => { throw new Error('Timer failed'); }, 20);"],
])(
  'cleans up before reporting an escaped seed error: %s',
  async (code, seedBody) => {
    const project = await createProject();
    const marker = join(project.root, 'fatal-disposed');
    const build = await project.build(`import { writeFileSync } from 'node:fs';
${noteApp({
  setup: `({ onDispose }) => {
      onDispose(async () => {
        await new Promise((done) => setTimeout(done, 150));
        writeFileSync(${JSON.stringify(marker)}, 'disposed');
      });
      return { connections: [], actionImplementations: [addNote] };
    }`,
})}
export async function seed(relate) { ${seedBody} }
`);
    const { controller, waitFor } = createController(project, { seed: true });

    await controller.restart({ generation: 1, bundle: build.bundle });
    const failed = await waitFor((s) => s.state === 'failed');

    expect(failed.diagnostics).toEqual([
      expect.objectContaining({ code: 'runtime.' + code }),
    ]);
    expect(existsSync(marker)).toBe(true);
    await expect(controller.binding('alice')).rejects.toMatchObject({
      reason: 'not-running',
    });
    await expect.poll(() => build.released()).toBe(true);
  },
);

it('bounds cleanup after an escaped seed error and preserves its diagnostic', async () => {
  const project = await createProject();
  const build = await project.build(`${noteApp({
    setup: `({ onDispose }) => {
      onDispose(() => new Promise(() => {}));
      return { connections: [], actionImplementations: [addNote] };
    }`,
  })}
export function seed() {
  setTimeout(() => { throw new Error('Timer failed'); }, 20);
}
`);
  const { controller, waitFor } = createController(project, {
    seed: true,
    drainTimeoutMs: 200,
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  await waitFor((s) => s.state === 'running');
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({
      code: 'runtime.uncaught',
      message: expect.stringContaining('Timer failed'),
    }),
  ]);
  await expect.poll(() => build.released()).toBe(true);
});

it.each(['', 'export const seed = 42;'])(
  'requires a seed function before opening application resources: %s',
  async (seed) => {
    const project = await createProject();
    const build = await project.build(
      `${noteApp({
        setup: "() => { throw new Error('Setup must not run'); }",
      })}\n${seed}`,
    );
    const { controller, waitFor } = createController(project, { seed: true });

    await controller.restart({ generation: 1, bundle: build.bundle });
    const failed = await waitFor((s) => s.state === 'failed');

    expect(failed.diagnostics).toEqual([
      expect.objectContaining({ code: 'runtime.seed-missing' }),
    ]);
    await expect(controller.binding('alice')).rejects.toMatchObject({
      reason: 'not-running',
    });
  },
);

it('closes resources after a failed seed and recovers with seeded native data on the next build', async () => {
  const project = await createProject();
  const marker = join(project.root, 'seed-disposed');
  const failedBuild =
    await project.build(`import { writeFileSync } from 'node:fs';
${noteApp({
  setup: `({ onDispose }) => {
      onDispose(async () => {
        await new Promise((done) => setTimeout(done, 50));
        writeFileSync(${JSON.stringify(marker)}, 'disposed');
      });
      return { connections: [], actionImplementations: [addNote] };
    }`,
})}
export async function seed() { throw new Error('Fixture unavailable'); }
`);
  const next = await project.build(`${noteApp()}
export async function seed(relate) {
  await relate.as({ id: 'alice', roles: ['writer'] }).actions.addNote({
    input: { body: 'Seeded note' }, idempotencyKey: 'seed-note',
  });
}
`);
  const { controller, waitFor } = createController(project, { seed: true });

  await controller.restart({ generation: 1, bundle: failedBuild.bundle });
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({
      code: 'runtime.seed-failed',
      message: expect.stringContaining('Fixture unavailable'),
    }),
  ]);
  expect(existsSync(marker)).toBe(true);
  await expect(controller.binding('alice')).rejects.toMatchObject({
    reason: 'not-running',
  });
  await controller.restart({ generation: 2, bundle: next.bundle });
  await waitFor((s) => s.state === 'running' && s.generation === 2);
  const binding = await controller.binding('alice');

  expect((await binding.operations.query('notes.note')).data).toMatchObject([
    { data: { body: 'Seeded note' } },
  ]);
});

it('finishes and cleans up a seed retired during startup without publishing it as running', async () => {
  const project = await createProject();
  const marker = join(project.root, 'retired-seed-disposed');
  const build = await project.build(`import { writeFileSync } from 'node:fs';
${noteApp({
  setup: `({ onDispose }) => {
      onDispose(() => writeFileSync(${JSON.stringify(marker)}, 'disposed'));
      return { connections: [], actionImplementations: [addNote] };
    }`,
})}
export async function seed() {
  console.log('seed started');
  await new Promise((done) => setTimeout(done, 300));
}
`);
  const { controller, statuses, stdout } = createController(project, {
    seed: true,
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  await expect
    .poll(() => stdout.join('\n'), { timeout: 15_000 })
    .toContain('seed started');
  await controller.stop();

  expect(existsSync(marker)).toBe(true);
  expect(statuses.some((s) => s.state === 'running')).toBe(false);
});

it('bounds a seed that never settles by the runtime startup deadline', async () => {
  const project = await createProject();
  const build = await project.build(`${noteApp()}
export function seed() {
  console.log('seed started');
  return new Promise(() => {});
}
`);
  const { controller, stdout, waitFor } = createController(project, {
    seed: true,
    startTimeoutMs: 3_000,
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  await expect
    .poll(() => stdout.join('\n'), { timeout: 15_000 })
    .toContain('seed started');
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({ code: 'runtime.timeout' }),
  ]);
  await expect.poll(() => build.released()).toBe(true);
});

it('restarts on every accepted build, resets in-memory data and never replays on the new runtime', async () => {
  const project = await createProject();
  const first = await project.build(noteApp());
  const second = await project.build(noteApp());
  const { controller, waitFor } = createController(project);

  await controller.restart({ generation: 1, bundle: first.bundle });
  const one = await waitFor((s) => s.state === 'running');
  const old = await controller.binding('alice');

  await old.operations.invoke('notes.add', {
    input: { body: 'Before the reload' },
    idempotencyKey: 'before',
  });
  await controller.restart({ generation: 2, bundle: second.bundle });
  const restarting = await waitFor((s) => s.state === 'restarting');
  const two = await waitFor((s) => s.state === 'running' && s.generation === 2);
  const retiredRead = await old.operations
    .query('notes.note')
    .catch((error: unknown) => error);
  const retiredAction = await old.operations
    .invoke('notes.add', {
      input: { body: 'After the reload' },
      idempotencyKey: 'after',
    })
    .catch((error: unknown) => error);
  const current = await controller.binding('alice');

  expect(retiredRead).toBeInstanceOf(ReadError);
  expect(retiredRead).toMatchObject({ code: 'runtime-retired' });
  expect(retiredAction).toBeInstanceOf(ActionError);
  expect(retiredAction).toMatchObject({ code: 'runtime-retired' });
  expect(restarting.runtimeId).not.toBe(one.runtimeId);
  expect(two).toMatchObject({ dataReset: true, store: 'memory' });
  expect(two.runtimeId).not.toBe(one.runtimeId);
  // Same Manifest, new runtime: the revision is unchanged, the identity is not.
  expect(two.definitionRevision).toBe(one.definitionRevision);
  expect(current.runtimeId).toBe(two.runtimeId);
  // Neither the old note nor the rejected action reached the new runtime.
  expect((await current.operations.query('notes.note')).data).toEqual([]);
  expect(first.released()).toBe(true);
  expect(second.released()).toBe(false);
});

it('drains a retired runtime until its deadline, then kills it and reports the cut-off action as uncertain', async () => {
  const project = await createProject();
  const stuck = await project.build(
    noteApp({ implementation: '() => new Promise(() => {})' }),
  );
  const next = await project.build(noteApp());
  const { controller, waitFor } = createController(project, {
    drainTimeoutMs: 200,
  });

  await controller.restart({ generation: 1, bundle: stuck.bundle });
  await waitFor((s) => s.state === 'running');
  const binding = await controller.binding('alice');
  const inFlight = binding.operations
    .invoke('notes.add', {
      input: { body: 'Never finishes' },
      idempotencyKey: 'stuck',
    })
    .catch((error: unknown) => error);

  // Let the request reach the host before retiring it.
  await new Promise((done) => setTimeout(done, 100));
  await controller.restart({ generation: 2, bundle: next.bundle });

  expect(await inFlight).toMatchObject({
    name: 'ActionError',
    code: 'uncertain',
  });
  expect(
    await waitFor((s) => s.state === 'running' && s.generation === 2),
  ).toMatchObject({ dataReset: true });
});

it('reports a setup failure as a runtime diagnostic and serves no bindings', async () => {
  const project = await createProject();
  const build = await project.build(
    noteApp({
      setup: "() => { throw new Error('Missing CRM_TOKEN'); }",
    }),
  );
  const { controller, waitFor } = createController(project);

  await controller.restart({ generation: 1, bundle: build.bundle });
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed).toMatchObject({
    generation: 1,
    definitionRevision: null,
    diagnostics: [
      {
        kind: 'runtime',
        severity: 'error',
        code: 'runtime.setup-failed',
        message: expect.stringContaining('Missing CRM_TOKEN'),
      },
    ],
  });
  await expect(controller.binding('alice')).rejects.toMatchObject({
    name: 'RuntimeUnavailableError',
    reason: 'not-running',
    retryable: false,
    message: expect.stringContaining('The runtime failed to start'),
  });
  await expect.poll(() => build.released()).toBe(true);
});

it('reports a persistent store that holds another revision and leaves it untouched', async () => {
  const project = await createProject();
  const build = await project.build(
    `import { createMemoryStore } from '@relate/runtime';\n${noteApp({
      setup: `() => {
    const store = createMemoryStore();

    return {
      connections: [],
      actionImplementations: [addNote],
      store: {
        ...store,
        install: async () => {
          throw new Error('Installed model differs; explicit migration required');
        },
      },
    };
  }`,
    })}
export function seed() { console.log('seed must not run'); }
`,
  );
  const { controller, stdout, waitFor } = createController(project, {
    seed: true,
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({
      kind: 'runtime',
      code: 'runtime.store-revision-mismatch',
      message: expect.stringContaining('left untouched'),
    }),
  ]);
  expect(stdout.join('\n')).not.toContain('seed must not run');
});

it('reports the application store and withholds ANTHROPIC_API_KEY from the runtime host', async () => {
  const project = await createProject();
  const build = await project.build(
    `import { createMemoryStore } from '@relate/runtime';\n${noteApp({
      setup: `() => {
    console.log('key:' + (process.env.ANTHROPIC_API_KEY ?? 'absent'));
    console.log('marker:' + process.env.RELATE_RUNTIME_MARKER);

    return {
      connections: [],
      actionImplementations: [addNote],
      store: createMemoryStore(),
    };
  }`,
    })}`,
  );
  const { controller, stdout, waitFor } = createController(project, {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      RELATE_RUNTIME_MARKER: 'inherited',
    },
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  const running = await waitFor((s) => s.state === 'running');

  expect(running.store).toBe('application');
  await expect
    .poll(() => stdout.join('\n'))
    .toContain('[runtime gen 1 stdout] marker:inherited');
  expect(stdout.join('\n')).toContain('[runtime gen 1 stdout] key:absent');
  expect(stdout.join('\n')).not.toContain('sk-ant-secret');
});

it('passes action inputs through unchanged, so NaN is rejected exactly as in an embedded runtime', async () => {
  const project = await createProject();
  const build = await project.build(
    noteApp({
      input: 'z.object({ score: z.number().nullable() })',
      implementation: 'async () => ({ ok: true })',
    }),
  );
  const { controller, waitFor } = createController(project);
  const local = await startApp(
    (await import(pathToFileURL(build.path).href)).default,
  );

  cleanups.push(() => local.close());
  await controller.restart({ generation: 1, bundle: build.bundle });
  await waitFor((s) => s.state === 'running');
  const alice = await controller.binding('alice');
  const request = { input: { score: Number.NaN }, idempotencyKey: 'nan' };
  const embedded = await local
    .operations({
      id: 'alice',
      roles: ['reader', 'writer'],
      claims: { team: 'core' },
    })
    .invoke('notes.add', request)
    .catch((error: unknown) => error);
  const overIpc = await alice.operations
    .invoke('notes.add', request)
    .catch((error: unknown) => error);
  // A function cannot cross IPC at all (agent JavaScript can still pass
  // one); it is rejected before sending.
  const unsendable = await alice.operations
    .invoke('notes.add', {
      input: { score: (() => 1) as unknown as number },
      idempotencyKey: 'fn',
    })
    .catch((error: unknown) => error);

  expect(embedded).toMatchObject({ name: 'ActionError', code: 'invalid' });
  expect(overIpc).toBeInstanceOf(ActionError);
  expect(overIpc).toMatchObject({ code: 'invalid' });
  expect(unsendable).toMatchObject({ name: 'ActionError', code: 'invalid' });
});

it('sends the reply of an action that completes while the runtime drains', async () => {
  const project = await createProject();
  const slow = await project.build(
    noteApp({
      implementation: `async ({ input, objects }) => {
  await new Promise((done) => setTimeout(done, 300));
  await objects.Note.create({ body: input.body });

  return { ok: true };
}`,
    }),
  );
  const next = await project.build(noteApp());
  const { controller, waitFor } = createController(project);

  await controller.restart({ generation: 1, bundle: slow.bundle });
  await waitFor((s) => s.state === 'running');
  const binding = await controller.binding('alice');
  const inFlight = binding.operations.invoke('notes.add', {
    input: { body: 'Finishes during the drain' },
    idempotencyKey: 'drain',
  });

  await new Promise((done) => setTimeout(done, 50));
  await controller.restart({ generation: 2, bundle: next.bundle });

  expect(await inFlight).toMatchObject({ state: 'succeeded' });
});

it('forwards the runtime record of an operation whose row is still being appended at retirement', async () => {
  const project = await createProject();
  const slowAppend = await project.build(
    `import { createMemoryStore } from '@relate/runtime';\n${noteApp({
      setup: `() => {
    const store = createMemoryStore();
    const activity = store.activity;

    return {
      connections: [],
      actionImplementations: [addNote],
      store: {
        ...store,
        activity: {
          ...activity,
          appendOperations: async (...args) => {
            await new Promise((done) => setTimeout(done, 300));

            return activity.appendOperations(...args);
          },
        },
      },
    };
  }`,
    })}`,
  );
  const next = await project.build(noteApp());
  const activity = createActivityLog();
  const { controller, waitFor } = createController(project, { activity });

  await controller.restart({ generation: 1, bundle: slowAppend.bundle });
  await waitFor((s) => s.state === 'running');
  const binding = await controller.binding('alice');
  const call = {
    kind: 'call',
    requestId: 'retire',
    runtimeId: binding.runtimeId,
    source: 'external',
    principal: 'alice',
    tool: 'execute',
    at: new Date().toISOString(),
  } as const;

  activity.record({ ...call, status: 'running' });
  expect(
    await withActivityContext(binding.operations, {
      requestId: 'retire',
      runtimeId: binding.runtimeId,
      definitionRevision: binding.definitionRevision,
      principal: 'alice',
      transport: 'mcp',
    }).invoke('notes.add', {
      input: { body: 'Recorded before retirement' },
      idempotencyKey: 'retire',
    }),
  ).toMatchObject({ state: 'succeeded' });
  await controller.restart({ generation: 2, bundle: next.bundle });
  await waitFor((s) => s.state === 'running' && s.generation === 2);

  // The row lands after the reply; the retiring host waits for it.
  await expect
    .poll(() =>
      activity
        .snapshot()
        .find((event) => event.kind === 'operation' && event.op === 'invoke'),
    )
    .toMatchObject({ runtime: { record: 'attempt', outcome: 'succeeded' } });
});

it('finishes a slow setup when retired during startup, so its cleanup runs', async () => {
  const project = await createProject();
  const marker = join(project.root, 'disposed');
  const slow = await project.build(
    `import { writeFileSync } from 'node:fs';\n${noteApp({
      setup: `async ({ onDispose }) => {
    onDispose(() => writeFileSync(${JSON.stringify(marker)}, 'disposed'));
    console.log('setup started');
    await new Promise((done) => setTimeout(done, 300));

    return { connections: [], actionImplementations: [addNote] };
  }`,
    })}`,
  );
  const next = await project.build(noteApp());
  const { controller, statuses, stdout, waitFor } = createController(project);

  await controller.restart({ generation: 1, bundle: slow.bundle });
  // Retire it only once setup is under way; earlier, nothing needs cleanup.
  await expect
    .poll(() => stdout.join('\n'), { timeout: 15_000 })
    .toContain('setup started');
  const started = Date.now();

  await controller.restart({ generation: 2, bundle: next.bundle });
  await waitFor((s) => s.state === 'running' && s.generation === 2);

  expect(existsSync(marker)).toBe(true);
  // Closed by the host itself, not killed at the 5 s drain deadline.
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(statuses.some((s) => s.state === 'failed')).toBe(false);
});

it('exits on its own when the dev server disconnects during a setup that never settles', async () => {
  const project = await createProject();
  const build = await project.build(
    noteApp({
      setup: `() => {
    setInterval(() => {}, 1_000);
    console.log('setup started');

    return new Promise(() => {});
  }`,
    }),
  );
  const child = fork(
    defaultRuntimeHostPath(),
    [
      encodeRuntimeHostArguments({
        bundlePath: build.path,
        projectRoot: project.root,
        configPath: project.configPath,
        runtimeId: 'runtime-1',
        seed: false,
        drainTimeoutMs: 200,
      }),
    ],
    {
      cwd: project.root,
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      serialization: 'advanced',
    },
  );
  const exited = new Promise<number | null>((done) =>
    child.once('exit', (code) => done(code)),
  );

  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  });
  await new Promise<void>((done) =>
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('setup started')) done();
    }),
  );
  child.disconnect();

  expect(await exited).toBe(1);
});

it('reports a host that cannot be spawned, releases its bundle and still stops', async () => {
  const project = await createProject();
  const build = await project.build(noteApp());
  const { controller, waitFor } = createController({
    ...project,
    root: join(project.root, 'missing'),
  });

  await controller.restart({ generation: 1, bundle: build.bundle });
  const failed = await waitFor((s) => s.state === 'failed');

  expect(failed.diagnostics).toEqual([
    expect.objectContaining({ code: 'runtime.spawn-failed' }),
  ]);
  await controller.stop();
  expect(build.released()).toBe(true);
});

it.each([false, true])(
  'reports a bare graph missing connections with seed=%s',
  async (seed) => {
    const project = await createProject();
    const build = await project.build(`import { z } from 'zod';
import {
  defineAccess, defineGraph, defineObject, defineSource, from, objectId, source,
} from 'relate';

const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: {} });
const customers = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});
const Customer = defineObject({
  id: 'crm.customer',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(customers.fields.name, { id: 'customer.name' }),
  },
});

export default defineGraph({
  id: 'crm',
  objects: { Customer },
  access,
  policies: { Customer: { read: { gate: access.role('reader') } } },
});
export function seed() { throw new Error('Seed must not run without bindings'); }
`);
    const { controller, statuses, waitFor } = createController(project, {
      seed,
    });

    await controller.restart({ generation: 1, bundle: build.bundle });
    const status = await waitFor(
      (s) => s.state === (seed ? 'failed' : 'not-configured'),
    );

    expect(status.diagnostics).toEqual([
      expect.objectContaining({
        code: seed ? 'runtime.setup-failed' : 'runtime.not-configured',
        severity: seed ? 'error' : 'warning',
      }),
    ]);

    if (seed)
      expect(status.diagnostics[0]?.message).toContain(
        'the requested seed could not run',
      );

    expect(statuses.some((s) => s.state === 'failed')).toBe(seed);
    await expect.poll(() => build.released()).toBe(true);
  },
);
