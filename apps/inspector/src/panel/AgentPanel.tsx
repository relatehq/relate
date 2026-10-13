import { Link } from '@tanstack/react-router';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent } from 'react';
import { focusRequest } from '../connection/focus.js';
import { effectivePrincipal } from '../connection/store.js';
import {
  useActivity,
  useAgent,
  useAgentClient,
  useInspectorState,
} from '../inspector-context.js';
import { useChosenPrincipal } from '../principal.js';
import type {
  ActivityEvent,
  AgentMessage,
  AgentToolMessage,
  Manifest,
} from '../protocol.js';
import { Button, Tag } from '../ui.js';
import type { TagColor } from '../ui.js';

/** Whether the agent panel is open; remembered in this browser when possible. */
const openKey = 'relate.inspector.agent-open';
const openListeners = new Set<() => void>();
let open: boolean | null = null;

function readOpen(): boolean {
  if (open !== null) return open;

  try {
    open = globalThis.localStorage?.getItem(openKey) === 'true';
  } catch {
    open = false;
  }

  return open;
}

export function setAgentPanelOpen(next: boolean): void {
  open = next;

  try {
    globalThis.localStorage?.setItem(openKey, String(next));
  } catch {
    // A convenience only; the panel still opens for this page.
  }

  for (const listener of [...openListeners]) listener();
}

export function useAgentPanelOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      openListeners.add(listener);

      return () => openListeners.delete(listener);
    },
    readOpen,
    () => false,
  );
}

const toolColor: Record<AgentToolMessage['status'], TagColor> = {
  running: 'sky',
  succeeded: 'jade',
  failed: 'red',
  cancelled: 'gray',
};

/** Object and action labels by definition ID, for the objects a call touched. */
function labelsOf(manifest: Manifest | undefined): ReadonlyMap<string, string> {
  const entries: [string, string][] = [];

  for (const object of manifest?.objects ?? [])
    entries.push([object.id, object.label]);

  for (const action of manifest?.actions ?? [])
    entries.push([action.id, action.apiName]);

  return new Map(entries);
}

/** Definition IDs each activity request's operations touched, in first-touch order. */
function touchedByRequest(
  events: readonly ActivityEvent[],
): ReadonlyMap<string, readonly string[]> {
  const touched = new Map<string, string[]>();

  for (const event of events) {
    if (event.kind !== 'operation') continue;

    const list = touched.get(event.context.requestId) ?? [];

    if (!list.includes(event.definitionId)) list.push(event.definitionId);

    touched.set(event.context.requestId, list);
  }

  return touched;
}

function ToolCall(props: {
  readonly message: AgentToolMessage;
  readonly touched: readonly string[];
  readonly labels: ReadonlyMap<string, string>;
}) {
  const { message } = props;

  return (
    <div
      className={`agent-tool ${message.status}`}
      onMouseEnter={() => focusRequest(message.requestId)}
      onMouseLeave={() => focusRequest(null)}
    >
      <div className="agent-tool-header">
        <Tag color={toolColor[message.status]} weight="medium">
          {message.name}
        </Tag>
        <span className="agent-tool-status">{message.status}</span>
        <span className="activity-spacer" />
        <Link
          to="/activity"
          search={{ request: message.requestId }}
          className="agent-tool-link"
          title="Open this call in the Activity timeline"
        >
          Activity →
        </Link>
      </div>
      <pre className="agent-tool-input">{message.input}</pre>
      {props.touched.length > 0 && (
        <div className="agent-tool-touched">
          {props.touched.map((id) => (
            <Tag key={id} color="blue" variant="outline" title={id}>
              {props.labels.get(id) ?? id}
            </Tag>
          ))}
        </div>
      )}
      {message.result !== undefined && (
        <details className="agent-tool-result">
          <summary>result</summary>
          <code>{message.result}</code>
        </details>
      )}
    </div>
  );
}

/**
 * The model's light Markdown as React elements: fenced code, inline code and
 * bold. Never HTML; anything else stays plain text.
 */
