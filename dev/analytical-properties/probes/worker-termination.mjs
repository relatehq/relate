// Run only under benchmark.ts, which kills this entire process after the probe.
import { Worker } from 'node:worker_threads';

const worker = new Worker(new URL('./sqlite-worker.mjs', import.meta.url), {
  workerData: { path: process.argv[2] },
});

worker.on('message', (message) => {
  if (!message.ready) return;

  worker.postMessage({
    text: 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT SUM(x) FROM n',
    values: [],
  });
  setTimeout(async () => {
    process.send({ terminating: true });
    await worker.terminate();
    process.send({ terminated: true });
    process.disconnect();
  }, 50);
});
