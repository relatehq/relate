import { failureOrigin } from './connection/store.js';
import { Icon } from './icons.js';
import { useInspectorState } from './inspector-context.js';
import { useActivePage } from './NavRail.js';
import { useTheme } from './theme/theme.js';
import { IconButton, Status, Tag } from './ui.js';

/** The 44px header: brand, graph, page, generation, problems, connection and theme. */
export function StatusBar() {
  const state = useInspectorState();
  const { theme, toggle } = useTheme();
  const page = useActivePage();
  const themeLabel =
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const manifest = state.model?.manifest;
  const revision = state.model?.definitionRevision
    .replace(/^sha256:/, '')
    .slice(0, 7);
  const problems = state.failure?.diagnostics.length ?? 0;
  const origin = failureOrigin(state.failure);
  const typeErrors = state.typecheck?.diagnostics.length ?? 0;
  const status =
    state.connection === 'live'
      ? (['green', 'Live'] as const)
      : state.connection === 'reconnecting' || state.connection === 'connecting'
        ? ([
            'orange',
            state.connection === 'connecting' ? 'Connecting' : 'Reconnecting',
          ] as const)
        : state.connection === 'stale'
          ? (['gray', 'Paused'] as const)
          : (['red', 'No session'] as const);

  return (
    <header className="app-header">
      <span className="brand">Relate</span>
      {manifest && (
        <>
          <span className="divider">/</span>
          <span className="graph-id">{manifest.graphDefinitionId}</span>
        </>
      )}
      {page && (
        <>
          <span className="divider">/</span>
          <span className="page-label">{page.label}</span>
        </>
      )}
      <span className="spacer" />
      <span className="generation">
        {state.model
          ? `gen ${state.model.generation} · ${revision}`
          : 'no model yet'}
      </span>
      {state.failure && origin === 'loader' && (
        <Tag color="orange" weight="medium">
          Loader failed
        </Tag>
      )}
      {state.failure && origin === 'code' && (
        <Tag color="red" weight="medium">
          {problems} {problems === 1 ? 'problem' : 'problems'}
        </Tag>
      )}
      {typeErrors > 0 && (
        <Tag color="orange" weight="medium">
          {typeErrors} type {typeErrors === 1 ? 'error' : 'errors'}
        </Tag>
      )}
      {state.layout && (
        <Tag color="amber" weight="medium">
          Layout failed
        </Tag>
      )}
      <Status color={status[0]}>{status[1]}</Status>
      <span className="header-separator" aria-hidden="true" />
      <IconButton label={themeLabel} onClick={toggle}>
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      </IconButton>
    </header>
  );
}
