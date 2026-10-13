/** Keep OS essentials, not application credentials or Node injection flags. */
export function childEnvironment(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed =
    platform === 'win32'
      ? ['systemroot', 'windir', 'path', 'pathext']
      : ['path'];
  const selected = new Map<string, [string, string]>();

  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      allowed.includes(
        platform === 'win32'
          ? name.toLowerCase()
          : name === 'PATH'
            ? 'path'
            : '',
      )
    )
      selected.set(name.toLowerCase(), [name, value]);
  }

  return {
    ...Object.fromEntries(selected.values()),
    // Standard temporary-file APIs use the execution's disposable directory.
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
  };
}

/** Ordinary descendant cleanup; deliberately not adversarial containment. */
export function killExecution(pid: number): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== 'ESRCH')
          throw fallback;
      }
    }
  }
}
