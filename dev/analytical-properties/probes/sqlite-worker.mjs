import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const database = new DatabaseSync(workerData.path, { readOnly: true });

parentPort.on('message', ({ text, values }) => {
  try {
    const statement = database.prepare(text);

    statement.setReadBigInts(true);
    parentPort.postMessage({ rows: statement.all(...values) });
  } catch (error) {
    parentPort.postMessage({ error: String(error) });
  } finally {
    database.close();
    parentPort.close();
  }
});
parentPort.postMessage({ ready: true });
