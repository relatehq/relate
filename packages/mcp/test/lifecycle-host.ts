import { createDevelopmentExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

// Test-owned host, killed by the parent test while its execution is spinning.
const { binding } = await createFixture(() => {});
const operations = {
  ...binding.operations,
  async get(_definition: string, id: string) {
    process.send!(JSON.parse(id));

    return { status: 'not-found' as const };
  },
};

await createDevelopmentExecutor({ timeoutMs: 60_000 }).execute({
  graph: { ...binding, operations },
  code: `
    await graph.objects.Note.get(JSON.stringify({pid: process.pid, cwd: process.cwd()}));
    while (true) {}
  `,
});
