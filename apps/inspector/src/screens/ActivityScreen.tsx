import { useEffect, useMemo, useRef } from 'react';
import { useSearch } from '@tanstack/react-router';
import { groupActivity } from '../connection/activity.js';
import type { RequestActivity } from '../connection/activity.js';
import { useActivity, useInspectorState } from '../inspector-context.js';
import type {
  ActivityStatus,
  ExecutionEvent,
  OperationEvent,
} from '../protocol.js';
import { Tag } from '../ui/tag.js';
import type { TagColor } from '../ui/tag.js';

const statusColor: Record<ActivityStatus, TagColor> = {
  running: 'sky',
  succeeded: 'jade',
  failed: 'red',
};

const shortId = (id: string) => id.slice(0, 8);

const duration = (ms: number | undefined) =>
  ms === undefined
    ? ''
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : `${(ms / 1000).toFixed(1)} s`;

const clock = (at: string) => new Date(at).toLocaleTimeString();

/** `where`, selection and paging in one line; values are previews already. */
function requestSummary(operation: OperationEvent): string {
  const { request, runtimeRecord: row } = operation;

  if (row)
    return [
      'objects' in row ? 'Attempt' : `Committed · position ${row.position}`,
      'parentOperationId' in row && row.parentOperationId
        ? `parent ${shortId(row.parentOperationId)}`
        : '',
      'sourceDefinitionId' in row ? row.sourceDefinitionId : '',
      'changedPropertyIds' in row ? row.changedPropertyIds.join(', ') : '',
    ]
      .filter(Boolean)
      .join(' · ');

  return [
    request.objectId !== undefined ? `id ${request.objectId}` : null,
    request.traversal !== undefined ? `→ ${request.traversal}` : null,
    request.where !== undefined ? `where ${request.where}` : null,
    request.select !== undefined ? `select ${request.select.join(', ')}` : null,
    request.limit !== undefined ? `limit ${request.limit}` : null,
    request.cursor !== undefined ? 'next page' : null,
    request.input !== undefined ? `input ${request.input}` : null,
    request.idempotencyKey !== undefined
      ? `key ${request.idempotencyKey}`
      : null,
    request.invocationId !== undefined
      ? `invocation ${request.invocationId}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function outcomeSummary(operation: OperationEvent): string {
  const row = operation.runtimeRecord;

  if (row) {
    if ('outcome' in row)
      return [
        row.outcome.status,
        'code' in row.outcome ? row.outcome.code : '',
        row.kind === 'invoke' && row.replayed ? 'replayed' : '',
        row.kind === 'refresh' && 'refresh' in row.details
          ? row.details.refresh
          : '',
        row.details.truncated
          ? `${row.details.truncated.omittedObjects} objects omitted`
          : '',
      ]
        .filter(Boolean)
        .join(' · ');

    return row.kind === 'invocation-failed'
      ? row.failureCode
      : row.actor.kind === 'source'
        ? `Observed from ${row.actor.id}`
        : `By ${row.actor.id}`;
  }

  const outcome = operation.outcome;

  if (!outcome) return 'running…';

  if (outcome.error)
    return [outcome.error.code, outcome.error.issues].filter(Boolean).join(' ');

  return [
    outcome.found === true
      ? 'found'
      : outcome.found === false
        ? 'not found'
        : null,
    outcome.records !== undefined
      ? `${outcome.records} record${outcome.records === 1 ? '' : 's'}${
          outcome.hasMore ? ', more' : ''
        }`
      : null,
    outcome.receiptState !== undefined
      ? `receipt ${outcome.receiptState}`
      : null,
    outcome.evidenceWarnings
      ? `${outcome.evidenceWarnings} evidence warning${
          outcome.evidenceWarnings === 1 ? '' : 's'
        }`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function RuntimeTag(props: {
  readonly runtimeId: string | null;
  readonly active: string | null;
}) {
  if (props.runtimeId === null)
    return (
      <Tag color="gray" title="No runtime was running for this call">
        no runtime
      </Tag>
    );

  const retired = props.runtimeId !== props.active;

  return (
    <Tag
      color={retired ? 'gray' : 'blue'}
      variant="outline"
      title={`Runtime ${props.runtimeId}${
        retired
          ? ': since replaced. Its data, connectors and action code may differ from the current runtime.'
          : ': the current runtime'
      }`}
    >
      runtime {shortId(props.runtimeId)}
      {retired ? ' (retired)' : ''}
    </Tag>
  );
}

function Execution(props: { readonly execution: ExecutionEvent }) {
  const { execution } = props;

  return (
    <div className="activity-execution">
      <pre className="activity-code">
        {execution.code}
        {execution.codeTruncated ? '\n…' : ''}
      </pre>
      {execution.logs.length > 0 && (
        <pre className="activity-logs">
          {execution.logs.map((log, index) => (
            <span key={index} className={`activity-log-${log.stream}`}>
              {log.text}
            </span>
          ))}
          {execution.logsTruncated ? '\n… output truncated' : ''}
        </pre>
      )}
      {execution.resultPreview !== undefined && (
        <div className="activity-result">
          <span className="activity-label">returned</span>
          <code>{execution.resultPreview}</code>
        </div>
      )}
      {execution.error && (
        <div className="activity-result failed">
          <span className="activity-label">
            {execution.error.code ?? execution.error.name}
          </span>
          <code>{execution.error.message}</code>
        </div>
      )}
    </div>
  );
}

function Operations(props: {
  readonly operations: readonly OperationEvent[];
  readonly labels: ReadonlyMap<string, string>;
}) {
  return (
    <table className="activity-operations">
      <tbody>
        {props.operations.map((operation) => (
          <tr key={operation.opId} className={operation.status}>
            <td className="activity-op">{operation.op}</td>
            <td className="activity-definition" title={operation.definitionId}>
              {props.labels.get(operation.definitionId) ??
                operation.definitionId}
            </td>
            <td className="activity-request">{requestSummary(operation)}</td>
            <td className="activity-outcome">{outcomeSummary(operation)}</td>
            <td className="activity-ms">{duration(operation.ms)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Request(props: {
  readonly request: RequestActivity;
  readonly activeRuntime: string | null;
  readonly labels: ReadonlyMap<string, string>;
  readonly open: boolean;
  /** Linked from the agent page: opened, scrolled to and marked. */
  readonly focused: boolean;
}) {
  const { call, execution, operations } = props.request;
  const card = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (props.focused) card.current?.scrollIntoView({ block: 'nearest' });
  }, [props.focused]);
  const status =
    call?.status ?? execution?.status ?? operations.at(-1)?.status ?? 'running';
  const at = call?.at ?? execution?.at ?? operations[0]?.at;
  const runtimeId =
    call?.runtimeId ??
    execution?.runtimeId ??
    operations[0]?.context.runtimeId ??
    null;

  return (
    <details
      ref={card}
      className={`activity-request-card${props.focused ? ' focused' : ''}`}
      open={props.open || props.focused}
    >
      <summary>
        <Tag color={statusColor[status]} weight="medium">
          {call?.tool ?? operations[0]?.context.transport ?? 'request'}
        </Tag>
        <span className="activity-principal">
          as {call?.principal ?? operations[0]?.context.principal ?? '—'}
        </span>
        <span className="activity-source">
          {call?.source === 'inspector-agent'
            ? 'inspector agent'
            : 'external client'}
        </span>
        {operations.length > 0 && (
          <span className="activity-count">
            {operations.length} operation{operations.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="activity-spacer" />
        <RuntimeTag runtimeId={runtimeId} active={props.activeRuntime} />
        <span className="activity-ms">{duration(call?.ms)}</span>
        {at && <span className="activity-time">{clock(at)}</span>}
      </summary>
      {call?.error && !execution && (
        <div className="activity-call-error">{call.error}</div>
      )}
      {execution && <Execution execution={execution} />}
      {operations.length > 0 && (
        <Operations operations={operations} labels={props.labels} />
      )}
    </details>
  );
}

/** Every MCP call, the code it ran and each graph read and action behind it. */
export function ActivityScreen() {
  const activity = useActivity();
  const state = useInspectorState();
  const linked = useSearch({
    from: '/activity',
    select: (search) => ('request' in search ? search.request : undefined),
  });
  const requests = useMemo(
    () => groupActivity(activity.events),
    [activity.events],
  );
  const labels = useMemo(() => {
    const manifest = state.model?.manifest;
    const entries: [string, string][] = [];

    for (const object of manifest?.objects ?? [])
      entries.push([object.id, object.label]);

    for (const action of manifest?.actions ?? [])
      entries.push([action.id, action.apiName]);

    return new Map(entries);
  }, [state.model]);
  // A restart retires the previous runtime as soon as it begins, so the
  // newest runtime ID, starting or failed, is the current one.
  const activeRuntime = state.runtime?.runtimeId ?? null;

  return (
    <div className="activity-screen">
      <div className="activity-header">
        <span className="activity-title">Activity</span>
        <span className="activity-hint">
          {activity.connection === 'reconnecting'
            ? 'Reconnecting…'
            : activity.connection === 'stopped'
              ? 'Not connected: open the inspector link printed by relate dev'
              : `${requests.length} recent call${requests.length === 1 ? '' : 's'}; kept in memory by relate dev`}
        </span>
      </div>
      {requests.length === 0 ? (
        <div className="placeholder-screen">
          <div className="title">No activity yet</div>
          <div className="hint">
            Ask the agent on the Agent page, or connect an MCP client with the{' '}
            <code>claude mcp add</code> line printed by relate dev. Its calls,
            the code it runs and every graph read and action appear here.
          </div>
        </div>
      ) : (
        <div className="activity-list">
          {requests.map((request, index) => (
            <Request
              key={request.requestId}
              request={request}
              activeRuntime={activeRuntime}
              labels={labels}
              open={index === 0 && linked === undefined}
              focused={request.requestId === linked}
            />
          ))}
        </div>
      )}
    </div>
  );
}
