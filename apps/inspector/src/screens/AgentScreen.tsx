import { Link } from '@tanstack/react-router';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { groupActivity } from '../connection/activity.js';
import type { RequestActivity } from '../connection/activity.js';
import { inspectorBaseUrl } from '../connection/client.js';
import { effectivePrincipal } from '../connection/store.js';
import { Icon } from '../icons.js';
import type { IconName } from '../icons.js';
import {
  useActivity,
  useAgent,
  useAgentClient,
  useInspectorState,
} from '../inspector-context.js';
import { choosePrincipal, useChosenPrincipal } from '../principal.js';
import type {
  AgentMessage,
  AgentToolMessage,
  Manifest,
  ModelSnapshot,
  OperationEvent,
} from '../protocol.js';
import { Button } from '../ui/button.js';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Tag } from '../ui/tag.js';

/** Whether the conversation shows as a trace; remembered in this browser when possible. */
const traceKey = 'relate.inspector.agent-trace';
const traceListeners = new Set<() => void>();
let trace: boolean | null = null;

function readTrace(): boolean {
  if (trace !== null) return trace;

  try {
    trace = globalThis.localStorage?.getItem(traceKey) === 'true';
  } catch {
    trace = false;
  }

  return trace;
}

export function setAgentTrace(next: boolean): void {
  trace = next;

  try {
    globalThis.localStorage?.setItem(traceKey, String(next));
  } catch {
    // A convenience only; the view still switches for this page.
  }

  for (const listener of [...traceListeners]) listener();
}

export function useAgentTrace(): boolean {
  return useSyncExternalStore(
    (listener) => {
      traceListeners.add(listener);

      return () => traceListeners.delete(listener);
    },
    readTrace,
    () => false,
  );
}

/** The conversation of the principal selected in the header. */
function useConversation() {
  const state = useInspectorState();
  const agent = useAgent();
  const client = useAgentClient();
  const chosen = useChosenPrincipal(
    state.model?.manifest.graphDefinitionId ?? null,
  );
  const principal = effectivePrincipal(state.model, chosen);
  const conversation =
    principal === null ? undefined : agent.conversations.get(principal);

  return {
    state,
    agent,
    client,
    principal,
    messages: conversation?.messages ?? [],
    turn: conversation?.turn ?? null,
  };
}

/** The tools `/mcp` exposes, as an external client sees them. */
const mcpTools = [
  {
    name: 'discover()',
    description:
      'Returns the graph metadata this principal may see, with JavaScript usage instructions.',
  },
  {
    name: 'execute(code)',
    description:
      'Runs an async JavaScript function body with graph injected, as this principal. Actions may change data.',
  },
] as const;

const mcpUrl = () => new URL('mcp', inspectorBaseUrl(globalThis.location)).href;

