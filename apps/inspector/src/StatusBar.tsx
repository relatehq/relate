import { useState } from 'react';
import { failureOrigin } from './connection/store.js';
import type { ConnectionState } from './connection/store.js';
import { healthOf } from './health.js';
import type { ModelSnapshot, RuntimeStatus } from './protocol.js';
import { Icon } from './icons.js';
import { useInspectorState } from './inspector-context.js';
import { AgentHeaderControls } from './screens/AgentScreen.js';
import { useActivePage } from './NavRail.js';
import { useTheme } from './theme/theme.js';
import { IconButton } from './ui/button.js';
import { Status } from './ui/status.js';
import { Tag } from './ui/tag.js';

const shortRevision = (revision: string) =>
  revision.replace(/^sha256:/, '').slice(0, 7);

const connectionText: Record<ConnectionState, string> = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting: the stream dropped and is retrying',
  unauthorized: 'no session: open the link relate dev printed',
  stale: 'paused: this page stopped following relate dev',
};

const runtimeText: Record<RuntimeStatus['state'], string> = {
  starting: 'starting',
  restarting: 'restarting',
  running: 'running',
  'not-configured':
    'not configured: export defineApp(...) to run the graph; the agent and MCP need it',
  failed: 'failed',
};

/**
 * Connection and runtime as one pill, worst state first; the hover card
 * shows both. A runtime restart that discarded in-memory data marks the pill
 * until the card has been seen.
 */
function HealthIndicator(props: {
  readonly connection: ConnectionState;
  readonly runtime: RuntimeStatus | null;
  readonly model: ModelSnapshot | null;
}) {
  const { runtime, model } = props;
  const health = healthOf(
    props.connection,
    runtime,
    model?.definitionRevision ?? null,
  );
  const [seenReset, setSeenReset] = useState<string | null>(null);
  const reset =
    runtime !== null && runtime.dataReset && runtime.state === 'running';
  const unseenReset = reset && seenReset !== runtime.runtimeId;
  const active = runtime?.definitionRevision ?? null;
  const behind =
    runtime?.state === 'running' &&
    active !== null &&
    model !== null &&
    active !== model.definitionRevision;
  const store =
    runtime?.store === 'memory'
      ? 'in-memory store'
      : runtime?.store === 'application'
        ? "the application's store"
        : null;

  return (
    <span
      className="health"
      tabIndex={0}
      aria-label={`Status: ${health.label}`}
      onMouseEnter={() => reset && setSeenReset(runtime.runtimeId)}
      onFocus={() => reset && setSeenReset(runtime.runtimeId)}
    >
      <Status color={health.color}>{health.label}</Status>
      {unseenReset && <span className="health-dot" aria-hidden="true" />}
      <span className="health-card" role="tooltip">
        <span className="health-key">Model</span>
        <span className="health-value">
          {model
            ? `gen ${model.generation} · revision ${shortRevision(model.definitionRevision)}`
            : 'no model yet'}
        </span>
        <span className="health-key">Connection</span>
        <span className="health-value">{connectionText[props.connection]}</span>
        <span className="health-key">Runtime</span>
        <span className="health-value">
          {runtime === null ? (
            'not reported'
          ) : (
            <>
              {[
                runtimeText[runtime.state],
                active && shortRevision(active),
                store,
              ]
                .filter(Boolean)
                .join(' · ')}
              <span className="health-detail">
                {runtime.runtimeId.slice(0, 8)} for gen {runtime.generation}
              </span>
              {behind && (
                <span className="health-detail warning">
                  Serves {shortRevision(active)}; the displayed model is{' '}
                  {shortRevision(model.definitionRevision)}
                </span>
              )}
              {reset && (
                <span className="health-detail warning">
                  The last restart discarded the previous runtime&apos;s
                  in-memory data
                </span>
              )}
              {runtime.diagnostics.map((d, index) => (
                <span key={index} className="health-detail error">
                  {d.code}: {d.message}
                </span>
              ))}
            </>
          )}
        </span>
      </span>
    </span>
  );
}

/** The 44px header: brand, graph, page, problems, page controls, status and theme. */
export function StatusBar() {
  const state = useInspectorState();
  const { theme, toggle } = useTheme();
  const page = useActivePage();
  const themeLabel =
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const manifest = state.model?.manifest;
  const problems = state.failure?.diagnostics.length ?? 0;
  const origin = failureOrigin(state.failure);
  const typeErrors = state.typecheck?.diagnostics.length ?? 0;

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
      {page?.path === '/agent' && <AgentHeaderControls />}
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
      <HealthIndicator
        connection={state.connection}
        runtime={state.runtime}
        model={state.model}
      />
      <span className="header-separator" aria-hidden="true" />
      <IconButton label={themeLabel} onClick={toggle}>
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      </IconButton>
    </header>
  );
}
