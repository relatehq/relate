import { workerData } from 'node:worker_threads';

// The main thread can be blocked inside DatabaseSync; a JS timer there cannot stop it.
const { parent, lifetimeMs } = workerData as {
  parent: number;
  lifetimeMs: number;
};
const stop = () => process.kill(process.pid, 'SIGKILL');

setTimeout(stop, lifetimeMs);
setInterval(() => {
  if (process.ppid !== parent) stop();

  try {
    process.kill(parent, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') stop();
  }
}, 100);
