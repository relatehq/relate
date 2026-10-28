import { Trace, telemetryVersion } from './telemetry.js';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createEnvironment } from '../systems/environment.js';
import { createArm, prompt } from './arms.js';
import type { Arm } from './arms.js';
import { generateWorld } from '../world/generator.js';
import type { Tier } from '../world/model.js';
import { json } from '../world/model.js';
import { catalogue, instantiate } from '../tasks/catalogue.js';
import type { Task } from '../tasks/catalogue.js';
import { grade } from '../tasks/grading.js';
import type { Submission } from '../tasks/grading.js';
import { referenceCode } from '../tasks/references.js';
import { agentLoop, cost, defaultBudgets } from './model.js';
import type { Model, Price, Usage } from './model.js';
import type { ModelConfig } from './providers/types.js';
import type { Row } from '../systems/simulators.js';

export const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

const repoRoot = resolve(benchmarkRoot, '../..');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export interface RunConfig {
  tier: Tier;
  seed: number;
  arms: Arm[];
  model: string;
  modelConfig?: ModelConfig;
  k: number;
  tasks: string[];
  mode: 'reference' | 'model';
  price?: Price;
}

export async function manifest(config: RunConfig) {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(
      (f) =>
        /^(benchmarks\/media-agency\/src\/|packages\/|connectors\/)/.test(f) ||
        ['pnpm-lock.yaml', 'package.json'].includes(f),
    )
    .sort();
  const digests: Record<string, string> = {};

  for (const file of files)
    if (existsSync(join(repoRoot, file)))
      digests[file] = hash(await readFile(join(repoRoot, file), 'utf8'));

  const revision = hash(json(digests));
  const contract = {
    formatVersion: 1,
    telemetryVersion,
    config,
    budgets: defaultBudgets,
    revision,
    node: process.version,
    catalogue: catalogue.map((t) => ({
      id: t.id,
      status: t.status,
      reason: t.reason,
      category: t.category,
    })),
    files: digests,
  };

  return {
    ...contract,
    id: hash(json(contract)),
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(),
    executor:
      '@relate/mcp createDevelopmentExecutor; 60s; 1MiB; development process, not a security sandbox',
    claim:
      'Relate plus benchmark integration, policies and recovery journal; not SDK-only effect',
  };
}

export async function prepareRun(out: string, config: RunConfig) {
  const value = await manifest(config);

  await mkdir(out, { recursive: true });
  const path = join(out, 'manifest.json');

  if (existsSync(path)) {
    const previous = JSON.parse(await readFile(path, 'utf8'));

    if (previous.id !== value.id)
      throw new Error(
        'Resume refused: code, catalogue, model, seeds, budgets or configuration changed. Choose a new --out directory.',
      );
  } else await writeFile(path, json(value) + '\n', { flag: 'wx' });

  return value;
}

