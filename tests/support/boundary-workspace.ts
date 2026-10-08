import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Minimal real pnpm workspace: the checker must discover it without fixtures-specific flags. */
export async function initializeBoundaryWorkspace(
  directory: string,
): Promise<void> {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'boundary-fixture', private: true }),
  );
  await writeFile(
    join(directory, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - apps/*\n  - examples/*\n  - connectors/*\n',
  );
  await mkdir(join(directory, 'dev/simulators'), { recursive: true });

  for (const owner of ['relate', 'protocol', 'runtime', 'postgres', 'node']) {
    await mkdir(join(directory, 'packages', owner, 'src'), { recursive: true });
    await writeFile(
      join(directory, 'packages', owner, 'package.json'),
      JSON.stringify({
        name: owner === 'relate' ? owner : `@relate/${owner}`,
        private: true,
      }),
    );
  }
}
