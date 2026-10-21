/**
 * The playground: write SDK code against the graph as a development
 * principal, run it, and read the result as a table.
 *
 * The principal is the one chosen in the header, shared with the agent page.
 * Discovery for that principal drives the schema tree, completion and the
 * live checks; it is fetched again when the principal or the runtime changes.
 * A run goes to `relate dev`, which executes the code exactly as the MCP
 * `execute` tool does and records it in Activity.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { inspectorBaseUrl } from '../connection/client.js';
import { createPlaygroundClient } from '../connection/playground.js';
import { effectivePrincipal } from '../connection/store.js';
import { Icon } from '../icons.js';
import { useInspectorState } from '../inspector-context.js';
import { useChosenPrincipal } from '../principal.js';
import { PrincipalSelector } from '../PrincipalSelector.js';
import type { PlaygroundDiscovery } from '../protocol.js';
import { checkCode, runDiagnostics } from '../playground/checks.js';
import { Editor } from '../playground/Editor.js';
import type { EditorHandle, FieldType } from '../playground/Editor.js';
import { objectNames, objectOf } from '../playground/model.js';
import { Results, recordsOf } from '../playground/Results.js';
import type { RunState } from '../playground/Results.js';
import { SchemaTree } from '../playground/SchemaTree.js';
import { objectAt } from '../playground/source.js';
import { tabActions, useTabs } from '../playground/tabs.js';

/** Header controls of the playground page: the principal. */
export function PlaygroundHeaderControls() {
  const state = useInspectorState();

  return state.model ? <PrincipalSelector model={state.model} /> : null;
}

type DiscoveryState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly discovery: PlaygroundDiscovery }
  | { readonly state: 'unavailable'; readonly error: string };

export function PlaygroundScreen() {
  const state = useInspectorState();
  const graphId = state.model?.manifest.graphDefinitionId ?? null;
  const principal = effectivePrincipal(
    state.model,
    useChosenPrincipal(graphId),
  );
  const runtimeId =
    state.runtime?.state === 'running' ? state.runtime.runtimeId : null;

  if (!state.model || graphId === null)
    return (
      <div className="placeholder-screen">
        <div className="title">No model yet</div>
        <div className="hint">
          The playground opens once relate dev has compiled your graph.
        </div>
      </div>
    );

  if (principal === null)
    return (
      <div className="placeholder-screen">
        <div className="title">No development principals</div>
        <div className="hint">
          The playground runs code as a principal. Declare principals in{' '}
          <code>defineGraph({'{ principals }'})</code>.
        </div>
      </div>
    );

  return (
    <Playground
      key={graphId}
      graphId={graphId}
      principal={principal}
      runtimeId={runtimeId}
    />
  );
}

