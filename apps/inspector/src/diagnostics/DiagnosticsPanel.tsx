import { formatIssuePath } from 'relate/diagnostics';
import { failureOrigin } from '../connection/store.js';
import type { Failure, Typecheck } from '../connection/store.js';
import type { Diagnostic } from '../protocol.js';

export interface DiagnosticsPanelProps {
  readonly failure: Failure | null;
  readonly typecheck: Typecheck | null;
  readonly layout: Diagnostic | null;
  readonly displayedGeneration: number | null;
  readonly highlights: {
    readonly nodes: ReadonlySet<string>;
    readonly edges: ReadonlySet<string>;
  };
  readonly onSelect: (id: string) => void;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const { failure, typecheck, layout, displayedGeneration, highlights } = props;
  const origin = failureOrigin(failure);
  const typeWarnings = typecheck?.diagnostics ?? [];

  if (!failure && typeWarnings.length === 0 && !layout) return null;

  return (
    <aside className="diagnostics" aria-live="polite">
      {failure && (
        <section
          className={`diagnostics-group diagnostics-${origin ?? 'code'}`}
          data-attempt={failure.attempt}
        >
          <h2>
            {origin === 'loader'
              ? 'The loader failed'
              : 'The authored code is invalid'}
            <small>
              attempt {failure.attempt} ·{' '}
              {displayedGeneration === null
                ? 'no model yet'
                : `keeping generation ${displayedGeneration}`}
            </small>
          </h2>
          {origin === 'loader' && (
            <p className="diagnostics-hint">
              This is not a mistake in your definitions: the process that loads
              them crashed, timed out or ran out of memory. Save again to retry.
            </p>
          )}
          <ul>
            {failure.diagnostics.map((diagnostic, index) => (
              <DiagnosticEntry
                key={index}
                diagnostic={diagnostic}
                highlights={highlights}
                onSelect={props.onSelect}
              />
            ))}
          </ul>
        </section>
      )}
      {typeWarnings.length > 0 && (
        <section className="diagnostics-group diagnostics-type">
          <h2>
            {typeWarnings.length} type{' '}
            {typeWarnings.length === 1 ? 'error' : 'errors'}
            <small>
              revision {typecheck!.revision} · model still published
            </small>
          </h2>
          <ul>
            {typeWarnings.map((diagnostic, index) => (
              <DiagnosticEntry
                key={index}
                diagnostic={diagnostic}
                highlights={highlights}
                onSelect={props.onSelect}
              />
            ))}
          </ul>
        </section>
      )}
      {layout && (
        <section className="diagnostics-group diagnostics-layout">
          <h2>
            Layout problem
            <small>local to this page; the model is fine</small>
          </h2>
          <ul>
            <DiagnosticEntry
              diagnostic={layout}
              highlights={highlights}
              onSelect={props.onSelect}
            />
          </ul>
          {layout.code === 'layout.worker-unavailable' && (
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </section>
      )}
    </aside>
  );
}

function DiagnosticEntry(props: {
  readonly diagnostic: Diagnostic;
  readonly highlights: DiagnosticsPanelProps['highlights'];
  readonly onSelect: (id: string) => void;
}) {
  const { diagnostic, highlights } = props;
  const definitionId =
    diagnostic.kind === 'compile' ? diagnostic.definitionId : undefined;
  const highlighted =
    definitionId !== undefined &&
    (highlights.nodes.has(definitionId) || highlights.edges.has(definitionId));
  const site = diagnostic.frame ?? diagnostic.site;

  return (
    <li className={`diagnostic diagnostic-${diagnostic.kind}`}>
      <div className="diagnostic-head">
        <code className="diagnostic-code">{diagnostic.code}</code>
        <span className={`severity severity-${diagnostic.severity}`}>
          {diagnostic.severity}
        </span>
      </div>
      <p className="diagnostic-message">{diagnostic.message}</p>
      <dl className="diagnostic-details">
        {diagnostic.kind === 'compile' && diagnostic.path && (
          <>
            <dt>Path</dt>
            <dd>
              <code>{formatIssuePath(diagnostic.path)}</code>
            </dd>
          </>
        )}
        {definitionId !== undefined && (
          <>
            <dt>Definition</dt>
            <dd>
              {highlighted ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => props.onSelect(definitionId)}
                >
                  <code>{definitionId}</code>
                </button>
              ) : (
                <>
                  <code>{definitionId}</code>{' '}
                  <small>not in the displayed graph</small>
                </>
              )}
            </dd>
          </>
        )}
        <dt>Source</dt>
        <dd>
          {site ? (
            <>
              <code className="source-location">
                {site.file}:{site.line}:{site.column}
              </code>{' '}
              <small>
                {site.precision === 'expression'
                  ? 'exact expression'
                  : diagnostic.kind === 'compile'
                    ? 'declared here'
                    : 'reported location'}
              </small>
            </>
          ) : (
            <small>location unavailable</small>
          )}
        </dd>
      </dl>
      {diagnostic.frame && (
        <pre className="diagnostic-frame">{diagnostic.frame.excerpt}</pre>
      )}
    </li>
  );
}
