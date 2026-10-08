import { formatIssuePath } from 'relate/diagnostics';
import { failureOrigin } from '../connection/store.js';
import type { InspectorState } from '../connection/store.js';
import type { GraphModel } from '../graph/map.js';
import type { Diagnostic } from '../protocol.js';
import { Button, Callout, Tag } from '../ui.js';

export interface SidePanelProps {
  readonly state: InspectorState;
  readonly model: GraphModel | null;
  readonly selected: string | null;
  readonly highlights: {
    readonly nodes: ReadonlyMap<string, number>;
    readonly edges: ReadonlySet<string>;
  };
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}

/** The panel appears only when something needs it: a problem, a warning or a selection. */
export function panelNeeded(
  state: InspectorState,
  selected: string | null,
): boolean {
  return Boolean(
    state.failure ||
    (state.typecheck && state.typecheck.diagnostics.length > 0) ||
    state.layout ||
    selected,
  );
}

export function SidePanel(props: SidePanelProps) {
  const { state, model, selected, highlights } = props;
  const origin = failureOrigin(state.failure);
  const problems = state.failure?.diagnostics.length ?? 0;
  const typeWarnings = state.typecheck?.diagnostics ?? [];
  const generation = state.model?.generation ?? null;
  const header = state.failure
    ? origin === 'loader'
      ? {
          title: 'Loader failed',
          meta: `attempt ${state.failure.attempt}`,
          sub:
            generation === null
              ? 'No model has been published yet.'
              : `Showing the last good model, gen ${generation}.`,
        }
      : {
          title: `${problems} ${problems === 1 ? 'problem' : 'problems'}`,
          meta: `attempt ${state.failure.attempt}`,
          sub:
            generation === null
              ? 'No model has been published yet.'
              : `Attempt ${state.failure.attempt} failed. Showing the last good model, gen ${generation}.`,
        }
    : typeWarnings.length
      ? {
          title: `${typeWarnings.length} type ${typeWarnings.length === 1 ? 'error' : 'errors'}`,
          meta: `rev ${state.typecheck!.revision}`,
          sub: `Warnings. Gen ${generation ?? '?'} published; these do not block the graph.`,
        }
      : state.layout
        ? {
            title: 'Layout failed',
            meta: generation === null ? '' : `gen ${generation}`,
            sub: 'The model compiled; the previous placement is kept until layout succeeds.',
          }
        : selectionHeader(model, selected);

  return (
    <aside className="side-panel" aria-live="polite">
      <div className="side-panel-header">
        <div className="title-row">
          <span className="title">{header.title}</span>
          <span className="meta">{header.meta}</span>
          {selected && (
            <span className="close">
              <Button
                ariaLabel="Clear selection"
                title="Clear selection"
                onClick={props.onClose}
              >
                ×
              </Button>
            </span>
          )}
        </div>
        <span className="sub">{header.sub}</span>
      </div>
      <div className="side-panel-body">
        {state.failure && origin === 'loader' && (
          <LoaderFailure
            diagnostics={state.failure.diagnostics}
            attempt={state.failure.attempt}
          />
        )}
        {state.failure &&
          origin === 'code' &&
          state.failure.diagnostics.map((diagnostic, index) => (
            <Issue
              key={`failure-${index}`}
              diagnostic={diagnostic}
              highlights={highlights}
              onSelect={props.onSelect}
            />
          ))}
        {typeWarnings.length > 0 && state.failure && (
          <div className="section-label">
            Type errors (rev {state.typecheck!.revision})
          </div>
        )}
        {typeWarnings.map((diagnostic, index) => (
          <Issue
            key={`type-${index}`}
            diagnostic={diagnostic}
            highlights={highlights}
            onSelect={props.onSelect}
          />
        ))}
        {state.layout && <LayoutFailure diagnostic={state.layout} />}
        {selected && model && (
          <Selection
            model={model}
            selected={selected}
            withLabel={Boolean(
              state.failure || typeWarnings.length || state.layout,
            )}
          />
        )}
      </div>
    </aside>
  );
}

function selectionHeader(model: GraphModel | null, selected: string | null) {
  const node = model?.nodes.find((n) => n.id === selected);

  if (node)
    return { title: node.data.label, meta: node.id, sub: 'Selected object' };

  const edge = model?.edges.find((e) => e.id === selected);

  if (edge)
    return {
      title: edge.data.forward.name,
      meta: edge.id,
      sub: 'Selected relationship',
    };

  return { title: 'Nothing selected', meta: '', sub: '' };
}