function Playground(props: {
  readonly graphId: string;
  readonly principal: string;
  readonly runtimeId: string | null;
}) {
  const client = useMemo(
    () =>
      createPlaygroundClient({
        baseUrl: inspectorBaseUrl(globalThis.location),
      }),
    [],
  );
  const [discovery, setDiscovery] = useState<DiscoveryState>({
    state: 'loading',
  });

  useEffect(() => {
    let current = true;

    setDiscovery({ state: 'loading' });

    void client.discovery(props.principal).then((answer) => {
      if (!current) return;

      setDiscovery(
        answer.ok
          ? { state: 'ready', discovery: answer.value }
          : { state: 'unavailable', error: answer.error },
      );
    });

    return () => {
      current = false;
    };
  }, [client, props.principal, props.runtimeId]);

  const ready = discovery.state === 'ready' ? discovery.discovery : null;
  const firstObject = ready ? (objectNames(ready)[0] ?? null) : null;
  const tabs = useTabs(props.graphId, firstObject);
  const actions = useMemo(
    () => tabActions(props.graphId, firstObject),
    [props.graphId, firstObject],
  );
  const tab = tabs.tabs.find((t) => t.id === tabs.active)!;
  const [cursor, setCursor] = useState(0);
  const [run, setRun] = useState<RunState>({ state: 'idle' });
  const [ranCode, setRanCode] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const editor = useRef<EditorHandle | null>(null);

  // A run belongs to the tab it ran in.
  useEffect(() => {
    abort.current?.abort();
    setRun({ state: 'idle' });
    setRanCode(null);
  }, [tab.id]);

  const done = run.state === 'done' ? run.run : null;
  const problems = useMemo(
    () => [
      ...checkCode(tab.code, ready),
      // Issues from the last run stay until the code changes.
      ...(done && ranCode === tab.code
        ? runDiagnostics(tab.code, done.errors)
        : []),
    ],
    [tab.code, ready, done, ranCode],
  );
  const fieldTypes = useMemo(() => {
    const records =
      done?.status === 'succeeded' ? recordsOf(done.result) : null;
    const computed = records?.[0]?.meta.computed ?? {};
    const types: Record<string, FieldType> = {};

    for (const [alias, type] of Object.entries(computed))
      if (typeof type?.type === 'string')
        types[alias] = {
          type: type.type,
          ...(type.nullable !== undefined ? { nullable: type.nullable } : {}),
        };

    return types;
  }, [done]);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  const focus = objectAt(tab.code, cursor);
  // Headers type the object the code read last.
  const resultObject = objectOf(ready, done?.reads.at(-1)?.object ?? null);

  const start = async () => {
    if (run.state === 'running') return;

    const controller = new AbortController();
    const code = tab.code;

    abort.current = controller;
    setRun({ state: 'running', principal: props.principal });

    const answer = await client.run(props.principal, code, controller.signal);

    if (controller.signal.aborted) {
      setRun({ state: 'idle' });

      return;
    }

    setRanCode(code);
    setRun(
      answer.ok
        ? { state: 'done', run: answer.value }
        : { state: 'refused', error: answer.error },
    );
  };

  return (
    <div className="pg-screen">
      <div className="pg-toolbar">
        <div className="pg-tabs" role="tablist" aria-label="Queries">
          {tabs.tabs.map((t) => (
            <div
              key={t.id}
              className={`pg-tab${t.id === tab.id ? ' active' : ''}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={t.id === tab.id}
                className="pg-tab-name"
                title="Double-click to rename"
                onClick={() => actions.select(t.id)}
                onDoubleClick={() => {
                  const name = globalThis.prompt?.('Rename tab', t.name);

                  if (name) actions.rename(t.id, name);
                }}
              >
                {t.name}
              </button>
              {tabs.tabs.length > 1 && (
                <button
                  type="button"
                  className="pg-tab-close"
                  aria-label={`Close ${t.name}`}
                  onClick={() => actions.close(t.id)}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="pg-tab-add"
            aria-label="New tab"
            onClick={() => actions.add()}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="button button-solid pg-run"
          disabled={run.state === 'running' || discovery.state !== 'ready'}
          onClick={() => void start()}
        >
          <Icon name="player-play" size={12} />
          Run
          <kbd>⌘↵</kbd>
        </button>
      </div>
      <div className="pg-workspace">
        <SchemaTree
          discovery={ready}
          loading={
            discovery.state === 'loading'
              ? 'Loading…'
              : discovery.state === 'unavailable'
                ? discovery.error
                : null
          }
          focus={focus}
          onInsert={(text) => editor.current?.insert(text)}
        />
        <div className="pg-main">
          <div className="pg-editor-pane">
            <Editor
              key={tab.id}
              code={tab.code}
              discovery={ready}
              problems={problems}
              fieldTypes={fieldTypes}
              onChange={(code) => actions.edit(tab.id, code)}
              onCursor={setCursor}
              onRun={() => void start()}
              handle={(handle) => {
                editor.current = handle;
              }}
            />
            <div
              className="pg-status"
              data-state={errors ? 'error' : warnings ? 'warning' : 'ok'}
            >
              <span className="pg-status-dot" />
              <span>
                {errors || warnings
                  ? [
                      errors && `${errors} error${errors > 1 ? 's' : ''}`,
                      warnings &&
                        `${warnings} warning${warnings > 1 ? 's' : ''}`,
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : 'No problems'}
              </span>
              <span className="pg-muted pg-status-note">
                {discovery.state === 'ready'
                  ? `Checked against ${props.principal}'s discovery. SQL is checked when it runs.`
                  : discovery.state === 'loading'
                    ? 'Loading discovery…'
                    : 'Discovery unavailable'}
              </span>
            </div>
          </div>
          <Results
            run={run}
            object={resultObject}
            onCancel={() => abort.current?.abort()}
          />
        </div>
      </div>
    </div>
  );
}
