import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import { useSearch } from '@tanstack/react-router';
import { ActivityDrawer } from '../activity/ActivityDrawer.js';
import type { DrawerTab } from '../activity/ActivityDrawer.js';
import {
  addToken,
  callFacts,
  describeRequest,
  duration,
  facet,
  facetToken,
  hasToken,
  histogram,
  matches,
  operationFacts,
  outcomeSummary,
  parseQuery,
  plural,
  removeToken,
  requestFacts,
  requestOutcome,
  requestSummary,
  timeline,
  timelineSpan,
} from '../activity/model.js';
import type {
  ActivityRequest,
  Facts,
  QueryKey,
  TimelineEntry,
} from '../activity/model.js';
import {
  ACTIVITY_REQUEST_LIMIT,
  groupActivity,
} from '../connection/activity.js';
import { Icon } from '../icons.js';
import { useActivity, useInspectorState } from '../inspector-context.js';

/** Record IDs `relate dev` keeps per operation (`activityLimits.recordIds`). */
const RECORD_ID_LIMIT = 100;

/** Rows rendered at once; the query narrows the rest. */
const ROW_LIMIT = 500;

const ranges = [
  { minutes: 5, label: '5m' },
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: null, label: 'All' },
] as const;

const examples = [
  'status:failed',
  'duration>100ms',
  'analytical:true',
  'op:query,traverse',
  'record:committed',
  '-source:agent',
];

type Mode = 'requests' | 'events';

/** One table row: a request, or one of its operations. */
type Row =
  | {
      readonly kind: 'request';
      readonly key: string;
      readonly at: number;
      readonly request: ActivityRequest;
    }
  | {
      readonly kind: 'operation';
      readonly key: string;
      readonly at: number;
      readonly request: ActivityRequest;
      readonly entry: TimelineEntry;
    };

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