function Issue(props: {
  readonly diagnostic: Diagnostic;
  readonly highlights: SidePanelProps['highlights'];
  readonly onSelect: (id: string) => void;
}) {
  const { diagnostic, highlights } = props;
  const definitionId =
    diagnostic.kind === 'compile' ? diagnostic.definitionId : undefined;
  const highlighted =
    definitionId !== undefined &&
    (highlights.nodes.has(definitionId) || highlights.edges.has(definitionId));
  const site = diagnostic.frame ?? diagnostic.site;
  const precision = site
    ? site.precision === 'expression'
      ? 'Exact expression'
      : diagnostic.kind === 'compile'
        ? `${subject(diagnostic)} declared here`
        : 'Reported location'
    : null;

  return (
    <div className={`issue issue-${diagnostic.severity}`}>
      <div className="issue-head">
        <span className="issue-dot" />
        <span className="issue-code">{diagnostic.code}</span>
        <span className="issue-kind">
          {diagnostic.kind}
          {diagnostic.severity === 'warning' ? ' · warning' : ''}
        </span>
      </div>
      <div className="issue-message">{diagnostic.message}</div>
      {diagnostic.kind === 'compile' && (diagnostic.path || definitionId) && (
        <dl className="detail-rows">
          {diagnostic.path && (
            <>
              <dt>{capitalize(diagnostic.path.root)} path</dt>
              <dd>
                {formatIssuePath(diagnostic.path).slice(
                  diagnostic.path.root.length + 1,
                )}
              </dd>
            </>
          )}
          {definitionId && (
            <>
              <dt>Definition</dt>
              <dd>
                {highlighted ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => props.onSelect(definitionId)}
                  >
                    {definitionId}
                  </button>
                ) : (
                  definitionId
                )}
              </dd>
            </>
          )}
        </dl>
      )}
      {diagnostic.frame && (
        <Frame
          excerpt={diagnostic.frame.excerpt}
          line={diagnostic.frame.line}
        />
      )}
      <div className="issue-foot">
        {site ? (
          <>
            <span className="link-button" title="Project-relative path">
              {site.file}:{site.line}:{site.column}
            </span>
            {precision && (
              <Tag color="gray" variant="outline">
                {precision}
              </Tag>
            )}
          </>
        ) : (
          <span className="unavailable">Source location unavailable</span>
        )}
      </div>
    </div>
  );
}

function Frame(props: { readonly excerpt: string; readonly line: number }) {
  const lines = props.excerpt.split('\n');

  // A single-line excerpt is the offending line itself.
  return (
    <pre className="issue-frame">
      {lines.map((text, index) => (
        <div
          key={index}
          className={`line${lines.length === 1 || index === Math.floor(lines.length / 2) ? ' marked' : ''}`}
        >
          <span className="number">
            {lines.length === 1
              ? props.line
              : props.line - Math.floor(lines.length / 2) + index}
          </span>
          <span>{text}</span>
        </div>
      ))}
    </pre>
  );
}

function LoaderFailure(props: {
  readonly diagnostics: readonly Diagnostic[];
  readonly attempt: number;
}) {
  const first = props.diagnostics[0]!;
  const timeout = first.code === 'worker.timeout';
  const title = timeout
    ? 'The definitions loader timed out'
    : first.code === 'worker.oom'
      ? 'The definitions loader ran out of memory'
      : 'The definitions loader crashed';

  return (
    <>
      <Callout
        variant="warning"
        title={title}
        description={`${first.message} This is a loader failure, not a problem found in your definitions.`}
      />
      <dl className="detail-rows facts">
        <dt>Code</dt>
        <dd>{first.code}</dd>
        <dt>Attempt</dt>
        <dd>{props.attempt}</dd>
      </dl>
      <div className="hint-list">
        {timeout ? (
          <>
            <span>
              Look for an unresolved top-level await or a long-running loop in
              an imported module. Saving again starts a fresh attempt.
            </span>
            <span>
              To allow more time: <code>relate dev --eval-timeout 60000</code>
            </span>
          </>
        ) : (
          <span>
            Check the terminal for the child&apos;s output. Saving again starts
            a fresh attempt.
          </span>
        )}
      </div>
    </>
  );
}

