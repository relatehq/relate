import { spawn } from 'node:child_process';

/** Open a URL in the default browser once; failures are reported, never fatal. */
export function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];

  return new Promise((resolve, reject) => {
    let child;

    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true });
    } catch (error) {
      reject(error as Error);

      return;
    }

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
