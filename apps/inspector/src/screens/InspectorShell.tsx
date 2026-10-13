import type { ReactNode } from 'react';
import { NavRail } from '../NavRail.js';
import { StatusBar } from '../StatusBar.js';
import { useInspectorState } from '../inspector-context.js';
import { ThemeContext, useThemeState } from '../theme/theme.js';

/** Frame around every screen: rail and header, or the no-session card in their place. */
export function InspectorShell(props: { readonly children: ReactNode }) {
  const state = useInspectorState();
  const theme = useThemeState();

  return (
    <ThemeContext.Provider value={theme}>
      <div className="shell">
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
                This page only opens through the link printed by relate dev. The
                link carries an access token for that session. If relate dev
                restarted, the previous link stopped working. Use the new one.
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
          <>
            <NavRail />
            <div className="shell-main">
              <StatusBar />
              {props.children}
            </div>
          </>
        )}
      </div>
    </ThemeContext.Provider>
  );
}