/** The MCP tool list, opened from the header. */
function ToolsMenu() {
  return (
    <Popover>
      <PopoverTrigger render={<Button />}>
        <Icon name="tool" />
        {mcpTools.length} MCP tools
        <Icon name="chevron-down" size={12} />
      </PopoverTrigger>
      <PopoverContent className="agent-tools">
        <div className="agent-tools-head">
          <PopoverTitle>Exposed by the graph MCP</PopoverTitle>
          <PopoverDescription>{mcpUrl()}</PopoverDescription>
        </div>
        <div className="agent-tools-list">
          {mcpTools.map((tool) => (
            <div key={tool.name} className="agent-tools-item">
              <span className="name">{tool.name}</span>
              <span className="description">{tool.description}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Choose which declared development principal the agent acts as. */
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
    <span className="principal-select">
      <span className="principal-label">as</span>
      <Select
        value={active}
        onValueChange={(name) => {
          if (name !== null) choosePrincipal(graphId, name);
        }}
      >
        <SelectTrigger aria-label="Development principal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.model.principals.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

/** Header controls of the agent page: trace view, MCP tools, a new conversation and the principal. */
export function AgentHeaderControls() {
  const { state, agent, client, principal, messages, turn } = useConversation();
  const traceOn = useAgentTrace();
  const available = agent.availability?.available === true;
  const reset = async () => {
    if (!client || principal === null || turn) return;

    await client.reset(principal);
  };

  return (
    <>
      {available && (
        <Button
          active={traceOn}
          aria-pressed={traceOn}
          title={
            traceOn
              ? 'Back to the conversation'
              : 'Show every call with its time, latency and code'
          }
          onClick={() => setAgentTrace(!traceOn)}
        >
          <Icon name="timeline" />
          Trace
        </Button>
      )}
      <ToolsMenu />
      {available && principal !== null && messages.length > 0 && (
        <Button
          disabled={turn !== null}
          title={
            turn
              ? 'Cancel the running turn first'
              : `Clear the conversation as ${principal} and start afresh`
          }
          onClick={() => void reset()}
        >
          <Icon name="plus" />
          New conversation
        </Button>
      )}
      {agent.availability?.available === false && (
        <Tag color="orange" weight="medium">
          No API key
        </Tag>
      )}
      {state.model && <PrincipalSelector model={state.model} />}
    </>
  );
}

/** Object and action labels by definition ID, for the objects a call touched. */
function labelsOf(manifest: Manifest | undefined): ReadonlyMap<string, string> {
  const entries: [string, string][] = [];

  for (const object of manifest?.objects ?? [])
    entries.push([object.id, object.label]);

  for (const action of manifest?.actions ?? [])
    entries.push([action.id, action.apiName]);

  return new Map(entries);
}

const isAction = (op: OperationEvent) =>
  op.op === 'invoke' || op.op === 'getReceipt';

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** `10:42:03`, in the browser's time zone. */
const clock = (at: string | undefined) => {
  if (at === undefined) return '';

  const date = new Date(at);

  return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8);
};

/** What a call did, as display strings; everything comes from its activity request. */
function describeCall(
  message: AgentToolMessage,
  request: RequestActivity | undefined,
) {
  const execute = message.name === 'execute';
  const lines = message.input.split('\n').length;
  const operations = request?.operations ?? [];
  const actions = operations.filter(isAction).length;
  const records = operations
    .filter((op) => !isAction(op))
    .reduce(
      (sum, op) => sum + (op.outcome?.records ?? (op.outcome?.found ? 1 : 0)),
      0,
    );
  const reads = operations.length - actions;
  const errorCode =
    request?.execution?.error?.code ??
    request?.execution?.error?.name ??
    request?.call?.error ??
    operations.find((op) => op.outcome?.error)?.outcome?.error?.code;
  const errorMessage =
    request?.execution?.error?.message ??
    operations.find((op) => op.outcome?.error)?.outcome?.error?.message;
  const subject = execute
    ? `${plural(lines, 'line')} of JavaScript`
    : 'the graph';

  const verb =
    message.status === 'running'
      ? execute
        ? `Running ${subject}…`
        : 'Discovering the graph…'
      : message.status === 'failed'
        ? `${execute ? 'JavaScript' : 'Discover'} failed${errorCode ? ` · ${errorCode}` : ''}`
        : message.status === 'cancelled'
          ? `Cancelled · ${message.name}`
          : execute
            ? `Ran ${subject}${actions > 0 ? ` · ${plural(actions, 'action')}` : ''}`
            : 'Discovered the graph';
  const outcome =
    message.status === 'failed'
      ? `threw ${errorCode ?? 'an error'}`
      : operations.length === 0
        ? execute
          ? 'no graph calls'
          : 'graph metadata'
        : [
            reads > 0 ? plural(records, 'record') : null,
            actions > 0 ? plural(actions, 'action') : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ');

  const icon: IconName =
    message.status === 'failed' ? 'alert' : execute ? 'code' : 'sitemap';

  return {
    verb,
    icon,
    hint: execute ? `${plural(lines, 'line')} · JS` : '',
    outcome,
    principal: request?.call?.principal ?? null,
    at: request?.call?.at,
    ms: request?.call?.ms ?? request?.execution?.ms,
    error:
      message.status === 'failed'
        ? {
            code: errorCode ?? 'error',
            message: errorMessage ?? message.result,
          }
        : null,
  };
}

/** Definition IDs a request's operations touched, in first-touch order, with whether each is an action. */
function touchedBy(request: RequestActivity | undefined) {
  const touched = new Map<string, boolean>();

  for (const op of request?.operations ?? [])
    if (!touched.has(op.definitionId))
      touched.set(op.definitionId, isAction(op));

  return [...touched];
}

/** A light JavaScript/JSON tokenizer: enough colour to read code at a glance. */
const keyword =
  /^(const|let|var|await|return|async|new|throw|true|false|null|undefined|for|of|if|else|function)$/;

function tokens(line: string): { text: string; kind: string }[] {
  const pattern =
    /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`]+)/g;
  const out: { text: string; kind: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line))) {
    const rest = line.slice(pattern.lastIndex);
    let kind = 'p';

    if (match[1]) kind = 'com';
    else if (match[2]) kind = /^\s*:/.test(rest) ? 'key' : 'str';
    else if (match[3]) kind = 'num';
    else if (match[4])
      kind = keyword.test(match[4])
        ? 'kw'
        : /^\s*:/.test(rest)
          ? 'key'
          : /^\s*\(/.test(rest)
            ? 'fn'
            : 'id';
    else if (match[5]) kind = '';

    const last = out.at(-1);

    if (last && (kind === '' || last.kind === kind)) last.text += match[0];
    else out.push({ text: match[0], kind: kind || 'p' });
  }

  return out;
}

function Code(props: { readonly source: string; readonly numbered?: boolean }) {
  return (
    <div className={`agent-code${props.numbered ? ' numbered' : ''}`}>
      {props.source.split('\n').map((line, index) => (
        <div key={index} className="agent-code-line">
          {props.numbered && <span className="n">{index + 1}</span>}
          <span className="src">
            {tokens(line).map((token, at) => (
              <span key={at} className={`tok-${token.kind}`}>
                {token.text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Results are bounded previews: pretty-print the ones that are whole JSON. */
const pretty = (result: string) => {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
};

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
      {props.text
        .split(/```[^\n]*\n?/)
        .map((part, index) =>
          index % 2 === 1 ? (
            <Code key={index} source={part.replace(/\n$/, '')} />
          ) : (
            inline(part, String(index))
          ),
        )}
    </>
  );
}

/** Revealed only in the trace view: grows from nothing as the view switches. */
function TraceOnly(props: { readonly children: ReactNode }) {
  return (
    <div className="agent-reveal">
      <div>{props.children}</div>
    </div>
  );
}

type Tone =
  'user' | 'agent' | 'ok' | 'failed' | 'running' | 'muted' | 'warning';

/** One timeline row: time and marker (trace view only), then the content. */
function Row(props: {
  readonly kind: 'user' | 'agent' | 'call' | 'note';
  readonly time: string;
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return (
    <div className={`agent-row ${props.kind}`}>
      <span className="agent-row-time">{props.time}</span>
      <span className="agent-row-rail" aria-hidden="true">
        <span className={`agent-row-marker ${props.tone}`} />
      </span>
      <div className="agent-row-body">{props.children}</div>
    </div>
  );
}

const callTone: Record<AgentToolMessage['status'], Tone> = {
  running: 'running',
  succeeded: 'ok',
  failed: 'failed',
  cancelled: 'muted',
};

function ToolCall(props: {
  readonly message: AgentToolMessage;
  readonly request: RequestActivity | undefined;
  readonly labels: ReadonlyMap<string, string>;
  readonly maxMs: number;
  readonly open: boolean;
  readonly traceOn: boolean;
  readonly onToggle: () => void;
}) {
  const { message } = props;
  const call = describeCall(message, props.request);
  const touched = touchedBy(props.request);
  const execute = message.name === 'execute';
  const width =
    call.ms === undefined
      ? 0
      : Math.max(4, Math.round((call.ms / props.maxMs) * 100));

  return (
    <Row kind="call" time={clock(call.at)} tone={callTone[message.status]}>
      <div
        className={`agent-call ${message.status}${props.open ? ' open' : ''}`}
      >
        <button
          type="button"
          className="agent-call-head"
          aria-expanded={props.traceOn && props.open}
          onClick={props.onToggle}
        >
          <span className="agent-call-text">
            <span className="agent-call-verb">
              <span className="agent-call-icon">
                <Icon name={call.icon} size={13} />
              </span>
              {call.verb}
            </span>
            <TraceOnly>
              <span className="agent-call-meta">
                <span className="tool">{message.name}</span>
                {call.hint && ` ${call.hint}`} ← {call.outcome}
                {call.principal && ` · as ${call.principal}`}
              </span>
            </TraceOnly>
          </span>
          <span className="agent-call-bar">
            <span style={{ width: `${width}%` }} />
          </span>
          <span className="agent-call-ms">
            {call.ms === undefined ? '…' : `${Math.round(call.ms)} ms`}
          </span>
        </button>
        <div className="agent-call-detail">
          <div>
            <div className="agent-call-detail-body">
              {call.error && (
                <div className="agent-call-error">
                  <span className="code">{call.error.code}</span>
                  {call.error.message && <span>{call.error.message}</span>}
                </div>
              )}
              <div className="agent-call-io">
                <div className="agent-call-block">
                  <span className="label">
                    {execute ? 'Code · JavaScript' : 'Arguments'}
                  </span>
                  <Code source={message.input} numbered />
                </div>
                <div className="agent-call-block">
                  <span className="label">Result</span>
                  {message.result === undefined ? (
                    <div className="agent-code empty">—</div>
                  ) : (
                    <Code source={pretty(message.result)} />
                  )}
                </div>
              </div>
              <div className="agent-call-touched">
                {touched.length > 0 && <span className="label">Touched</span>}
                {touched.map(([id, action]) => (
                  <Tag key={id} color={action ? 'purple' : 'blue'} title={id}>
                    {props.labels.get(id) ?? id}
                  </Tag>
                ))}
                <span className="activity-spacer" />
                <Link
                  to="/activity"
                  search={{ request: message.requestId }}
                  className="agent-call-link"
                  title="Open this call in the Activity timeline"
                >
                  Activity →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Row>
  );
}

function Message(props: {
  readonly message: Exclude<AgentMessage, AgentToolMessage>;
}) {
  const { message } = props;

  switch (message.kind) {
    case 'user':
      return (
        <Row kind="user" time={clock(message.at)} tone="user">
          <div className="agent-user">
            <span className="agent-user-spacer" />
            <div className="agent-user-bubble">
              <TraceOnly>
                <span className="agent-who">You</span>
              </TraceOnly>
              <span className="agent-user-text">{message.text}</span>
            </div>
          </div>
        </Row>
      );
    case 'assistant':
      return (
        <Row kind="agent" time="" tone="agent">
          <div className="agent-assistant">
            <TraceOnly>
              <span className="agent-who">Agent</span>
            </TraceOnly>
            <div className="agent-assistant-text">
              <ModelText text={message.text} />
            </div>
          </div>
        </Row>
      );
    case 'thinking':
      return message.text.trim() === '' ? null : (
        <Row kind="note" time="" tone="muted">
          <details className="agent-thinking">
            <summary>
              <Icon name="chevron-right" size={12} />
              Thinking
            </summary>
            <div className="agent-thinking-text">
              <ModelText text={message.text} />
            </div>
          </details>
        </Row>
      );
    case 'notice':
      return (
        <Row
          kind="note"
          time=""
          tone={
            message.level === 'error'
              ? 'failed'
              : message.level === 'warning'
                ? 'warning'
                : 'muted'
          }
        >
          <div className={`agent-notice ${message.level}`}>{message.text}</div>
        </Row>
      );
  }
}

/** Without a key the page explains the setup; the MCP endpoint works regardless. */
function Setup() {
  const checks = [
    { ok: true, label: 'MCP server', detail: mcpUrl() },
    {
      ok: true,
      label: 'Tools',
      detail: mcpTools.map((tool) => tool.name.split('(')[0]).join(', '),
    },
    {
      ok: false,
      label: 'ANTHROPIC_API_KEY',
      detail: 'Not set in the environment relate dev started with.',
    },
  ];

  return (
    <div className="agent-setup">
      <div className="agent-setup-card">
        <div className="agent-setup-intro">
          <div className="title">The agent needs an Anthropic API key</div>
          <div className="body">
            The agent runs inside relate dev, never in this page, and calls
            Claude with a key from the project environment. The MCP server is
            running, so the graph is ready once a key is set.
          </div>
        </div>
        <div className="agent-setup-checks">
          {checks.map((check) => (
            <div
              key={check.label}
              className={`agent-setup-check${check.ok ? '' : ' failed'}`}
            >
              <span className="icon">
                <Icon name={check.ok ? 'check' : 'x'} />
              </span>
              <span className="label">{check.label}</span>
              <span className="detail">{check.detail}</span>
            </div>
          ))}
        </div>
        <div className="agent-setup-fix">
          <span>Add the key to your project .env:</span>
          <pre>
            <span className="comment"># .env</span>
            {'\nANTHROPIC_API_KEY='}
            <span className="value">sk-ant-…</span>
          </pre>
          <span>and restart relate dev with the project&apos;s loader:</span>
          <pre>pnpm exec dotenvx run -f .env -- pnpm relate dev</pre>
        </div>
        <div className="agent-setup-foot">
          The key stays in relate dev: your application code, the code the agent
          runs and this page never see it. Other MCP clients can use the
          endpoint without a key.
        </div>
      </div>
    </div>
  );
}

/** Chat with the built-in agent as the principal selected in the header. */
export function AgentScreen() {
  const { state, agent, client, principal, messages, turn } = useConversation();
  const activity = useActivity();
  const traceOn = useAgentTrace();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const list = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => labelsOf(state.model?.manifest), [state.model]);
  const requests = useMemo(
    () =>
      new Map(
        groupActivity(activity.events).map((request) => [
          request.requestId,
          request,
        ]),
      ),
    [activity.events],
  );
  const maxMs = Math.max(
    1,
    ...messages.map((message) =>
      message.kind === 'tool'
        ? (requests.get(message.requestId)?.call?.ms ?? 0)
        : 0,
    ),
  );
  const missingKey = agent.availability?.available === false;
  const available = agent.availability?.available === true;
  const canSend =
    available && principal !== null && !turn && !sending && draft.trim() !== '';

  // Follow the conversation as it grows, and start at the bottom on a switch.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, principal]);

  useEffect(() => setError(null), [principal]);

  const toggle = (id: string) => {
    const next = new Set(open);

    // In the conversation view a call opens the trace with that call expanded.
    if (!traceOn) {
      next.add(id);
      setAgentTrace(true);
    } else if (!next.delete(id)) next.add(id);

    setOpen(next);
  };
  const send = async () => {
    if (!client || !canSend || principal === null) return;

    setSending(true);
    setError(null);

    const result = await client.send(principal, draft.trim());

    setSending(false);

    if (result.ok) setDraft('');
    else setError(result.error);
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
  const empty =
    agent.connection === 'stopped' ? (
      'Not connected: open the inspector link printed by relate dev.'
    ) : agent.availability === null ? (
      'Connecting to relate dev…'
    ) : principal === null ? (
      <>
        Declare development principals in{' '}
        <code>defineGraph({'{ principals }'})</code> to talk to the agent as one
        of them.
      </>
    ) : messages.length === 0 ? (
      <>
        Ask about your graph data or run an action as{' '}
        <strong>{principal}</strong>. Every call it makes appears here and in
        Activity.
      </>
    ) : null;

  return (
    <div className="agent-screen">
      <div className="agent-scroll" ref={list} aria-live="polite">
        {missingKey ? (
          <Setup />
        ) : empty !== null ? (
          <div className="agent-empty">
            <p>{empty}</p>
          </div>
        ) : (
          <div className={`agent-convo${traceOn ? ' trace' : ''}`}>
            {messages.map((message) =>
              message.kind === 'tool' ? (
                <ToolCall
                  key={message.id}
                  message={message}
                  request={requests.get(message.requestId)}
                  labels={labels}
                  maxMs={maxMs}
                  open={open.has(message.id)}
                  traceOn={traceOn}
                  onToggle={() => toggle(message.id)}
                />
              ) : (
                <Message key={message.id} message={message} />
              ),
            )}
            {turn && (
              <Row kind="note" time="" tone="running">
                <div className="agent-working">
                  {turn.status === 'cancelling' ? 'Cancelling…' : 'Working…'}
                </div>
              </Row>
            )}
          </div>
        )}
      </div>
      <div className={`agent-composer${traceOn ? ' trace' : ''}`}>
        {error && <div className="agent-error">{error}</div>}
        <div className={`agent-composer-box${missingKey ? ' disabled' : ''}`}>
          <textarea
            aria-label="Message the agent"
            placeholder={
              missingKey
                ? 'Set ANTHROPIC_API_KEY to start'
                : principal === null
                  ? 'No principal to act as'
                  : 'Ask about your graph data or run an action'
            }
            value={draft}
            disabled={!available || principal === null}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {turn ? (
            <button
              type="button"
              className="agent-send"
              aria-label={
                turn.status === 'cancelling'
                  ? 'Cancelling'
                  : 'Cancel the running turn'
              }
              data-tooltip={
                turn.status === 'cancelling' ? 'Cancelling…' : 'Cancel'
              }
              onClick={() => void cancel()}
            >
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              type="button"
              className="agent-send"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => void send()}
            >
              <Icon name="arrow-up" size={16} />
            </button>
          )}
        </div>
        <div className="agent-composer-foot">
          {principal !== null && (
            <span>
              Acting as <code>{principal}</code>
            </span>
          )}
          <span className="activity-spacer" />
          <span>Actions run immediately against dev sources</span>
        </div>
      </div>
    </div>
  );
}
