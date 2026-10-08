import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { SalesforceCredentials } from '@relate/connector-salesforce';

const execute = promisify(execFile);

export type Cli = (args: string[]) => Promise<unknown>;

/** Capture all CLI output: never echo OAuth credentials or raw CLI errors. */
export const sf: Cli = async (args) => {
  try {
    const { stdout } = await execute('sf', [...args, '--json'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = JSON.parse(stdout) as { status: number; result: unknown };

    if (response.status !== 0) throw new Error();

    return response.result;
  } catch {
    throw new Error(
      `Salesforce CLI ${args.slice(0, 3).join(' ')} failed; inspect the org using sf org list.`,
    );
  }
};

const id = z.string().regex(/^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/);
const stateSchema = z.object({
  version: z.literal(1),
  username: z.string().regex(/^relate-[a-f0-9-]+@scratch\.example\.com$/),
  hubId: id,
  hubUsername: z.string(),
  jobId: z.string().optional(),
  orgId: id.optional(),
  accountIds: z.array(z.string().regex(/^001[A-Za-z0-9]{15}$/)),
});

type State = z.infer<typeof stateSchema>;

const sameId = (a: string, b: string) => a.slice(0, 15) === b.slice(0, 15);

export const statePath = resolve('.relate/salesforce.json');

/** One owned scratch org per state file. The state contains no tokens. */
export class ScratchOrg {
  constructor(
    readonly path = statePath,
    private readonly cli: Cli = sf,
  ) {}
  private async read(): Promise<State> {
    return stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
  }
  private async save(state: State) {
    // Atomic replacement preserves the previous recovery record if the process crashes.
    const temporary = `${this.path}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  private async inventory() {
    return z
      .object({
        nonScratchOrgs: z.array(
          z.object({
            orgId: id,
            username: z.string(),
            isDevHub: z.boolean().optional(),
            isDefaultDevHubUsername: z.boolean().optional(),
          }),
        ),
        scratchOrgs: z.array(
          z.object({
            orgId: id,
            username: z.string(),
            devHubUsername: z.string().optional(),
            isScratch: z.boolean().optional(),
          }),
        ),
      })
      .parse(await this.cli(['org', 'list', '--all']));
  }
  async create(signal: AbortSignal) {
    signal.throwIfAborted();
    const inventory = await this.inventory();
    const hub = inventory.nonScratchOrgs.find(
      (org) => org.isDefaultDevHubUsername && org.isDevHub,
    );

    if (!hub)
      throw new Error(
        'Authenticate a default Dev Hub first: sf org login web --alias relate-hub --set-default-dev-hub',
      );

    const state: State = {
      version: 1,
      username: `relate-${randomUUID()}@scratch.example.com`,
      hubId: hub.orgId,
      hubUsername: hub.username,
      accountIds: [],
    };

    await mkdir(dirname(this.path), { recursive: true });
    // Exclusive creation refuses to overwrite a previous run's recovery record.
    await writeFile(this.path, JSON.stringify(state, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });

    try {
      const result = z
        .object({ scratchOrgInfo: z.object({ Id: z.string() }) })
        .parse(
          await this.cli([
            'org',
            'create',
            'scratch',
            '--target-dev-hub',
            hub.username,
            '--edition',
            'developer',
            '--duration-days',
            '1',
            '--no-track-source',
            '--username',
            state.username,
            '--description',
            'Relate disposable connector fixture',
            '--async',
          ]),
        );

      state.jobId = result.scratchOrgInfo.Id;
      await this.save(state);
      await this.resume();
      signal.throwIfAborted();
      await this.reset();
      signal.throwIfAborted();
    } catch (error) {
      // Creation may have succeeded even if the CLI lost its response.
      // Retain ownership state and attempt recovery before deleting.
      try {
        await this.destroy();
      } catch {
        console.error(
          `Scratch cleanup incomplete. Run: pnpm salesforce:dev delete (state: ${this.path})`,
        );
      }

      throw error;
    }
  }
  /** The Dev Hub's signup record for our pre-recorded unique username, if one exists. */
  private async signup(state: State) {
    const query = `SELECT Id, Status FROM ScratchOrgInfo WHERE SignupUsername = '${state.username}'`;
    const result = z
      .object({
        records: z
          .array(
            z.object({
              Id: z.string().regex(/^2SR[A-Za-z0-9]{15}$/),
              Status: z.string(),
            }),
          )
          .max(1),
      })
      .parse(
        await this.cli([
          'data',
          'query',
          '--target-org',
          state.hubUsername,
          '--query',
          query,
        ]),
      );

    return result.records[0];
  }
  async resume() {
    const state = await this.read();

    if (state.orgId) return;

    if (!state.jobId) {
      // Recover an async create whose response was lost.
      const signup = await this.signup(state);

      if (!signup)
        throw new Error(
          'Creation outcome unknown; retain state and inspect the Dev Hub scratch org list',
        );

      state.jobId = signup.Id;
      await this.save(state);
    }

    if (state.jobId) {
      const result = z
        .object({ orgId: id, username: z.string() })
        .parse(
          await this.cli([
            'org',
            'resume',
            'scratch',
            '--job-id',
            state.jobId,
            '--wait',
            '10',
          ]),
        );

      if (
        result.username !== state.username ||
        sameId(result.orgId, state.hubId)
      )
        throw new Error('Scratch org ownership mismatch');

      state.orgId = result.orgId;
      await this.save(state);
    }
  }
  private async owned(): Promise<State & { orgId: string }> {
    const state = await this.read();
    const org = (await this.inventory()).scratchOrgs.find(
      (org) => org.username === state.username,
    );

    if (
      !state.orgId ||
      !org ||
      org.isScratch === false ||
      !sameId(org.orgId, state.orgId) ||
      sameId(org.orgId, state.hubId) ||
      org.devHubUsername !== state.hubUsername
    )
      throw new Error(
        'Refusing operation: target is not the recorded scratch org',
      );

    return { ...state, orgId: state.orgId };
  }
  async credentials(): Promise<SalesforceCredentials> {
    const state = await this.owned();
    const display = z
      .object({ id, instanceUrl: z.url() })
      .parse(
        await this.cli(['org', 'display', '--target-org', state.username]),
      );

    if (!sameId(display.id, state.orgId))
      throw new Error('Scratch org identity mismatch');

    const token = z
      .object({ accessToken: z.string().min(1) })
      .parse(
        await this.cli([
          'org',
          'auth',
          'show-access-token',
          '--target-org',
          state.username,
        ]),
      );

    return { instanceUrl: display.instanceUrl, accessToken: token.accessToken };
  }
  async info() {
    const state = await this.owned();

    return { orgId: state.orgId, accountIds: [...state.accountIds] };
  }
  async reset(signal?: AbortSignal) {
    const state = await this.owned();

    // Delete only IDs seeded by this harness, never broad Account queries.
    for (const recordId of [...state.accountIds]) {
      signal?.throwIfAborted();
      await this.cli([
        'data',
        'delete',
        'record',
        '--target-org',
        state.username,
        '--sobject',
        'Account',
        '--record-id',
        recordId,
      ]);
      state.accountIds = state.accountIds.filter((value) => value !== recordId);
      await this.save(state);
    }

    for (const name of ['Northwind', 'Contoso']) {
      signal?.throwIfAborted();
      const result = z
        .object({
          id: z.string().regex(/^001[A-Za-z0-9]{15}$/),
          success: z.literal(true),
        })
        .parse(
          await this.cli([
            'data',
            'create',
            'record',
            '--target-org',
            state.username,
            '--sobject',
            'Account',
            '--values',
            `Name='${name}' Website='https://example.com'`,
          ]),
        );

      state.accountIds.push(result.id);
      await this.save(state);
    }
  }
  async updateAccount(recordId: string, name: string) {
    const state = await this.owned();

    if (!state.accountIds.includes(recordId) || !/^[A-Za-z ]+$/.test(name))
      throw new Error('Invalid fixture update');

    await this.cli([
      'data',
      'update',
      'record',
      '--target-org',
      state.username,
      '--sobject',
      'Account',
      '--record-id',
      recordId,
      '--values',
      `Name='${name}'`,
    ]);
  }
  async deleteAccount(recordId: string) {
    const state = await this.owned();

    if (!state.accountIds.includes(recordId))
      throw new Error('Invalid fixture deletion');

    await this.cli([
      'data',
      'delete',
      'record',
      '--target-org',
      state.username,
      '--sobject',
      'Account',
      '--record-id',
      recordId,
    ]);
    state.accountIds = state.accountIds.filter((value) => value !== recordId);
    await this.save(state);
  }
  async destroy(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const signup = await this.signup(await this.read());

    // No signup, a failed signup, or an expired org leaves nothing to delete.
    if (!signup || signup.Status === 'Error' || signup.Status === 'Deleted') {
      await unlink(this.path);

      return;
    }

    await this.resume();
    signal?.throwIfAborted();
    const state = await this.owned();

    await this.cli([
      'org',
      'delete',
      'scratch',
      '--target-org',
      state.username,
      '--no-prompt',
    ]);
    await unlink(this.path);
  }
}

/** Turn SIGINT/SIGTERM into an abort signal for the duration of work. */
export async function withInterrupt<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const stop = () => abort.abort(new Error('Interrupted'));

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    return await work(abort.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Runner-owned org: register signals before provisioning and always delete afterwards. */
export async function withScratchOrg(
  work: (org: ScratchOrg, signal: AbortSignal) => Promise<void>,
  org = new ScratchOrg(),
) {
  await withInterrupt(async (signal) => {
    await org.create(signal);
    let failed = false;

    try {
      await work(org, signal);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await org.destroy();
      } catch {
        const cleanup = `Scratch cleanup failed. Run: pnpm salesforce:dev delete (state: ${org.path})`;

        // Report cleanup without hiding the failure that ended the work.
        if (failed) console.error(cleanup);
        else throw new Error(cleanup);
      }
    }
  });
}
