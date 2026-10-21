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
  const { request, runtime } = operation;

  return [
    runtime?.record === 'committed' && runtime.position !== undefined
      ? `committed #${runtime.position}`
      : null,
    runtime?.changedPropertyIds?.length
      ? runtime.changedPropertyIds.join(', ')
      : null,
    runtime?.actor.kind === 'source' ? `from ${runtime.actor.id}` : null,
    runtime?.parentOperationId
      ? `within ${shortId(runtime.parentOperationId)}`
      : null,
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

/** What only the runtime knows: replay, refresh result, refused fields. */
function runtimeSummary(operation: OperationEvent): (string | null)[] {
  const runtime = operation.runtime;

  if (!runtime) return [];

  return [
    runtime.replayed ? 'replayed' : null,
    runtime.refresh ?? null,
    runtime.forbidden?.length
      ? `${runtime.forbidden.length} field${
          runtime.forbidden.length === 1 ? '' : 's'
        } refused`
      : null,
    runtime.omittedObjects
      ? `${runtime.omittedObjects} more objects not recorded`
      : null,
  ];
}

function outcomeSummary(operation: OperationEvent): string {
  const outcome = operation.outcome;

  if (!outcome)
    return operation.status === 'running'
      ? 'running…'
      : runtimeSummary(operation)
          .filter((part): part is string => part !== null)
          .join(' · ');

  if (outcome.error)
    return [
      outcome.error.code,
      outcome.error.issues,
      ...runtimeSummary(operation),
    ]
      .filter(Boolean)
      .join(' ');

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
    ...runtimeSummary(operation),
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

const stageLabels = {
  preparation: 'Preparation',
  candidates: 'Candidate reads',
  dependencyReads: 'Dependency reads',
  planning: 'Statement planning',
  queueWait: 'Queue wait',
  connectionStartup: 'Connection startup',
  execution: 'Database execution',
  revalidation: 'Revalidation',
  finalization: 'Result finalization',
};

export function AnalyticalTimings({
  operation,
}: {
  readonly operation: OperationEvent;
}) {
  const timings = operation.runtime?.analytical;

  if (!timings || !Object.keys(timings.stages).length) return null;

  return (
    <details className="activity-timings">
      <summary>Analytical timings</summary>
      <p>
        Elapsed: {duration(operation.ms)}. Summed work durations overlap and do
        not add up to elapsed time.
      </p>
      <table>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Count</th>
            <th>Summed work</th>
            <th>Longest</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(stageLabels).map(([stage, label]) => {
            const value = timings.stages[stage as keyof typeof stageLabels];

            return value ? (
              <tr key={stage}>
                <td>{label}</td>
                <td>{value.count}</td>
                <td>{value.totalMs.toFixed(2)} ms</td>
                <td>{value.maxMs.toFixed(2)} ms</td>
              </tr>
            ) : null;
          })}
        </tbody>
      </table>
    </details>
  );
}

export function AnalyticalSummary({
  operation,
}: {
  readonly operation: OperationEvent;
}) {
  const summary = operation.runtime?.analytical?.summary;

  if (!summary) return null;

  return (
    <details className="activity-timings activity-calculations">
      <summary>Analytical calculations</summary>
      <p>
        {summary.expressionCount} expression
        {summary.expressionCount === 1 ? '' : 's'} ·{' '}
        {summary.computedFilter ? 'Computed filter' : 'No computed filter'} ·{' '}
        {summary.computedOrder ? 'Computed order' : 'No computed order'}
      </p>
      <table>
        <thead>
          <tr>
            <th>Calculation</th>
            <th>Inputs</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {summary.calculations.map((calculation, index) => (
            <tr key={index}>
              <td>{calculation.propertyId ?? 'Caller expression'}</td>
              <td>
                <div>Association: {calculation.associationId}</div>
                <div>Dataset: {calculation.datasetId}</div>
              </td>
              <td>
                {Object.entries(calculation.failures).length
                  ? Object.entries(calculation.failures).map(
                      ([reason, count]) => (
                        <div key={reason}>
                          {reason}: {count}
                        </div>
                      ),
                    )
                  : 'None observed'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Failure counts cover object results across the evaluated scope. Repeated
        checks count once.
      </p>
      {summary.omittedCalculations ? (
        <p>
          {summary.omittedCalculations} expression{' '}
          {summary.omittedCalculations === 1 ? 'entry' : 'entries'} omitted from
          diagnostics.
        </p>
      ) : null}
    </details>
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
          <tr
            key={operation.opId}
            className={[
              operation.status,
              operation.runtime?.record === 'committed' ? 'committed' : '',
              operation.runtime?.parentOperationId ? 'nested' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={
              operation.runtime?.record === 'committed'
                ? 'Committed with the state it describes'
                : operation.runtime
                  ? 'Recorded by the runtime (best effort)'
                  : 'Seen by the dev server; no runtime record yet'
            }
          >
            <td className="activity-op">{operation.op}</td>
            <td className="activity-definition" title={operation.definitionId}>
              {props.labels.get(operation.definitionId) ??
                operation.definitionId}
            </td>
            <td className="activity-request">{requestSummary(operation)}</td>
            <td className="activity-outcome">
              {outcomeSummary(operation)}
              <AnalyticalSummary operation={operation} />
              <AnalyticalTimings operation={operation} />
            </td>
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
            : call?.source === 'inspector-playground'
              ? 'playground'
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
