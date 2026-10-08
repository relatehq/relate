/**
 * One `relate dev` per project. The lock lives under `<root>/.relate/dev/` and
 * is published exclusively with an atomic hard link; metadata identifies the owner so a
 * second invocation can verify, wait for or report it, and reclaim only a
 * demonstrably dead owner.
 */
import { randomBytes } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const lockMetadataSchema = z.strictObject({
  version: z.literal(1),
  pid: z.number().int().positive(),
  /** Unguessable per-supervisor identity, verified through the identity endpoint. */
  ownerId: z.string().min(16),
  instanceId: z.string().min(1),
  /** Process start time as the OS reports it, when available; defends against PID reuse. */
  processStartedAt: z.string().nullable(),
  startedAt: z.string(),
  configPath: z.string(),
  state: z.enum(['starting', 'listening']),
  url: z.string().nullable(),
});

export type LockMetadata = z.infer<typeof lockMetadataSchema>;

export function devDirectory(projectRoot: string): string {
  return join(projectRoot, '.relate', 'dev');
}

export function lockPath(projectRoot: string): string {
  return join(devDirectory(projectRoot), 'lock.json');
}

/** `ps` start time for a PID, or null when unavailable on this platform. */
export async function processStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;

  try {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'lstart=',
      '-p',
      String(pid),
    ]);
    const value = stdout.trim();

    return value.length ? value : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;

  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export interface Lock {
  readonly path: string;
  readonly metadata: LockMetadata;
  update(patch: Partial<Pick<LockMetadata, 'state' | 'url'>>): Promise<void>;
  release(): Promise<void>;
}

export type AcquireResult =
  | { readonly kind: 'acquired'; readonly lock: Lock }
  | {
      readonly kind: 'held';
      readonly metadata: LockMetadata;
      readonly path: string;
    }
  | {
      readonly kind: 'unverifiable';
      readonly path: string;
      readonly reason: string;
      readonly metadata: LockMetadata | null;
    };

export interface AcquireOptions {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly instanceId: string;
  /** Verify a live-looking owner through its identity endpoint. */
  readonly verifyOwner: (metadata: LockMetadata) => Promise<boolean>;
  readonly waitForUrlMs?: number;
  readonly now?: () => Date;
}

async function readMetadata(
  path: string,
): Promise<LockMetadata | null | 'corrupt'> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;

    throw error;
  }

  try {
    return lockMetadataSchema.parse(JSON.parse(raw));
  } catch {
    return 'corrupt';
  }
}

async function tryCreate(
  path: string,
  metadata: LockMetadata,
): Promise<Lock | null> {
  const candidate = `${path}.${randomBytes(12).toString('hex')}.tmp`;

  try {
    await writeFile(candidate, JSON.stringify(metadata, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    // Publish complete metadata atomically without replacing an existing owner.
    await link(candidate, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;

    throw error;
  } finally {
    await rm(candidate, { force: true });
  }

  let current = metadata;

  return {
    path,
    get metadata() {
      return current;
    },
    async update(patch) {
      current = { ...current, ...patch };
      await writeAtomic(path, JSON.stringify(current, null, 2));
    },
    async release() {
      // Never remove a newer owner's metadata.
      const onDisk = await readMetadata(path);

      if (onDisk && onDisk !== 'corrupt' && onDisk.ownerId !== current.ownerId)
        return;

      await rm(path, { force: true });
    },
  };
}

/** The owner is gone when its PID is dead or the PID now belongs to a process started at another time. */
async function ownerGone(metadata: LockMetadata): Promise<boolean> {
  if (!processAlive(metadata.pid)) return true;

  if (metadata.processStartedAt) {
    const started = await processStartTime(metadata.pid);

    if (started && started !== metadata.processStartedAt) return true;
  }

  return false;
}

/** Serialize reclaimers, then verify the owner again before removing its lock. */
async function reclaim(
  path: string,
  expectedOwnerId: string,
): Promise<boolean> {
  const guardPath = `${path}.reclaim`;
  let guard;

  try {
    guard = await open(guardPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;

    throw error;
  }

  try {
    const current = await readMetadata(path);

    if (current === null) return true;

    // A previous reclaimer may already have installed a new live owner.
    if (current === 'corrupt' || current.ownerId !== expectedOwnerId)
      return true;

    if (!(await ownerGone(current))) return false;

    await rm(path);

    return true;
  } finally {
    await guard.close();
    await rm(guardPath, { force: true });
  }
}

export async function acquireLock(
  options: AcquireOptions,
): Promise<AcquireResult> {
  const path = lockPath(options.projectRoot);
  const now = options.now ?? (() => new Date());

  await mkdir(devDirectory(options.projectRoot), { recursive: true });
  const metadata: LockMetadata = {
    version: 1,
    pid: process.pid,
    ownerId: randomBytes(24).toString('base64url'),
    instanceId: options.instanceId,
    processStartedAt: await processStartTime(process.pid),
    startedAt: now().toISOString(),
    configPath: options.configPath,
    state: 'starting',
    url: null,
  };

  acquire: for (let round = 0; round < 3; round += 1) {
    const lock = await tryCreate(path, metadata);

    if (lock) return { kind: 'acquired', lock };

    const existing = await readMetadata(path);

    if (existing === null) continue;

    if (existing === 'corrupt')
      return {
        kind: 'unverifiable',
        path,
        metadata: null,
        reason: 'The lock file is not readable metadata',
      };

    if (await ownerGone(existing)) {
      if (await reclaim(path, existing.ownerId)) continue;

      return {
        kind: 'unverifiable',
        path,
        metadata: existing,
        reason: `Another command is reclaiming the lock. If no relate dev is running, remove ${path}.reclaim and retry`,
      };
    }

    // Alive owner: wait briefly for a starting server to publish its URL.
    let current: LockMetadata = existing;
    const deadline = Date.now() + (options.waitForUrlMs ?? 5_000);

    while (!current.url && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const again = await readMetadata(path);

      if (again === null) continue acquire;

      if (again === 'corrupt' || again.ownerId !== current.ownerId)
        return {
          kind: 'unverifiable',
          path,
          metadata: again === 'corrupt' ? null : again,
          reason: 'The lock changed owners while waiting',
        };

      current = again;
    }

    if (!current.url)
      return {
        kind: 'unverifiable',
        path,
        metadata: current,
        reason: `Relate dev is already starting (PID ${current.pid}, ${current.configPath}) and has not published its URL yet`,
      };

    if (await options.verifyOwner(current))
      return { kind: 'held', metadata: current, path };

    return {
      kind: 'unverifiable',
      path,
      metadata: current,
      reason: `PID ${current.pid} is alive but ${current.url} did not identify itself as the lock owner`,
    };
  }

  return {
    kind: 'unverifiable',
    path,
    metadata: null,
    reason: 'Could not acquire the lock after repeated attempts',
  };
}