const clock = (at: number, milliseconds = true) => {
  const date = new Date(at);

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${
    milliseconds ? `.${pad(date.getMilliseconds(), 3)}` : ''
  }`;
};

const hues = ['blue', 'iris', 'amber', 'jade', 'orange', 'pink', 'purple'];

/** A stable avatar colour per principal. */
const hueOf = (principal: string) => {
  let hash = 0;

  for (const char of principal) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return hues[Math.abs(hash) % hues.length]!;
};

/** A ticking clock while something runs or a relative range is shown. */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 10_000);

    return () => clearInterval(timer);
  }, [fast]);

  return now;
}

/** Every MCP call, the code it ran and each graph read and action behind it. */
export function ActivityScreen() {
  const activity = useActivity();
  const state = useInspectorState();
  const linked = useSearch({
    from: '/activity',
    select: (search) => ('request' in search ? search.request : undefined),
  });
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('requests');
  const [range, setRange] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(linked ?? null);
  const [selectedOperation, setSelectedOperation] = useState<string | null>(
    null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(linked ? [linked] : []),
  );
  const [tab, setTab] = useState<DrawerTab>('code');
  const requests = useMemo(
    () => groupActivity(activity.events).map(describeRequest),
    [activity.events],
  );
  const running = requests.some((request) => request.status === 'running');
  const now = useNow(running);
  const labels = useMemo(() => {
    const manifest = state.model?.manifest;
    const entries: [string, string][] = [];

    for (const object of manifest?.objects ?? []) {
      entries.push([object.id, object.label]);

      for (const property of object.properties)
        entries.push([property.id, property.name]);
    }

    for (const action of manifest?.actions ?? [])
      entries.push([action.id, action.apiName]);

    return new Map(entries);
  }, [state.model]);
  // A restart retires the previous runtime as soon as it begins, so the
  // newest runtime ID, starting or failed, is the current one.
  const activeRuntime = state.runtime?.runtimeId ?? null;

  useEffect(() => {
    if (!linked) return;

    setSelected(linked);
    setSelectedOperation(null);
    setExpanded((current) => new Set([...current, linked]));
  }, [linked]);

  const tokens = useMemo(() => parseQuery(query), [query]);
  const oldest = requests.at(-1)?.start ?? now;
  // `All` spans at least five minutes, so a burst of recent calls still spreads out.
  const from =
    range === null ? Math.min(oldest, now - 5 * 60_000) : now - range * 60_000;
  // Facts and timelines change with the events, not with the ticking clock.
  const derived = useMemo(
    () =>
      requests.map((request) => {
        const entries = timeline(request);

        return {
          request,
          facts: requestFacts(request, labels),
          call: callFacts(request),
          entries,
          operations: entries.map((entry) =>
            operationFacts(request, entry.operation, labels),
          ),
        };
      }),
    [requests, labels],
  );
  const view = useMemo(() => {
    const items: { facts: Facts; at: number; failed: boolean }[] = [];
    const rows: Row[] = [];
    let matched = 0;
    let failed = 0;

    for (const { request, facts: own, call, entries, operations } of derived) {
      if (request.start < from) continue;

      const operationRow = (entry: TimelineEntry): Row => ({
        kind: 'operation',
        key: `${request.requestId}:${entry.operation.opId}`,
        at: request.start + entry.offset,
        request,
        entry,
      });

      if (mode === 'requests') {
        if (!matches(tokens, own)) continue;

        matched += 1;
        failed += request.status === 'failed' ? 1 : 0;
        items.push({
          facts: own,
          at: request.start,
          failed: request.status === 'failed',
        });
        rows.push({
          kind: 'request',
          key: request.requestId,
          at: request.start,
          request,
        });

        if (expanded.has(request.requestId))
          rows.push(...entries.map(operationRow));

        continue;
      }

      const events: { facts: Facts; row: Row; failed: boolean }[] = [];

      if (request.call || request.execution)
        events.push({
          facts: call,
          row: {
            kind: 'request',
            key: request.requestId,
            at: request.start,
            request,
          },
          failed: request.status === 'failed',
        });

      for (const [index, entry] of entries.entries())
        events.push({
          facts: operations[index]!,
          row: operationRow(entry),
          failed: entry.operation.status === 'failed',
        });

      for (const event of events) {
        if (!matches(tokens, event.facts)) continue;

        matched += 1;
        failed += event.failed ? 1 : 0;
        items.push({
          facts: event.facts,
          at: event.row.at,
          failed: event.failed,
        });
        rows.push(event.row);
      }
    }

    if (mode === 'events') rows.sort((a, b) => b.at - a.at);

    return { rows, items, matched, failed };
  }, [derived, from, tokens, mode, expanded]);
  // Each request's waterfall span, which grows with the clock while it runs.
  const spans = useMemo(() => {
    const spans = new Map<ActivityRequest, number>();

    for (const { request, entries } of derived)
      spans.set(request, timelineSpan(request, entries, now));

    return spans;
  }, [derived, now]);

  const buckets = useMemo(
    () => histogram(view.items, from, now),
    [view.items, from, now],
  );
  const peak = Math.max(1, ...buckets.map((b) => b.ok + b.failed));
  const facets = useMemo(() => {
    const of =
      (key: Exclude<QueryKey, 'duration'>) => (item: { facts: Facts }) =>
        item.facts[key] ?? [];

    return [
      {
        title: 'Principal',
        key: 'principal' as const,
        values: facet(view.items, of('principal')),
      },
      {
        title: 'Source',
        key: 'source' as const,
        values: facet(view.items, of('source')),
      },
      {
        title: 'Status',
        key: 'status' as const,
        values: facet(view.items, of('status')),
      },
      {
        title: 'Operation',
        key: 'op' as const,
        values: facet(view.items, of('op')),
      },
      {
        title: 'Definition',
        key: 'def' as const,
        values: facet(
          view.items,
          // Facts carry each definition's ID and label; count the ID once.
          (item) =>
            (item.facts.def ?? []).filter(
              (value) =>
                !(item.facts.def ?? []).some(
                  (id) => id !== value && labels.get(id) === value,
                ),
            ),
          (value) => labels.get(value) ?? value,
        ),
      },
      {
        title: 'Runtime',
        key: 'runtime' as const,
        values: facet(
          view.items,
          of('runtime'),
          (value) =>
            `${value.slice(0, 8)}${value === activeRuntime ? '' : ' (retired)'}`,
        ),
      },
    ].filter((group) => group.values.length);
  }, [view.items, labels, activeRuntime]);

  const selectedRequest =
    requests.find((request) => request.requestId === selected) ?? null;
  const selectedRow = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, linked]);

  const closeDrawer = () => {
    setSelected(null);
    setSelectedOperation(null);
  };

  useEffect(() => {
    // Escape closes the drawer unless a field, a dialog or another handler took it.
    const close = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;

      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        target?.closest(
          'input, textarea, select, [contenteditable], dialog, [role="dialog"]',
        )
      )
        return;

      setSelected(null);
      setSelectedOperation(null);
    };

    window.addEventListener('keydown', close);

    return () => window.removeEventListener('keydown', close);
  }, []);

  const toggleToken = (token: string) =>
    setQuery((current) =>
      hasToken(current, token)
        ? removeToken(current, token)
        : addToken(current, token),
    );
  const selectRequest = (request: ActivityRequest) => {
    const open = selected === request.requestId && !selectedOperation;

    setSelected(open ? null : request.requestId);
    setSelectedOperation(null);
    setExpanded((current) => {
      const next = new Set(current);

      if (open) next.delete(request.requestId);
      else next.add(request.requestId);

      return next;
    });
  };
  const selectOperation = (request: ActivityRequest, opId: string) => {
    setSelected(request.requestId);
    setSelectedOperation(opId);

    if (tab === 'code') setTab('timeline');
  };
  const retention =
    requests.length >= ACTIVITY_REQUEST_LIMIT
      ? `Oldest kept ${clock(oldest, false)} · relate dev keeps the latest ${ACTIVITY_REQUEST_LIMIT} requests`
      : null;

  if (requests.length === 0)
    return (
      <div className="activity-screen">
        <div className="placeholder-screen">
          <div className="title">
            {activity.connection === 'stopped'
              ? 'Not connected'
              : 'No activity yet'}
          </div>
          <div className="hint">
            {activity.connection === 'stopped' ? (
              'Open the inspector link printed by relate dev.'
            ) : (
              <>
                Ask the agent on the Agent page, run code in the Playground, or
                connect an MCP client with the <code>claude mcp add</code> line
                printed by relate dev. Its calls, the code it runs and every
                graph read and action appear here.
              </>
            )}
          </div>
        </div>
      </div>
    );

  return (
    <div className="activity-screen">
      <div className="activity-toolbar">
        <div className="activity-toolbar-row">
          <div className="activity-search">
            <span className="activity-search-icon">
              <Icon name="search" />
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
              aria-label="Filter activity"
              placeholder="principal:ops@acme.com status:failed duration>100ms"
            />
            <span className="activity-search-count">
              {plural(view.matched, mode === 'requests' ? 'request' : 'event')}
              {view.failed ? ` · ${view.failed} failed` : ''}
            </span>
          </div>
          <div className="activity-segment" role="group" aria-label="Rows">
            {(['requests', 'events'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`button button-ghost${mode === value ? ' active' : ''}`}
                onClick={() => setMode(value)}
              >
                {value === 'requests' ? 'Requests' : 'Events'}
              </button>
            ))}
          </div>
          <div className="activity-segment" role="group" aria-label="Range">
            {ranges.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`button button-ghost${range === option.minutes ? ' active' : ''}`}
                onClick={() => setRange(option.minutes)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {activity.connection !== 'live' && (
            <span className="activity-live">
              {activity.connection === 'reconnecting'
                ? 'Reconnecting…'
                : activity.connection}
            </span>
          )}
        </div>
        <div className="activity-examples">
          <span className="activity-muted">Try</span>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="activity-chip activity-mono"
              onClick={() => setQuery(example)}
            >
              {example}
            </button>
          ))}
          {retention && <span className="activity-retention">{retention}</span>}
        </div>
      </div>
      <div className="activity-histogram">
        <div className="activity-bars">
          {buckets.map((bucket) => (
            <div
              key={bucket.from}
              className="activity-bar"
              title={`${clock(bucket.from, false)} · ${plural(
                bucket.ok + bucket.failed,
                mode === 'requests' ? 'request' : 'event',
              )}${bucket.failed ? `, ${bucket.failed} failed` : ''}`}
            >
              <div
                className="activity-bar-failed"
                style={{ height: `${(bucket.failed / peak) * 100}%` }}
              />
              <div
                className="activity-bar-ok"
                style={{ height: `${(bucket.ok / peak) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="activity-axis">
          <span>{clock(from, false)}</span>
          <span>{clock(from + (now - from) / 2, false)}</span>
          <span>now</span>
        </div>
      </div>
      <div className="activity-body">
        <div className="activity-facets">
          {facets.map((group) => (
            <div key={group.title} className="activity-facet">
              <div className="activity-facet-title">{group.title}</div>
              {group.values.map((value) => {
                const token = facetToken(group.key, value.value);
                const on = hasToken(query, token);

                return (
                  <button
                    key={value.value}
                    type="button"
                    className={`activity-facet-value${on ? ' active' : ''}`}
                    onClick={() => toggleToken(token)}
                    title={value.value}
                  >
                    <span className="label">{value.label}</span>
                    <span className="count">{value.count}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="activity-table">
          <div className="activity-row activity-row-head">
            <span>Time</span>
            <span />
            <span>Principal</span>
            <span>Source</span>
            <span>Event</span>
            <span>Definition</span>
            <span>Detail</span>
            <span className="right">Duration</span>
          </div>
          <div className="activity-rows">
            {view.rows.slice(0, ROW_LIMIT).map((row) => {
              const isSelected =
                row.request.requestId === selected &&
                (row.kind === 'request'
                  ? !selectedOperation
                  : row.entry.operation.opId === selectedOperation);

              return (
                <Fragment key={row.key}>
                  {row.kind === 'request' ? (
                    <RequestRow
                      ref={isSelected ? selectedRow : undefined}
                      request={row.request}
                      labels={labels}
                      selected={isSelected}
                      expanded={
                        mode === 'requests' &&
                        expanded.has(row.request.requestId)
                      }
                      showCaret={mode === 'requests'}
                      onClick={() => selectRequest(row.request)}
                    />
                  ) : (
                    <OperationRow
                      ref={isSelected ? selectedRow : undefined}
                      row={row}
                      span={spans.get(row.request) ?? 1}
                      labels={labels}
                      nested={mode === 'requests'}
                      selected={isSelected}
                      onClick={() =>
                        selectOperation(row.request, row.entry.operation.opId)
                      }
                    />
                  )}
                </Fragment>
              );
            })}
            {view.rows.length > ROW_LIMIT && (
              <div className="activity-empty-note">
                Showing the latest {ROW_LIMIT} of {view.rows.length} rows.
                Narrow the query to see the rest.
              </div>
            )}
            {view.rows.length === 0 && (
              <div className="activity-empty-note">
                No {mode} match this query in the selected range.
              </div>
            )}
          </div>
        </div>
        {selectedRequest && (
          <ActivityDrawer
            key={selectedRequest.requestId}
            request={selectedRequest}
            activeRuntime={activeRuntime}
            labels={labels}
            recordIdLimit={RECORD_ID_LIMIT}
            now={now}
            tab={tab}
            onTab={setTab}
            selectedOperation={selectedOperation}
            onSelectOperation={setSelectedOperation}
            onFilter={(token) =>
              setQuery((current) => addToken(current, token))
            }
            onClose={closeDrawer}
          />
        )}
      </div>
    </div>
  );
}

function Avatar(props: { readonly principal: string | null }) {
  const principal = props.principal ?? '—';
  const hue = hueOf(principal);

  return (
    <span className="activity-who">
      <span
        className="activity-avatar"
        style={{
          background: `var(--t-color-${hue}3)`,
          color: `var(--t-color-${hue}11)`,
        }}
      >
        {principal[0]?.toUpperCase()}
      </span>
      <span className="activity-ellipsis">{principal}</span>
    </span>
  );
}

/** Elapsed time on a log scale, so 5 ms and 5 s both read. */
const logWidth = (ms: number) =>
  `${Math.max(4, Math.min(100, (Math.log10(ms + 1) / Math.log10(10_001)) * 100))}%`;

function RequestRow(props: {
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly request: ActivityRequest;
  readonly labels: ReadonlyMap<string, string>;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly showCaret: boolean;
  readonly onClick: () => void;
}) {
  const { request } = props;
  const definitions = [
    ...new Set(
      request.operations.map(
        (operation) =>
          props.labels.get(operation.definitionId) ?? operation.definitionId,
      ),
    ),
  ];
  const outcome = requestOutcome(request);

  return (
    <div
      ref={props.ref}
      className={`activity-row activity-row-request ${request.status}${props.selected ? ' selected' : ''}`}
      onClick={props.onClick}
    >
      <span className="activity-mono activity-time">
        {clock(request.start)}
      </span>
      <span className={`activity-dot activity-dot-${request.status}`} />
      <Avatar principal={request.principal} />
      <span className="activity-muted">{request.source}</span>
      <span className="activity-event">
        {props.showCaret && request.operations.length > 0 && (
          <span className={`activity-caret${props.expanded ? ' open' : ''}`}>
            ▸
          </span>
        )}
        {request.tool}
      </span>
      <span className="activity-ellipsis" title={definitions.join(', ')}>
        {definitions.length
          ? definitions.join(', ')
          : request.operations.length
            ? ''
            : '—'}
      </span>
      <span
        className={`activity-mono activity-detail activity-ellipsis${request.status === 'failed' ? ' failed' : ''}`}
        title={outcome}
      >
        {request.operations.length > 0 && (
          <span className="activity-muted">
            {plural(request.operations.length, 'op')} ·{' '}
          </span>
        )}
        {outcome}
      </span>
      <span className="activity-duration">
        <span className="activity-duration-track">
          <span
            className={`activity-duration-bar ${request.status}${(request.ms ?? 0) > 1_000 ? ' slow' : ''}`}
            style={{
              width: request.ms === undefined ? '100%' : logWidth(request.ms),
            }}
          />
        </span>
        <span className="activity-duration-ms">
          {request.status === 'running' ? 'running' : duration(request.ms)}
        </span>
      </span>
    </div>
  );
}

function OperationRow(props: {
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly row: Extract<Row, { kind: 'operation' }>;
  readonly span: number;
  readonly labels: ReadonlyMap<string, string>;
  readonly nested: boolean;
  readonly selected: boolean;
  readonly onClick: () => void;
}) {
  const { request, entry } = props.row;
  const { span } = props;
  const { operation } = entry;
  const committed = operation.runtime?.record === 'committed';
  const summary = requestSummary(operation, props.labels);
  const outcome = outcomeSummary(operation);
  const detail = [summary, outcome].filter(Boolean).join(' → ');
  const actor =
    operation.runtime && operation.runtime.actor.id !== request.principal
      ? operation.runtime.actor.id
      : null;

  return (
    <div
      ref={props.ref}
      className={`activity-row activity-row-operation ${operation.status}${props.nested ? ' nested' : ''}${props.selected ? ' selected' : ''}`}
      onClick={props.onClick}
    >
      <span className="activity-mono activity-time">
        {props.nested ? `+${duration(entry.offset)}` : clock(props.row.at)}
      </span>
      <span className={`activity-dot activity-dot-${operation.status}`} />
      {props.nested ? (
        <span className="activity-muted activity-ellipsis">
          {actor ? `as ${actor}` : ''}
        </span>
      ) : (
        <Avatar principal={actor ?? request.principal} />
      )}
      <span className="activity-muted">
        {props.nested ? '' : request.source}
      </span>
      <span
        className={`activity-event activity-op${committed ? ' committed' : ''}`}
        style={{ paddingLeft: (props.nested ? 12 : 0) + entry.depth * 12 }}
      >
        ↳ {operation.op}
        {operation.runtime?.analytical && (
          <span className="activity-badge" title="Analytical timings recorded">
            <Icon name="timeline" size={12} />
          </span>
        )}
      </span>
      <span className="activity-ellipsis" title={operation.definitionId}>
        {props.labels.get(operation.definitionId) ?? operation.definitionId}
      </span>
      <span
        className={`activity-mono activity-detail activity-ellipsis${operation.status === 'failed' ? ' failed' : ''}`}
        title={detail}
      >
        {detail}
      </span>
      <span className="activity-duration">
        <span
          className="activity-duration-track"
          title={`+${duration(entry.offset)} of ${duration(span)}`}
        >
          <span
            className={`activity-duration-bar ${operation.status}${committed ? ' committed' : ''}`}
            style={{
              marginLeft: `${Math.min(100, (entry.offset / span) * 100)}%`,
              width: `max(2px, ${Math.min(
                100,
                ((operation.ms ??
                  (operation.status === 'running' ? span - entry.offset : 0)) /
                  span) *
                  100,
              )}%)`,
            }}
          />
        </span>
        <span className="activity-duration-ms">
          {operation.status === 'running' ? 'running' : duration(operation.ms)}
        </span>
      </span>
    </div>
  );
}
