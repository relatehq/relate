/**
 * One status pill for the header: can the developer trust what the inspector
 * shows and use the graph right now. The connection outranks the runtime,
 * because a disconnected page only knows a stale runtime state.
 */
import type { ConnectionState } from './connection/store.js';
import type { RuntimeStatus } from './protocol.js';

export interface Health {
  readonly color: 'green' | 'orange' | 'gray' | 'red';
  readonly label: string;
}

export function healthOf(
  connection: ConnectionState,
  runtime: RuntimeStatus | null,
  compiledRevision: string | null,
): Health {
  if (connection === 'unauthorized')
    return { color: 'red', label: 'No session' };

  if (connection === 'connecting')
    return { color: 'orange', label: 'Connecting' };

  if (connection === 'reconnecting')
    return { color: 'orange', label: 'Reconnecting' };

  if (connection === 'stale') return { color: 'gray', label: 'Paused' };

  // Live, but no runtime reported yet (an older server, or before the first start).
  if (runtime === null) return { color: 'green', label: 'Live' };

  switch (runtime.state) {
    case 'failed':
      return { color: 'red', label: 'Runtime failed' };
    case 'starting':
      return { color: 'orange', label: 'Starting' };
    case 'restarting':
      return { color: 'orange', label: 'Restarting' };
    case 'not-configured':
      return { color: 'gray', label: 'No runtime' };
    case 'running':
      return runtime.definitionRevision !== null &&
        compiledRevision !== null &&
        runtime.definitionRevision !== compiledRevision
        ? { color: 'orange', label: 'Updating' }
        : { color: 'green', label: 'Live' };
  }
}
