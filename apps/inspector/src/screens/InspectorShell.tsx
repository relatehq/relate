import type { ReactNode } from 'react';
import { StatusBar } from '../StatusBar.js';
import { useInspectorState } from '../inspector-context.js';

/** Frame around every screen: status, stale/upgrade banners and access help. */
export function InspectorShell(props: { readonly children: ReactNode }) {
  const state = useInspectorState();
  const reload = () => window.location.reload();

  return (
    <div className="shell">
      <StatusBar />
      {state.connection === 'stale' && state.staleReason === 'protocol' && (
        <div className="banner banner-upgrade" role="alert">
          <strong>Inspector updated — reload to continue.</strong>{' '}
          <span>
            The running server speaks protocol {state.unsupportedProtocol}; this
            page stopped applying events and shows its last graph.
          </span>
          <button type="button" onClick={reload}>
            Reload
          </button>
        </div>
      )}
      {state.connection === 'stale' && state.staleReason === 'session' && (
        <div className="banner banner-upgrade" role="alert">
          <strong>Session ended.</strong>{' '}
          <span>
            The dev server restarted. Open the new link printed in the terminal
            to reconnect; this graph is kept as a stale copy.
          </span>
        </div>
      )}
      {state.connection === 'unauthorized' ? (
        <div className="notice" role="alert">
          <h2>Open the inspector from the terminal</h2>
          <p>
            This page has no development session. Run <code>relate dev</code>{' '}
            and open the Inspector link it prints; the link carries a one-time
            token that becomes a local session cookie.
          </p>
        </div>
      ) : (
        props.children
      )}
    </div>
  );
}
