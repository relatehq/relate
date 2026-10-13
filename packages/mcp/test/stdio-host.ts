import { connectStdio, createDevelopmentExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

const cleanups: (() => Promise<void>)[] = [];
const { binding } = await createFixture((close) => cleanups.push(close));
const server = await connectStdio({
  executor: createDevelopmentExecutor(),
  bindGraph: () => binding,
});

process.stdin.on('end', () => {
  void server.close().then(() => Promise.all(cleanups.map((close) => close())));
});