export async function runOne(input: {
  task: Task;
  arm: Arm;
  tier: Tier;
  seed: number;
  repeat: number;
  out: string;
  manifestId: string;
  model?: Model;
  price?: Price;
}): Promise<RunResult> {
  const identity = {
    manifest: input.manifestId,
    task: input.task.id,
    arm: input.arm,
    tier: input.tier,
    seed: input.seed,
    repeat: input.repeat,
  };
  const id = hash(json(identity));
  const resultPath = join(input.out, `${id}.result.json`),
    transcriptPath = join(input.out, `${id}.jsonl`);

  if (existsSync(resultPath)) {
    const result = JSON.parse(await readFile(resultPath, 'utf8'));

    if (result.id !== id) throw new Error('Corrupt cached run');

    return result as RunResult;
  }

  // Interrupted attempts stay visible; no overwrite or silent loss of failed attempts.
  if (existsSync(transcriptPath))
    throw new Error(
      `Interrupted run ${id}; preserve it and use a new output directory`,
    );

  const trace = new Trace(
    async (event) => appendFile(transcriptPath, json(event) + '\n'),
    id,
  );
  const emit = trace.emit;

  if (input.task.status === 'deferred') {
    const result = {
      id,
      ...identity,
      category: input.task.category,
      status: 'deferred',
      reason: input.task.reason,
    };

    await writeFile(resultPath, json(result) + '\n', { flag: 'wx' });

    return result;
  }

  let env: Awaited<ReturnType<typeof createEnvironment>> | undefined;
  let arm: Awaited<ReturnType<typeof createArm>> | undefined;
  const started = performance.now();
  let result: RunResult = {
    id,
    ...identity,
    category: input.task.category,
    status: 'started',
  };
  const phase = <T>(name: string, operation: () => T | Promise<T>) =>
    trace.span('phase', name, {}, operation, true);

  try {
    const world = await phase('world', () =>
        generateWorld({ tier: input.tier, seed: input.seed }),
      ),
      task = instantiate(input.task, world);

    await emit({
      type: 'start',
      identity,
      prompt: task.prompt,
      principal: task.definition.principal,
      faults: task.faults,
    });
    env = await phase('environment-setup', () =>
      createEnvironment(world, task.faults, trace),
    );
    const environmentSetupMs = performance.now() - started;

    arm = await phase('arm-setup', () =>
      createArm(input.arm, input.task.principal, env!),
    );
    const setupMs = performance.now() - started;

    env.simulators.requests.length = 0;
    env.db.calls.length = 0;
    const runStart = performance.now();
    let submission: Submission | undefined,
      usage: Usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      metrics: Row = {},
      transcript = { assistant: '', tools: '' };

    if (input.model) {
      const loop = await phase('agent', () =>
        agentLoop({
          model: input.model!,
          arm: arm!,
          system: prompt(input.task.principal),
          prompt: task.prompt,
          emit,
          trace,
          ...(input.price ? { price: input.price } : {}),
        }),
      );

      submission = loop.submission;
      usage = loop.usage;
      transcript = loop.transcript;
      metrics = {
        usageComplete: loop.usageComplete,
        turns: loop.turns,
        toolCalls: loop.toolCalls,
        bytesReturnedByTools: loop.bytesReturnedByTools,
        modelMs: loop.modelMs,
        toolMs: loop.toolMs,
        stop: loop.stop,
      };
    } else {
      const code = referenceCode(task, input.arm);

      await emit({ type: 'reference-code', code });

      if (input.arm === 'baseline-tools') {
        const AsyncFunction = Object.getPrototypeOf(async function () {})
          .constructor as new (
          ...args: string[]
        ) => (...args: unknown[]) => Promise<unknown>;
        const call = async (name: string, args: Row) => {
          const value = await trace.span(
            'tool',
            name,
            { input: args },
            async (step) => {
              const value = await arm!.call(name, args);

              step.result = value;
              step.outputBytes = Buffer.byteLength(json(value));

              return value;
            },
            true,
          );

          transcript.tools += json(value);
          await emit({ type: 'tool', name, input: args, result: value });

          return value;
        };

        submission = (await new AsyncFunction('http', 'sql', code)(
          (system: string, request: Row) =>
            call('http_request', { system, ...request }),
          async (db: string, sql: string, params: unknown[] = []) => {
            const result = (await call('sql_query', {
              db,
              sql,
              params,
            })) as Row;

            if (result.truncated) throw Error('Reference SQL truncation');

            return result.rows;
          },
        )) as Submission;
      } else {
        const execution = (await trace.span(
          'tool',
          'execute',
          { input: { code } },
          async (step) => {
            const value = await arm!.call('execute', { code });

            step.result = value;
            step.outputBytes = Buffer.byteLength(json(value));

            if (
              value &&
              typeof value === 'object' &&
              'status' in value &&
              value.status === 'failed'
            )
              step.outcome = 'executor-failed';

            return value;
          },
          true,
        )) as {
          status: string;
          result: Submission;
          error: unknown;
        };

        await emit({ type: 'execute', result: execution });
        transcript.tools = json(execution);

        if (execution.status !== 'succeeded')
          throw new Error(json(execution.error));

        submission = execution.result;
      }

      metrics = { stop: 'reference', turns: 0, modelMs: 0 };
    }

    const wallMs = performance.now() - runStart;

    // Drain in-flight operations before inspecting end state (timeouts cannot undo a dispatched write).
    // Persist measured usage even if draining, grading or cleanup fails.
    Object.assign(result, {
      setupMs,
      environmentSetupMs,
      wallMs,
      ...usage,
      ...metrics,
      ...cost(usage, metrics.usageComplete === false ? undefined : input.price),
    });
    await phase('drain', () => arm!.close());
    arm = undefined;
    const grading = await phase('grading', () =>
      grade(
        task,
        submission,
        env!.mutations,
        env!.simulators.requests,
        world,
        transcript,
      ),
    );

    if (metrics.stop === 'budget') {
      grading.passed = false;
      grading.mistakes.push('budget');
    }

    if (metrics.stop === 'model-error') {
      grading.passed = false;
      grading.mistakes.push('model-error');
    }

    result = {
      ...result,
      status: 'completed',
      ...grading,
      faultsConfigured: task.faults,
      faultOutcomes: env.simulators.requests
        .filter((r) => task.faults.some((f) => f.kind === r.outcome))
        .map((r) => ({
          system: r.system,
          target: r.target,
          outcome: r.outcome,
          requestId: r.requestId,
        })),
      setupMs,
      environmentSetupMs,
      wallMs,
      ...usage,
      ...cost(usage, metrics.usageComplete === false ? undefined : input.price),
      ...metrics,
      sqlCalls: env.db.calls.filter((c) => !c.kind).length,
      sourceFetches: env.db.calls.filter((c) => c.kind === 'source-fetch')
        .length,
      analyticalDispatches: env.db.calls.filter(
        (c) => c.kind === 'analytical-dispatch',
      ).length,
      submission,
    };
    await emit({
      type: 'end-state',
      mutations: env.mutations,
      requests: env.simulators.requests,
      sql: env.db.calls,
    });
  } catch (error) {
    result = {
      ...result,
      status: 'failed',
      passed: false,
      mistakes: ['harness-error'],
      error: String(error),
    };
    await emit({
      type: 'error',
      error: String(error),
      mutations: env?.mutations,
      requests: env?.simulators.requests,
    });
  } finally {
    const failures: string[] = [];

    try {
      await phase('arm-cleanup', () => arm?.close());
    } catch (error) {
      failures.push(String(error));
    }

    try {
      await phase('environment-cleanup', () => env?.close());
    } catch (error) {
      failures.push(String(error));
    }

    if (failures.length) {
      await emit({ type: 'cleanup-error', errors: failures });
      result = {
        ...result,
        status: 'failed',
        passed: false,
        mistakes: [...(result.mistakes ?? []), 'cleanup-error'],
        errors: failures,
      };
    }
  }

  await emit({
    type: 'run-end',
    status: result.status,
    passed: result.passed,
    mistakes: result.mistakes,
  });
  result.telemetry = trace.summary();
  await writeFile(resultPath, json(result) + '\n', { flag: 'wx' });

  return result;
}

export interface RunResult extends Row {
  id: string;
  task: string;
  arm: Arm;
  tier: Tier;
  seed: number;
  repeat: number;
  category: string;
  status: string;
  passed?: boolean;
  mistakes?: string[];
}

export async function readResults(out: string): Promise<RunResult[]> {
  const paths = (await readdir(out))
    .filter((p) => p.endsWith('.result.json'))
    .sort();

  return Promise.all(
    paths.map(
      async (p) =>
        JSON.parse(await readFile(join(out, p), 'utf8')) as RunResult,
    ),
  );
}
