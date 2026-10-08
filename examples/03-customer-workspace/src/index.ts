import { spawn } from 'node:child_process';
import { startServer } from './server.js';
import { startInspector } from './inspector.js';
import { runWorkspace } from './launcher.js';

process.exitCode = await runWorkspace({
  inspector: startInspector(),
  startApplication: startServer,
  signals: process,
  reportError: (error) => console.error(error),
  forceExit: (code) => process.exit(code),
  onReady(application, reused) {
    console.log(
      `\nReady: ${application.url}\nState resets when you stop. Press Ctrl+C to close the app${reused ? '; the borrowed inspector stays running' : ' and inspector'}.\n`,
    );

    if (!process.argv.includes('--no-open')) {
      const command =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer.exe'
            : 'xdg-open';
      const browser = spawn(command, [application.url], { stdio: 'ignore' });

      browser.on('error', () =>
        console.log('Open the application URL above in your browser.'),
      );
      browser.unref();
    }
  },
});
