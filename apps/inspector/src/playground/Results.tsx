/**
 * What a run returned. A page of records (`{ data, meta }`) or one record
 * renders as a table: property types from discovery, computed field types from
 * `meta.computed`, and omitted fields as `forbidden` or `unavailable` chips.
 * Clicking a cell shows its field evidence. Arrays of plain objects render as
 * a table too; anything else as JSON. Logs and failures have their own views.
 */
import { Link } from '@tanstack/react-router';
import { memo, useEffect, useState } from 'react';
import type { PlaygroundObject, PlaygroundRun } from '../protocol.js';
import { Icon } from '../icons.js';
import { Tag } from '../ui/tag.js';
import { isComputed, propertyType } from './model.js';

interface RecordLike {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly meta: {
    readonly completeness?: string;
    readonly computed?: Record<string, { type?: string; nullable?: boolean }>;
    readonly fields?: Record<
      string,
      { status?: string } & Record<string, unknown>
    >;
  };
}

const isRecord = (value: unknown): value is RecordLike =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as RecordLike).id === 'string' &&
  !!(value as RecordLike).data &&
  typeof (value as RecordLike).data === 'object' &&
  !!(value as RecordLike).meta &&
  typeof (value as RecordLike).meta === 'object';

/** The records a run returned, when it returned a page or a found object. */
export function recordsOf(result: unknown): RecordLike[] | null {
  if (!result || typeof result !== 'object') return null;

  const value = result as { data?: unknown; status?: unknown };

  if (Array.isArray(value.data) && value.data.every(isRecord))
    return value.data;

  if (value.status === 'ok' && isRecord(value)) return [value];

  return null;
}

/**
 * The object type of the records a run returned: the latest read that returned
 * the first of them. Null when no read did, so headers are untyped rather than
 * typed from another object.
 */
export function resultObjectOf(run: PlaygroundRun): string | null {
  const first =
    run.status === 'succeeded' ? recordsOf(run.result)?.[0]?.id : undefined;

  if (first === undefined) return null;

  return (
    [...run.reads].reverse().find((read) => read.ids.includes(first))?.object ??
    null
  );
}

const numeric = new Set(['int32', 'int64', 'float64', 'number']);

function display(value: unknown, type: string | undefined): string {
  if (typeof value === 'string')
    return type === 'timestamp'
      ? value.replace('T', ' ').replace(/\.000Z$/, 'Z')
      : value;

  return JSON.stringify(value);
}

