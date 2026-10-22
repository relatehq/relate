/**
 * The selected request, beside the activity table: the code it ran, the
 * operation waterfall with analytical stage timings, the objects it touched
 * and every recorded field.
 */
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../icons.js';
import type { OperationEvent } from '../protocol.js';
import { Code } from '../ui/code.js';
import { Tag } from '../ui/tag.js';
import type { ActivityRequest, TimelineEntry } from './model.js';
import {
  duration,
  executionOmitted,
  facetToken,
  flattenFields,
  isCommitted,
  operationOmitted,
  outcomeSummary,
  plural,
  requestOutcome,
  requestSummary,
  shortId,
  timeline,
  timelineSpan,
  touchedObjects,
} from './model.js';

export type DrawerTab = 'code' | 'timeline' | 'objects' | 'metadata';

const tabs: readonly { readonly id: DrawerTab; readonly label: string }[] = [
  { id: 'code', label: 'Code' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'objects', label: 'Objects' },
  { id: 'metadata', label: 'Metadata' },
];

const statusDot = (status: string) => `activity-dot activity-dot-${status}`;

const percent = (value: number) => `${Math.max(0, Math.min(100, value))}%`;

export function ActivityDrawer(props: {
  readonly request: ActivityRequest;
  readonly activeRuntime: string | null;
  readonly labels: ReadonlyMap<string, string>;
  readonly recordIdLimit: number;
  readonly now: number;
  readonly tab: DrawerTab;
  readonly onTab: (tab: DrawerTab) => void;
  readonly selectedOperation: string | null;
  readonly onSelectOperation: (opId: string | null) => void;
  /** Add a token to the screen's query. */
  readonly onFilter: (token: string) => void;
  readonly onClose: () => void;
}) {
  const { request } = props;
  const retired =
    request.runtimeId !== null && request.runtimeId !== props.activeRuntime;
  const touched = touchedObjects(request.operations, props.recordIdLimit);
  const counts: Partial<Record<DrawerTab, number>> = {
    timeline: request.operations.length,
    objects: touched.reduce(
      (sum, definition) => sum + definition.records.length,
      0,
    ),
  };

  return (
    <aside className="activity-drawer" aria-label="Request details">
      <div className="activity-drawer-head">
        <div className="activity-drawer-title">
          <span className={statusDot(request.status)} />
          <span className="activity-drawer-tool">{request.tool}</span>
          <span className="activity-drawer-principal">
            {request.principal ?? '—'}
          </span>
          <span className="activity-muted">{request.source}</span>
          <span className="activity-spacer" />
          <span className="activity-mono activity-muted">
            {duration(request.ms)}
          </span>
          <button
            type="button"
            className="icon-button icon-button-sm"
            aria-label="Close details"
            onClick={props.onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="activity-drawer-sub">
          <span className="activity-mono" title={request.requestId}>
            req {shortId(request.requestId)}
          </span>
          {request.runtimeId === null ? (
            <Tag color="gray" title="No runtime was running for this call">
              no runtime
            </Tag>
          ) : (
            <Tag
              color={retired ? 'gray' : 'blue'}
              variant="outline"
              title={`Runtime ${request.runtimeId}${
                retired
                  ? ': since replaced. Its data, connectors and action code may differ from the current runtime.'
                  : ': the current runtime'
              }`}
            >
              runtime {shortId(request.runtimeId)}
              {retired ? ' (retired)' : ''}
            </Tag>
          )}
          <span className="activity-muted">
            {new Date(request.start).toISOString()}
          </span>
        </div>
        <div className="activity-drawer-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => props.onFilter(facetToken('req', request.requestId))}
          >
            Only this request
          </button>
          {request.principal && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() =>
                props.onFilter(facetToken('principal', request.principal!))
              }
            >
              Only {request.principal}
            </button>
          )}
        </div>
        <div className="activity-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={props.tab === tab.id}
              className={`activity-tab${props.tab === tab.id ? ' active' : ''}`}
              onClick={() => props.onTab(tab.id)}
            >
              {tab.label}
              {counts[tab.id] ? (
                <span className="activity-tab-count">{counts[tab.id]}</span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="activity-drawer-body">
        {props.tab === 'code' && <CodeTab request={request} />}
        {props.tab === 'timeline' && (
          <TimelineTab
            request={request}
            labels={props.labels}
            now={props.now}
            selected={props.selectedOperation}
            onSelect={props.onSelectOperation}
          />
        )}
        {props.tab === 'objects' && (
          <ObjectsTab
            touched={touched}
            labels={props.labels}
            recordIdLimit={props.recordIdLimit}
            onFilter={props.onFilter}
          />
        )}
        {props.tab === 'metadata' && (
          <MetadataTab
            request={request}
            labels={props.labels}
            selected={props.selectedOperation}
          />
        )}
      </div>
    </aside>
  );
}

function Section(props: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="activity-section">
      <div className="activity-section-title">
        <span>{props.title}</span>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

function Empty(props: { readonly children: ReactNode }) {
  return <div className="activity-empty-note">{props.children}</div>;
}

// Code ---------------------------------------------------------------------

function CodeTab(props: { readonly request: ActivityRequest }) {
  const { call, execution } = props.request;

  if (!execution)
    return (
      <>
        <Empty>
          {call?.tool === 'discover'
            ? 'A discover call reads the authorized graph description; no code ran.'
            : 'No code was recorded for this request.'}
        </Empty>
        {call?.error && (
          <Section title="Error">
            <div className="activity-error">{call.error}</div>
          </Section>
        )}
      </>
    );

  return (
    <>
      <Section
        title="JavaScript"
        aside={
          <span className="activity-muted">
            {plural(execution.code.split('\n').length, 'line')}
            {execution.codeTruncated ? ' · truncated' : ''}
          </span>
        }
      >
        <Code source={execution.code} numbered />
        {execution.codeTruncated && (
          <div className="activity-muted">
            relate dev keeps the first 16 KiB of submitted code.
          </div>
        )}
      </Section>
      {execution.logs.length > 0 && (
        <Section
          title="Output"
          aside={
            execution.logsTruncated ? (
              <span className="activity-muted">truncated</span>
            ) : undefined
          }
        >
          <pre className="activity-logs">
            {execution.logs.map((log, index) => (
              <span key={index} className={`activity-log-${log.stream}`}>
                {log.text}
              </span>
            ))}
          </pre>
        </Section>
      )}
      {execution.error ? (
        <Section title="Threw">
          <div className="activity-error">
            <strong>{execution.error.code ?? execution.error.name}</strong>{' '}
            {execution.error.message}
          </div>
        </Section>
      ) : execution.resultPreview !== undefined ? (
        <Section title="Returned">
          <Code source={execution.resultPreview} />
        </Section>
      ) : null}
      {call?.error && !execution.error && (
        <Section title="Call error">
          <div className="activity-error">{call.error}</div>
        </Section>
      )}
    </>
  );
}

// Timeline -----------------------------------------------------------------

function Span(props: {
  readonly label: ReactNode;
  readonly offset: number;
  readonly ms: number | undefined;
  readonly span: number;
  readonly status: string;
  readonly depth?: number;
  readonly selected?: boolean;
  readonly committed?: boolean;
  readonly title?: string;
  readonly onClick?: () => void;
}) {
  const running = props.ms === undefined && props.status === 'running';
  const width =
    props.ms === undefined
      ? running
        ? 100 - (props.offset / props.span) * 100
        : 0
      : (props.ms / props.span) * 100;

  return (
    <div
      className={`activity-span${props.selected ? ' selected' : ''}${props.onClick ? ' clickable' : ''}`}
      onClick={props.onClick}
      title={props.title}
    >
      <span
        className="activity-span-label"
        style={{ paddingLeft: (props.depth ?? 0) * 12 } as CSSProperties}
      >
        {props.label}
      </span>
      <span className="activity-span-track">
        <span
          className={`activity-span-bar ${props.status}${props.committed ? ' committed' : ''}`}
          style={{
            left: percent((props.offset / props.span) * 100),
            width: `max(2px, ${percent(width)})`,
          }}
        />
      </span>
      <span className="activity-span-ms">
        {running ? 'running' : duration(props.ms)}
      </span>
    </div>
  );
}

function TimelineTab(props: {
  readonly request: ActivityRequest;
  readonly labels: ReadonlyMap<string, string>;
  readonly now: number;
  readonly selected: string | null;
  readonly onSelect: (opId: string | null) => void;
}) {
  const { request } = props;
  const entries = timeline(request);
  const span = timelineSpan(request, entries, props.now);
  // Only the operation the table and Metadata tab also show as selected.
  const selected = entries.find(
    (entry) => entry.operation.opId === props.selected,
  );
  const offsetOf = (at: string) => new Date(at).getTime() - request.start;
  const inOperations = entries
    .filter((entry) => entry.depth === 0)
    .reduce((sum, entry) => sum + (entry.operation.ms ?? 0), 0);

  return (
    <>
      <Section
        title="Waterfall"
        aside={
          <span className="activity-muted">
            0 – {duration(span)}
            {request.ms !== undefined && entries.length
              ? ` · ${duration(inOperations)} in top-level operations`
              : ''}
          </span>
        }
      >
        <div className="activity-waterfall">
          {request.call && (
            <Span
              label={<strong>call · {request.call.tool}</strong>}
              offset={offsetOf(request.call.at)}
              ms={request.call.ms}
              span={span}
              status={request.call.status}
              title="The MCP tool call, from receipt to response"
            />
          )}
          {request.execution && (
            <Span
              label="execution"
              offset={offsetOf(request.execution.at)}
              ms={request.execution.ms}
              span={span}
              status={request.execution.status}
              depth={1}
              title="The JavaScript run in the executor"
            />
          )}
          {entries.map((entry) => (
            <Span
              key={entry.operation.opId}
              label={
                <>
                  <span className="activity-mono">{entry.operation.op}</span>{' '}
                  <span className="activity-muted">
                    {props.labels.get(entry.operation.definitionId) ??
                      entry.operation.definitionId}
                  </span>
                </>
              }
              offset={entry.offset}
              ms={entry.operation.ms}
              span={span}
              status={entry.operation.status}
              depth={entry.depth + (request.execution ? 2 : 1)}
              committed={isCommitted(entry.operation)}
              selected={entry === selected}
              onClick={() => props.onSelect(entry.operation.opId)}
              title={`+${duration(entry.offset)} · ${outcomeSummary(entry.operation)}`}
            />
          ))}
        </div>
        {!entries.length && (
          <Empty>This request made no graph operations.</Empty>
        )}
      </Section>
      {selected ? (
        <OperationDetail
          entry={selected}
          labels={props.labels}
          request={request}
        />
      ) : (
        entries.length > 0 && (
          <Empty>Select an operation to see its detail and timings.</Empty>
        )
      )}
    </>
  );
}

function OperationDetail(props: {
  readonly entry: TimelineEntry;
  readonly labels: ReadonlyMap<string, string>;
  readonly request: ActivityRequest;
}) {
  const { operation, offset } = props.entry;
  const summary = requestSummary(operation, props.labels);

  return (
    <Section
      title={`${operation.op} · ${props.labels.get(operation.definitionId) ?? operation.definitionId}`}
      aside={
        <span className="activity-muted">
          +{duration(offset)} · {duration(operation.ms)}
        </span>
      }
    >
      <dl className="activity-fields">
        {summary && (
          <>
            <dt>request</dt>
            <dd>{summary}</dd>
          </>
        )}
        <dt>outcome</dt>
        <dd className={operation.status === 'failed' ? 'failed' : undefined}>
          {outcomeSummary(operation) || operation.status}
        </dd>
        <dt>record</dt>
        <dd>
          {operation.runtime?.record === 'committed'
            ? 'committed with the state it describes'
            : operation.runtime
              ? 'attempt, recorded by the runtime (best effort)'
              : 'seen by the dev server; no runtime record yet'}
        </dd>
      </dl>
      <AnalyticalTimings operation={operation} />
      <AnalyticalSummary operation={operation} />
    </Section>
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

/**
 * Summed work per stage against the operation's elapsed time. Stages overlap
 * and nest, so bars are drawn from zero rather than as a sequence.
 */
export function AnalyticalTimings({
  operation,
}: {
  readonly operation: OperationEvent;
}) {
  const timings = operation.runtime?.analytical;

  if (!timings || !Object.keys(timings.stages).length) return null;

  const stages = Object.entries(stageLabels).flatMap(([stage, label]) => {
    const value = timings.stages[stage as keyof typeof stageLabels];

    return value ? [{ stage, label, ...value }] : [];
  });
  const scale = Math.max(
    operation.ms ?? 0,
    ...stages.map((stage) => stage.totalMs),
    0.001,
  );

  return (
    <div className="activity-stages">
      <div className="activity-stages-head">
        <span>Analytical timings</span>
        <span className="activity-muted">
          Elapsed: {duration(operation.ms)}
        </span>
      </div>
      <div className="activity-stage-grid">
        <span className="activity-stage-th">Stage</span>
        <span className="activity-stage-th" />
        <span className="activity-stage-th num">Count</span>
        <span className="activity-stage-th num">Summed work</span>
        <span className="activity-stage-th num">Longest</span>
        {stages.map((stage) => (
          <StageRow key={stage.stage} scale={scale} {...stage} />
        ))}
      </div>
      <p className="activity-muted">
        Summed work durations overlap and do not add up to elapsed time. The bar
        is summed work; the tick is the longest single span.
      </p>
    </div>
  );
}

function StageRow(props: {
  readonly label: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly scale: number;
}) {
  return (
    <>
      <span>{props.label}</span>
      <span className="activity-stage-track">
        <span
          className="activity-stage-bar"
          style={{ width: percent((props.totalMs / props.scale) * 100) }}
        />
        <span
          className="activity-stage-tick"
          style={{ left: percent((props.maxMs / props.scale) * 100) }}
        />
      </span>
      <span className="num">{props.count}</span>
      <span className="num">{props.totalMs.toFixed(2)} ms</span>
      <span className="num">{props.maxMs.toFixed(2)} ms</span>
    </>
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
    <div className="activity-stages">
      <div className="activity-stages-head">
        <span>Analytical calculations</span>
        <span className="activity-muted">
          {summary.expressionCount} expression
          {summary.expressionCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="activity-flags">
        <Tag color={summary.computedFilter ? 'iris' : 'gray'}>
          {summary.computedFilter ? 'Computed filter' : 'No computed filter'}
        </Tag>
        <Tag color={summary.computedOrder ? 'iris' : 'gray'}>
          {summary.computedOrder ? 'Computed order' : 'No computed order'}
        </Tag>
      </div>
      <table className="activity-calculations">
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
              <td className="activity-mono">
                {calculation.propertyId ?? 'Caller expression'}
              </td>
              <td>
                <div>Association: {calculation.associationId}</div>
                <div>Dataset: {calculation.datasetId}</div>
              </td>
              <td>
                {Object.entries(calculation.failures).length
                  ? Object.entries(calculation.failures).map(
                      ([reason, count]) => (
                        <div key={reason} className="failed">
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
      <p className="activity-muted">
        Failure counts cover object results across the evaluated scope. Repeated
        checks count once.
      </p>
      {summary.omittedCalculations ? (
        <p className="activity-muted">
          {summary.omittedCalculations} expression{' '}
          {summary.omittedCalculations === 1 ? 'entry' : 'entries'} omitted from
          diagnostics.
        </p>
      ) : null}
    </div>
  );
}

// Objects ------------------------------------------------------------------

function ObjectsTab(props: {
  readonly touched: ReturnType<typeof touchedObjects>;
  readonly labels: ReadonlyMap<string, string>;
  readonly recordIdLimit: number;
  readonly onFilter: (token: string) => void;
}) {
  if (!props.touched.length)
    return <Empty>This request touched no objects or actions.</Empty>;

  return (
    <>
      {props.touched.map((definition) => (
        <Section
          key={definition.definitionId}
          title={
            props.labels.get(definition.definitionId) ?? definition.definitionId
          }
          aside={
            <span className="activity-muted">
              {definition.action
                ? plural(definition.operations, 'invocation event')
                : [
                    plural(definition.records.length, 'record'),
                    definition.changes
                      ? plural(definition.changes, 'committed change')
                      : null,
                    plural(definition.operations, 'operation'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
            </span>
          }
        >
          <div className="activity-objects">
            <Tag color={definition.action ? 'purple' : 'blue'}>
              {definition.action ? 'action' : 'object'}
            </Tag>
            <button
              type="button"
              className="activity-chip"
              onClick={() =>
                props.onFilter(facetToken('def', definition.definitionId))
              }
              title="Show activity on this definition"
            >
              {definition.definitionId}
            </button>
          </div>
          {definition.records.length > 0 && (
            <div className="activity-records">
              {definition.records.map((record) => (
                <div key={record.id} className="activity-record">
                  <button
                    type="button"
                    className="activity-chip activity-mono"
                    onClick={() =>
                      props.onFilter(facetToken('object', record.id))
                    }
                    title="Show every request that touched this object"
                  >
                    {record.id}
                  </button>
                  <span className="activity-muted">
                    {record.ops.join(', ')}
                  </span>
                  {record.changed.length > 0 && (
                    <span className="activity-changed">
                      changed{' '}
                      {record.changed
                        .map((id) => props.labels.get(id) ?? id)
                        .join(', ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {definition.forbidden.length > 0 && (
            <div className="activity-error">
              Refused:{' '}
              {definition.forbidden
                .map((id) => props.labels.get(id) ?? id)
                .join(', ')}
            </div>
          )}
          {(definition.omitted > 0 || definition.capped) && (
            <div className="activity-muted">
              {definition.omitted > 0
                ? `${definition.omitted} more objects were not recorded by the runtime. `
                : ''}
              {definition.capped
                ? `Each operation keeps at most ${props.recordIdLimit} record IDs.`
                : ''}
            </div>
          )}
        </Section>
      ))}
    </>
  );
}

// Metadata -----------------------------------------------------------------

function Fields(props: {
  readonly fields: readonly (readonly [string, string])[];
}) {
  return (
    <dl className="activity-fields">
      {props.fields.map(([key, value]) => (
        <FieldRow key={key} name={key} value={value} />
      ))}
    </dl>
  );
}

function FieldRow(props: { readonly name: string; readonly value: string }) {
  return (
    <>
      <dt title={props.name}>{props.name}</dt>
      <dd>{props.value}</dd>
    </>
  );
}

function MetadataTab(props: {
  readonly request: ActivityRequest;
  readonly labels: ReadonlyMap<string, string>;
  readonly selected: string | null;
}) {
  const { request } = props;
  const [raw, setRaw] = useState(false);
  const operation =
    request.operations.find((entry) => entry.opId === props.selected) ??
    undefined;
  const events = [
    request.call,
    request.execution,
    ...request.operations,
  ].filter(Boolean);

  if (raw)
    return (
      <>
        <div className="activity-drawer-actions">
          <button
            type="button"
            className="button button-ghost"
            onClick={() => setRaw(false)}
          >
            Show fields
          </button>
        </div>
        <Code source={JSON.stringify(events, null, 2)} />
      </>
    );

  return (
    <>
      <div className="activity-drawer-actions">
        <button
          type="button"
          className="button button-ghost"
          onClick={() => setRaw(true)}
        >
          Raw JSON
        </button>
      </div>
      <Section title="Request">
        <Fields
          fields={[
            ['requestId', request.requestId],
            ['started', new Date(request.start).toISOString()],
            ['elapsed', duration(request.ms)],
            ['status', request.status],
            ['principal', request.principal ?? '—'],
            ['source', request.source],
            ['runtimeId', request.runtimeId ?? '—'],
            ['operations', String(request.operations.length)],
          ]}
        />
      </Section>
      {request.call && (
        <Section title="Call">
          <Fields fields={flattenFields(request.call)} />
        </Section>
      )}
      {request.execution && (
        <Section title="Execution">
          <Fields fields={flattenFields(request.execution, executionOmitted)} />
        </Section>
      )}
      {operation && (
        <Section title={`Operation · ${operation.op}`}>
          <Fields
            fields={[
              ...flattenFields(operation, operationOmitted),
              ['recordIds', `${operation.recordIds.length} (see Objects)`],
            ]}
          />
        </Section>
      )}
      {!operation && request.operations[0] && (
        <Section title="Operation context">
          <Fields fields={flattenFields(request.operations[0].context)} />
          <div className="activity-muted">
            Select an operation in the table or Timeline to see all its fields.
          </div>
        </Section>
      )}
      {request.status !== 'running' && requestOutcome(request) && (
        <Section title="Outcome">
          <div className="activity-mono">{requestOutcome(request)}</div>
        </Section>
      )}
    </>
  );
}
