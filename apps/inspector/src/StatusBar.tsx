import { effectivePrincipal, failureOrigin } from './connection/store.js';
import type { ModelSnapshot, RuntimeStatus } from './protocol.js';
import { choosePrincipal, useChosenPrincipal } from './principal.js';
import { Icon } from './icons.js';
import { useAgent, useInspectorState } from './inspector-context.js';
import { setAgentPanelOpen, useAgentPanelOpen } from './panel/AgentPanel.js';
import { useActivePage } from './NavRail.js';
import { useTheme } from './theme/theme.js';
import { IconButton, Status, Tag } from './ui.js';

const shortRevision = (revision: string) =>
  revision.replace(/^sha256:/, '').slice(0, 7);

/** Choose which declared development principal the inspector acts as. */
function PrincipalSelector(props: { readonly model: ModelSnapshot }) {
  const graphId = props.model.manifest.graphDefinitionId;
  const chosen = useChosenPrincipal(graphId);
  const active = effectivePrincipal(props.model, chosen);

  if (active === null)
    return (
      <span
        className="principal-none"
        title="Declare principals in defineGraph({ principals }) to act as a development identity"
      >
        no principals
      </span>
    );

  return (
    <label className="principal-select">
      <span className="principal-label">as</span>
      <select
        aria-label="Development principal"
        value={active}
        onChange={(event) => choosePrincipal(graphId, event.target.value)}
      >
        {props.model.principals.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Running, starting, restarting, not configured or failed; says when a restart reset in-memory data. */
function RuntimeIndicator(props: {
  readonly runtime: RuntimeStatus;
  readonly compiledRevision: string | null;
}) {
  const { runtime } = props;
  const active = runtime.definitionRevision;
  const behind =
    runtime.state === 'running' &&
    active !== null &&
    props.compiledRevision !== null &&
    active !== props.compiledRevision;
  const detail = [
    `Runtime ${runtime.runtimeId.slice(0, 8)} for gen ${runtime.generation}`,
    active ? `active revision ${shortRevision(active)}` : 'no active revision',
    runtime.store === 'memory'
      ? 'in-memory store: data is lost on every restart'
      : runtime.store === 'application'
        ? "the application's own store"
        : null,
    ...runtime.diagnostics.map((d) => `${d.code}: ${d.message}`),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return (
    <>
      {runtime.state === 'running' && (
        <Tag color="jade" weight="medium" title={detail}>
          Runtime running
        </Tag>
      )}
      {(runtime.state === 'starting' || runtime.state === 'restarting') && (
        <Tag color="orange" weight="medium" title={detail}>
          {runtime.state === 'starting'
            ? 'Runtime starting'
            : 'Runtime restarting'}
        </Tag>
      )}
      {runtime.state === 'failed' && (
        <Tag color="red" weight="medium" title={detail}>
          Runtime failed
        </Tag>
      )}
      {runtime.state === 'not-configured' && (
        <Tag color="gray" title={detail}>
          No runtime
        </Tag>
      )}
      {behind && (
        <Tag color="amber" weight="medium" title={detail}>
          Runtime on {shortRevision(active)}
        </Tag>
      )}
      {runtime.dataReset && runtime.state === 'running' && (
        <Tag
          color="gray"
          title="The runtime restarted; in-memory data from the previous runtime was discarded"
        >
          Data reset
        </Tag>
      )}
    </>
  );
}

/** Opens the agent panel; marks a running turn so it is visible with the panel closed. */
function AgentToggle() {
  const open = useAgentPanelOpen();
  const agent = useAgent();
  const running = [...agent.conversations.values()].some(
    (conversation) => conversation.turn !== null,
  );
  const label = open ? 'Close the agent' : 'Open the agent';

  return (
    <button
      type="button"
      className={`icon-button icon-button-sm agent-toggle${open ? ' active' : ''}${
        running ? ' running' : ''
      }`}
      aria-label={label}
      aria-pressed={open}
      data-tooltip={running ? `${label} (working)` : label}
      data-tooltip-place="bottom"
      onClick={() => setAgentPanelOpen(!open)}
    >
      <Icon name="message" />
    </button>
  );
}

/** The 44px header: brand, graph, page, generation, problems, runtime, principal, connection and theme. */
export function StatusBar() {
  const state = useInspectorState();
  const { theme, toggle } = useTheme();
  const page = useActivePage();
  const themeLabel =
    theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const manifest = state.model?.manifest;
  const revision = state.model
    ? shortRevision(state.model.definitionRevision)
    : undefined;
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
      {state.runtime && (
        <RuntimeIndicator
          runtime={state.runtime}
          compiledRevision={state.model?.definitionRevision ?? null}
        />
      )}
      {state.model && <PrincipalSelector model={state.model} />}
      <Status color={status[0]}>{status[1]}</Status>
      <span className="header-separator" aria-hidden="true" />
      <AgentToggle />
      <IconButton label={themeLabel} onClick={toggle}>
        <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
      </IconButton>
    </header>
  );
}
