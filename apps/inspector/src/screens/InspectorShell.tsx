import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { StatusBar } from '../StatusBar.js';
import { useInspectorState } from '../inspector-context.js';

/** Frame around every screen: the header, plus the no-session card. */
export function InspectorShell(props: { readonly children: ReactNode }) {
  const state = useInspectorState();

  // Follow the system color scheme with the design system's class convention.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.classList.toggle('dark', media.matches);
      document.documentElement.classList.toggle('light', !media.matches);
    };

    apply();
    media.addEventListener('change', apply);

    return () => media.removeEventListener('change', apply);
  }, []);

  return (
    <div className="shell">
      <StatusBar />
      {state.connection === 'unauthorized' ? (
        <div className="session-screen">
          <div className="session-card" role="alert">
            <div className="eyebrow">
              <strong>Relate</strong>
              <span>inspector</span>
            </div>
            <div className="headline">
              Open the inspector from your terminal
            </div>
            <div className="body">
              This page only opens through the link printed by{' '}
              <code>relate dev</code>. The link carries an access token for that
              session. If relate dev restarted, the previous link stopped
              working. Use the new one.
            </div>
            <div className="terminal">
              {'  Inspector  '}
              <span className="url">http://127.0.0.1:4318/#token=…</span>
            </div>
            <div className="footnote">
              Visiting localhost alone does not grant access.
            </div>
          </div>
        </div>
      ) : (
        props.children
      )}
    </div>
  );
}
