import { parentPort, workerData } from 'node:worker_threads';
import { killExecution } from './process-lifecycle.js';

// A separate event loop still runs when user JS monopolizes the main thread.
// The expected host PID comes from fork's argv, not a possibly reparented ppid.
const hostPid = workerData as number;

if (!Number.isSafeInteger(hostPid) || hostPid <= 0) killExecution(process.pid);

function checkHost() {
  if (process.ppid !== hostPid) {
    killExecution(process.pid);

    return;
  }

  try {
    process.kill(hostPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH')
      killExecution(process.pid);
  }
}

checkHost();
setInterval(checkHost, 100);
parentPort!.postMessage('ready');