function LayoutFailure(props: { readonly diagnostic: Diagnostic }) {
  const unavailable = props.diagnostic.code === 'layout.worker-unavailable';

  return (
    <>
      <Callout
        variant="warning"
        title={
          unavailable ? 'The layout worker could not start' : 'Layout failed'
        }
        description="The model compiled. The graph keeps its previous placement until a layout succeeds."
        {...(unavailable
          ? {
              action: {
                label: 'Reload',
                onClick: () => window.location.reload(),
              },
            }
          : {})}
      />
      <dl className="detail-rows facts">
        <dt>Code</dt>
        <dd>{props.diagnostic.code}</dd>
        <dt>Engine</dt>
        <dd>ELK layered · worker</dd>
        <dt>Detail</dt>
        <dd>{props.diagnostic.message}</dd>
      </dl>
    </>
  );
}

function Selection(props: {
  readonly model: GraphModel;
  readonly selected: string;
  readonly withLabel: boolean;
}) {
  const { model, selected } = props;
  const node = model.nodes.find((n) => n.id === selected);
  const nameOf = (id: string) =>
    model.nodes.find((n) => n.id === id)?.data.label ?? id;

  if (node) {
    const related = model.edges.filter(
      (e) => e.source === node.id || e.target === node.id,
    );

    return (
      <>
        {props.withLabel && (
          <div className="section-label">Selected · {node.data.label}</div>
        )}
        <dl className="detail-rows facts">
          <dt>ID</dt>
          <dd>{node.id}</dd>
          <dt>API name</dt>
          <dd>{node.data.apiName}</dd>
          <dt>Plural</dt>
          <dd className="prose">{node.data.pluralLabel}</dd>
          <dt>Owner</dt>
          <dd className="prose">
            {node.data.ownership.kind === 'source' ? (
              <>
                Source · <code>{node.data.ownership.sourceId}</code>
              </>
            ) : (
              'Relate (native records)'
            )}
          </dd>
          {node.data.description && (
            <>
              <dt>About</dt>
              <dd className="prose">{node.data.description}</dd>
            </>
          )}
        </dl>
        <div className="section-label">Properties</div>
        <div className="property-list">
          {node.data.properties.map((property) => (
            <div
              key={property.id}
              className="row"
              title={`${property.id} · ${property.access}`}
            >
              <span className="name">
                {property.name}
                {property.access !== 'ordinary' ? ` · ${property.access}` : ''}
              </span>
              <span className="type">
                {property.origin === 'object-id'
                  ? `objectId · ${property.type}`
                  : property.target
                    ? `ref → ${nameOf(property.target)}`
                    : property.type}
              </span>
            </div>
          ))}
        </div>
        {related.length > 0 && (
          <div className="section-label">Relationships</div>
        )}
        {related.map((edge) => (
          <RelationshipCard key={edge.id} edge={edge} nameOf={nameOf} />
        ))}
      </>
    );
  }

  const edge = model.edges.find((e) => e.id === selected);

  if (!edge) return null;

  return (
    <>
      {props.withLabel && (
        <div className="section-label">Selected relationship</div>
      )}
      <RelationshipCard edge={edge} nameOf={nameOf} />
      <dl className="detail-rows facts">
        <dt>ID</dt>
        <dd>{edge.id}</dd>
        <dt>Via</dt>
        <dd>
          {nameOf(edge.target)}.{edge.data.viaProperty}
        </dd>
      </dl>
    </>
  );
}

function RelationshipCard(props: {
  readonly edge: GraphModel['edges'][number];
  readonly nameOf: (id: string) => string;
}) {
  const { edge, nameOf } = props;

  return (
    <div className="relationship-card">
      <span className="name">{edge.data.forward.name}</span>
      <span className="endpoints">
        {nameOf(edge.source)} → {nameOf(edge.target)} · one-to-many
      </span>
      <span className="traversals">
        forward {edge.data.forward.name} · reverse {edge.data.reverse.name}
      </span>
    </div>
  );
}

function subject(diagnostic: Diagnostic): string {
  const head =
    diagnostic.kind === 'compile' ? diagnostic.path?.segments[0] : undefined;

  switch (head) {
    case 'objects':
    case 'properties':
      return 'Object';
    case 'relationships':
      return 'Relationship';
    case 'actions':
      return 'Action';
    default:
      return 'Graph';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