function RecordTable(props: {
  readonly records: readonly RecordLike[];
  readonly object: PlaygroundObject | undefined;
  readonly selected: { row: number; column: string } | null;
  readonly onSelect: (cell: { row: number; column: string }) => void;
}) {
  const columns: string[] = [];

  for (const record of props.records)
    for (const name of [
      ...Object.keys(record.data),
      ...Object.keys(record.meta.fields ?? {}),
    ])
      if (!columns.includes(name)) columns.push(name);

  const computed = props.records[0]?.meta.computed ?? {};
  const typeOf = (column: string) => {
    if (computed[column]?.type) return computed[column].type;

    const property = props.object?.properties.find((p) => p.name === column);

    return property ? propertyType(property).replace(/\?$/, '') : undefined;
  };
  const isComputedColumn = (column: string) => {
    const property = props.object?.properties.find((p) => p.name === column);

    return (
      column in computed || (property !== undefined && isComputed(property))
    );
  };

  return (
    <div className="pg-table-wrap">
      <table className="pg-table">
        <thead>
          <tr>
            <th className="pg-rowhead">id</th>
            {columns.map((column) => {
              const type = typeOf(column);

              return (
                <th
                  key={column}
                  className={numeric.has(type ?? '') ? 'pg-numeric' : undefined}
                >
                  <span className="pg-column-name">{column}</span>
                  {type && (
                    <span
                      className={`pg-column-type${isComputedColumn(column) ? ' pg-computed' : ''}`}
                    >
                      {type}
                      {computed[column]?.nullable ? '?' : ''}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {props.records.map((record, row) => (
            <tr key={`${record.id}-${row}`}>
              <th scope="row" className="pg-rowhead">
                <span className="pg-id">{record.id}</span>
                {record.meta.completeness === 'partial' && (
                  <span className="pg-partial" title="completeness: partial">
                    partial
                  </span>
                )}
              </th>
              {columns.map((column) => {
                const type = typeOf(column);
                const status = record.meta.fields?.[column]?.status;
                const isSelected =
                  props.selected?.row === row &&
                  props.selected.column === column;

                return (
                  <td
                    key={column}
                    className={
                      numeric.has(type ?? '') ? 'pg-numeric' : undefined
                    }
                  >
                    <button
                      type="button"
                      className={`pg-cell${isSelected ? ' selected' : ''}`}
                      onClick={() => props.onSelect({ row, column })}
                    >
                      {!(column in record.data) ? (
                        <span
                          className={`pg-chip pg-chip-${status ?? 'unavailable'}`}
                        >
                          {status ?? 'unavailable'}
                        </span>
                      ) : record.data[column] === null ? (
                        <span className="pg-null">null</span>
                      ) : (
                        display(record.data[column], type)
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlainTable(props: {
  readonly rows: readonly Record<string, unknown>[];
}) {
  const columns = [...new Set(props.rows.flatMap((row) => Object.keys(row)))];

  return (
    <div className="pg-table-wrap">
      <table className="pg-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>
                <span className="pg-column-name">{column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column}
                  className={
                    typeof row[column] === 'number' ? 'pg-numeric' : undefined
                  }
                >
                  <span className="pg-cell">
                    {row[column] === null ? (
                      <span className="pg-null">null</span>
                    ) : row[column] === undefined ? (
                      ''
                    ) : typeof row[column] === 'string' ? (
                      (row[column] as string)
                    ) : (
                      JSON.stringify(row[column])
                    )}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Evidence(props: {
  readonly record: RecordLike;
  readonly column: string;
  readonly onClose: () => void;
}) {
  const evidence = props.record.meta.fields?.[props.column];
  const computed = props.record.meta.computed?.[props.column];
  const name = props.record.data['name'];

  return (
    <aside className="pg-evidence" aria-label="Field evidence">
      <div className="pg-evidence-head">
        <div>
          <div className="pg-evidence-title">
            <code>{props.column}</code> on{' '}
            {typeof name === 'string' ? name : props.record.id}
          </div>
          <div className="pg-evidence-path">meta.fields.{props.column}</div>
        </div>
        <button
          type="button"
          className="icon-button icon-button-sm"
          aria-label="Close evidence"
          onClick={props.onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      {computed && (
        <>
          <div className="pg-evidence-label">meta.computed.{props.column}</div>
          <pre className="pg-json">{JSON.stringify(computed, null, 2)}</pre>
        </>
      )}
      <div className="pg-evidence-label">Evidence</div>
      {evidence ? (
        <pre className="pg-json">{JSON.stringify(evidence, null, 2)}</pre>
      ) : (
        <p className="pg-evidence-note">
          Compact evidence lists only exceptional fields. Pass{' '}
          <code>evidence: 'full'</code> to see every field&apos;s evidence.
        </p>
      )}
    </aside>
  );
}

export type ResultView = 'table' | 'json' | 'console';

export type RunState =
  | { readonly state: 'idle' }
  | { readonly state: 'running'; readonly principal: string }
  | { readonly state: 'done'; readonly run: PlaygroundRun }
  | { readonly state: 'refused'; readonly error: string };

export const Results = memo(function Results(props: {
  readonly run: RunState;
  readonly object: PlaygroundObject | undefined;
  readonly onCancel: () => void;
}) {
  const [view, setView] = useState<ResultView>('table');
  const [selected, setSelected] = useState<{
    row: number;
    column: string;
  } | null>(null);
  const done = props.run.state === 'done' ? props.run.run : null;

  // A new run has new records; a selection from the last one means nothing.
  useEffect(() => setSelected(null), [done?.requestId]);
  const logs = done?.logs ?? [];
  const records = done?.status === 'succeeded' ? recordsOf(done.result) : null;
  const rows =
    done?.status === 'succeeded' &&
    Array.isArray(done.result) &&
    done.result.length > 0 &&
    done.result.every(
      (row) => row && typeof row === 'object' && !Array.isArray(row),
    )
      ? (done.result as Record<string, unknown>[])
      : null;
  const evidenceRecord =
    selected && records ? records[selected.row] : undefined;

  let body;

  if (props.run.state === 'idle')
    body = (
      <div className="pg-empty">
        <p>Run the code to see what this principal gets back.</p>
        <p className="pg-muted">
          <kbd>⌘</kbd>
          <kbd>↵</kbd> runs · <kbd>Ctrl</kbd>
          <kbd>Space</kbd> suggests
        </p>
      </div>
    );
  else if (props.run.state === 'running')
    body = (
      <div className="pg-empty">
        <p>Running as {props.run.principal}…</p>
        <button
          type="button"
          className="button button-ghost"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    );
  else if (props.run.state === 'refused')
    body = (
      <div className="pg-failure">
        <div className="pg-failure-title">The run did not start</div>
        <p>{props.run.error}</p>
      </div>
    );
  else if (view === 'console')
    body = logs.length ? (
      <pre className="pg-console">
        {logs.map((log, index) => (
          <span key={index} className={log.stream}>
            {log.text}
          </span>
        ))}
      </pre>
    ) : (
      <div className="pg-empty pg-muted">Nothing logged.</div>
    );
  else if (done?.status === 'failed')
    body = (
      <div className="pg-failure">
        <div className="pg-failure-title">
          {done.error.code ?? done.error.name}
        </div>
        <p className="pg-failure-message">{done.error.message}</p>
        {done.errors.length > 0 && (
          <table className="pg-issues">
            <thead>
              <tr>
                <th>Operation</th>
                <th>Path</th>
                <th>Problem</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {done.errors.flatMap((error, e) =>
                error.issues.map((issue, i) => (
                  <tr key={`${e}-${i}`}>
                    <td>
                      <code>{error.operation}</code>
                    </td>
                    <td>
                      <code>{issue.path.join('.') || '—'}</code>
                    </td>
                    <td>
                      <Tag color="red">{issue.problem}</Tag>
                    </td>
                    <td>{issue.message}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        )}
      </div>
    );
  else if (view === 'table' && records)
    body = records.length ? (
      <RecordTable
        records={records}
        object={props.object}
        selected={selected}
        onSelect={setSelected}
      />
    ) : (
      <div className="pg-empty pg-muted">No records.</div>
    );
  else if (view === 'table' && rows) body = <PlainTable rows={rows} />;
  else
    body = (
      <pre className="pg-json">
        {done?.status === 'succeeded'
          ? (JSON.stringify(done.result, null, 2) ?? 'undefined')
          : ''}
      </pre>
    );

  const partial =
    records?.filter((record) => record.meta.completeness === 'partial')
      .length ?? 0;

  return (
    <section className="pg-results" aria-label="Results">
      <div className="pg-results-head">
        <div className="pg-views" role="tablist" aria-label="Result view">
          {(['table', 'json', 'console'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={view === name}
              className={`pg-view${view === name ? ' active' : ''}`}
              onClick={() => setView(name)}
            >
              {name === 'table'
                ? 'Table'
                : name === 'json'
                  ? 'JSON'
                  : 'Console'}
              {name === 'console' && logs.length > 0 && (
                <span className="pg-count">{logs.length}</span>
              )}
            </button>
          ))}
        </div>
        {done && (
          <div className="pg-summary">
            {records && (
              <Tag color="gray">
                {records.length} record{records.length === 1 ? '' : 's'}
              </Tag>
            )}
            {partial > 0 && (
              <Tag
                color="amber"
                title="At least one field was omitted on these records"
              >
                {partial} partial
              </Tag>
            )}
            {done.status === 'failed' && <Tag color="red">failed</Tag>}
            <span className="pg-muted">
              {Math.round(done.ms)} ms · as {done.principal}
            </span>
            <Link
              to="/activity"
              search={{ request: done.requestId }}
              className="pg-activity-link"
            >
              Activity
            </Link>
          </div>
        )}
      </div>
      <div className="pg-results-body">
        <div className="pg-results-main">{body}</div>
        {evidenceRecord && selected && view === 'table' && (
          <Evidence
            record={evidenceRecord}
            column={selected.column}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </section>
  );
});