export function ModelText(props: { readonly text: string }) {
  const inline = (text: string, key: string) =>
    text
      .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)
      .map((part, index) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={`${key}-${index}`}>{part.slice(1, -1)}</code>
        ) : part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={`${key}-${index}`}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      );

  return (
    <>
      {props.text.split(/```[^\n]*\n?/).map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="agent-tool-input">
            {part.replace(/\n$/, '')}
          </pre>
        ) : (
          inline(part, String(index))
        ),
      )}
    </>
  );
}

function Message(props: {
  readonly message: AgentMessage;
  readonly touched: ReadonlyMap<string, readonly string[]>;
  readonly labels: ReadonlyMap<string, string>;
}) {
  const { message } = props;

  switch (message.kind) {
    case 'user':
      return <div className="agent-user">{message.text}</div>;
    case 'assistant':
      return (
        <div className="agent-assistant">
          <ModelText text={message.text} />
        </div>
      );
    case 'thinking':
      return message.text.trim() === '' ? null : (
        <details className="agent-thinking">
          <summary>Thinking</summary>
          <ModelText text={message.text} />
        </details>
      );
    case 'notice':
      return (
        <div className={`agent-notice ${message.level}`}>{message.text}</div>
      );
    case 'tool':
      return (
        <ToolCall
          message={message}
          touched={props.touched.get(message.requestId) ?? []}
          labels={props.labels}
        />
      );
  }
}

/** Without a key the panel explains the setup; the rest of the inspector is unaffected. */
function Setup() {
  return (
    <div className="agent-setup">
      <div className="agent-setup-title">
        The agent needs an Anthropic API key
      </div>
      <p>
        The agent runs in relate dev, never in this page, and reads{' '}
        <code>ANTHROPIC_API_KEY</code> from the environment relate dev starts
        with. Add it to the project <code>.env</code>:
      </p>
      <pre>ANTHROPIC_API_KEY=sk-ant-…</pre>
      <p>and restart relate dev with the project&apos;s loader:</p>
      <pre>pnpm exec dotenvx run -f .env -- pnpm relate dev</pre>
      <p>
        The key stays in relate dev: your application code, the code the agent
        runs and this page never see it.
      </p>
    </div>
  );
}

/** Chat with the built-in agent as the principal selected in the header. */
export function AgentPanel() {
  const state = useInspectorState();
  const agent = useAgent();
  const client = useAgentClient();
  const activity = useActivity();
  const chosen = useChosenPrincipal(
    state.model?.manifest.graphDefinitionId ?? null,
  );
  const principal = effectivePrincipal(state.model, chosen);
  const conversation =
    principal === null ? undefined : agent.conversations.get(principal);
  const messages = conversation?.messages ?? [];
  const turn = conversation?.turn ?? null;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => labelsOf(state.model?.manifest), [state.model]);
  const touched = useMemo(
    () => touchedByRequest(activity.events),
    [activity.events],
  );
  const available = agent.availability?.available === true;
  const canSend =
    available && principal !== null && !turn && !sending && draft.trim() !== '';

  // Follow the conversation as it grows, and start at the bottom on a switch.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, principal]);

  useEffect(() => setError(null), [principal]);

  const send = async () => {
    if (!client || !canSend || principal === null) return;

    setSending(true);
    setError(null);

    const result = await client.send(principal, draft.trim());

    setSending(false);

    if (result.ok) setDraft('');
    else setError(result.error);
  };
  const reset = async () => {
    if (!client || principal === null || turn) return;

    setError(null);

    const result = await client.reset(principal);

    if (!result.ok) setError(result.error);
  };
  const cancel = async () => {
    if (!client || !turn) return;

    const result = await client.cancel(turn.turnId);

    if (!result.ok) setError(result.error);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <aside className="agent-panel" aria-label="Agent">
      <div className="side-panel-header">
        <div className="title-row">
          <span className="title">Agent</span>
          {principal !== null && <span className="meta">as {principal}</span>}
          {available && principal !== null && messages.length > 0 && (
            <Button
              ariaLabel="Start a new conversation"
              title={
                turn
                  ? 'Cancel the running turn first'
                  : `Clear the conversation as ${principal} and start afresh`
              }
              onClick={() => void reset()}
            >
              New conversation
            </Button>
          )}
          <span className="close">
            <Button
              ariaLabel="Close the agent panel"
              title="Close"
              onClick={() => setAgentPanelOpen(false)}
            >
              ×
            </Button>
          </span>
        </div>
        <span className="sub">
          {agent.availability?.available
            ? `${agent.availability.model} · one conversation per principal; reads and actions run as ${principal ?? 'the selected principal'}.`
            : 'Ask about the graph and watch the code it runs.'}
        </span>
      </div>
      {agent.availability?.available === false ? (
        <Setup />
      ) : (
        <>
          <div className="agent-messages" ref={list} aria-live="polite">
            {agent.connection === 'stopped' ? (
              <div className="agent-empty">
                Not connected: open the inspector link printed by relate dev.
              </div>
            ) : agent.availability === null ? (
              <div className="agent-empty">Connecting to relate dev…</div>
            ) : principal === null ? (
              <div className="agent-empty">
                Declare development principals in{' '}
                <code>defineGraph({'{ principals }'})</code> to talk to the
                agent as one of them.
              </div>
            ) : messages.length === 0 ? (
              <div className="agent-empty">
                Ask a question about the graph as <strong>{principal}</strong>.
                Every call it makes appears in Activity.
              </div>
            ) : (
              messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  touched={touched}
                  labels={labels}
                />
              ))
            )}
            {turn && (
              <div className="agent-working">
                {turn.status === 'cancelling' ? 'Cancelling…' : 'Working…'}
              </div>
            )}
          </div>
          <div className="agent-composer">
            {error && <div className="agent-error">{error}</div>}
            <textarea
              aria-label="Message the agent"
              placeholder={
                principal === null
                  ? 'No principal to act as'
                  : `Ask as ${principal}…`
              }
              value={draft}
              disabled={!available || principal === null}
              rows={3}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="agent-composer-actions">
              <span className="agent-hint">
                Enter to send · Shift+Enter for a new line
              </span>
              {turn ? (
                <Button variant="solid" onClick={() => void cancel()}>
                  {turn.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
                </Button>
              ) : (
                <Button variant="solid" onClick={() => void send()}>
                  Send
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
