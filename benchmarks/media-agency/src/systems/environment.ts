import type { Trace } from '../harness/telemetry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fault, Mutation, World } from '../world/model.js';
import { openDatabases, writeDatabases } from './databases.js';
import { startSimulators } from './simulators.js';

export async function createEnvironment(
  world: World,
  faults: Fault[] = [],
  trace?: Trace,
) {
  const directory = await mkdtemp(join(tmpdir(), 'northlight-'));
  const mutations: Mutation[] = [];
  const cleanup: (() => unknown | Promise<unknown>)[] = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  const close = async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  };

  try {
    const paths = await writeDatabases(world, directory);
    const db = await openDatabases(paths, mutations, trace);

    cleanup.push(() => db.close());
    const simulators = await startSimulators(world, mutations, faults, trace);

    cleanup.push(() => simulators.close());

    return { directory, db, simulators, mutations, close, trace };
  } catch (error) {
    await close();
    throw error;
  }
}

export type Environment = Awaited<ReturnType<typeof createEnvironment>>;
