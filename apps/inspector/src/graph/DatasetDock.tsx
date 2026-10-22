import { createContext, use, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import type { DockedDataset } from './map.js';
import { SystemLogo, isSystemName } from './systems.js';
import { Icon } from '../icons.js';

/** Graph-wide state the docks need: a picked dataset is the selection. */
export const DockContext = createContext<{
  readonly selected: string | null;
  readonly issues: ReadonlyMap<string, number>;
  readonly onSelect: (id: string | null) => void;
}>({ selected: null, issues: new Map(), onSelect: () => {} });

// Matches the pill exit animation in styles.css.
const EXIT_MS = 120;

const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Open after a short pause and close after a longer one, so sweeping across a
 * card does not flash its dock and moving from card to pills does not flicker.
 */
export function useHoverIntent(enterMs = 60, leaveMs = 180) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const schedule = (next: boolean, ms: number) => () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), ms);
  };

  return {
    open,
    onMouseEnter: schedule(true, enterMs),
    onMouseLeave: schedule(false, leaveMs),
  };
}

/** Keep the fan mounted while its exit animation plays. */
function usePresence(visible: boolean) {
  const [rendered, setRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRendered(true);

      return;
    }

    const timer = window.setTimeout(
      () => setRendered(false),
      reducedMotion() ? 0 : EXIT_MS,
    );

    return () => window.clearTimeout(timer);
  }, [visible]);

  return { rendered: visible || rendered, exiting: !visible && rendered };
}

function DatasetLogo(props: { readonly system: string | undefined }) {
  return (
    <span className="dataset-dock-logo">
      {props.system && isSystemName(props.system) ? (
        <SystemLogo system={props.system} size={11} />
      ) : (
        <Icon name="database" size={11} />
      )}
    </span>
  );
}

/**
 * Datasets docked under an object card. At rest a count chip; `open` (hover)
 * fans out one pill per dataset; picking a pill selects the dataset, which
 * pins it open with its columns until the selection moves on.
 */
export function DatasetDock(props: {
  readonly docked: readonly DockedDataset[];
  readonly open: boolean;
}) {
  const { selected, issues, onSelect } = use(DockContext);
  const pinned = props.docked.some(({ dataset }) => dataset.id === selected);
  const broken = props.docked.some(({ dataset }) => issues.has(dataset.id));
  const fan = usePresence(props.open || pinned);
  const pick = (id: string | null) => (event: MouseEvent) => {
    // Keep the click from also selecting the object card underneath.
    event.stopPropagation();
    onSelect(id);
  };

  return (
    <div className="dataset-dock nodrag nopan">
      {fan.rendered ? (
        <div className={`dataset-dock-fan${fan.exiting ? ' closing' : ''}`}>
          {props.docked.map(({ dataset, association }, index) => {
            // Staggers each pill's entrance.
            const order = { '--dock-index': index } as CSSProperties;
            const keys = new Set(association.on.map((pair) => pair.column));
            const title = `${dataset.id} on ${association.on
              .map((pair) => `${pair.column} = ${pair.property}`)
              .join(', ')} · role ${association.role}`;

            return dataset.id === selected ? (
              <div
                key={association.id}
                className="dataset-dock-card"
                style={order}
              >
                <button
                  type="button"
                  className="dataset-dock-card-header"
                  title={title}
                  onClick={pick(null)}
                >
                  <span className="name">{dataset.label}</span>
                  <span className="caret">▾</span>
                </button>
                <div className="dataset-dock-columns">
                  {dataset.columns.map((column) => (
                    <div key={column.id} className="row" title={column.id}>
                      <span>{column.name}</span>
                      <span className="kind">
                        {keys.has(column.name) ? 'key' : column.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <button
                key={association.id}
                type="button"
                className={`dataset-dock-pill${
                  issues.has(dataset.id) ? ' highlighted' : ''
                }`}
                style={order}
                title={title}
                onClick={pick(dataset.id)}
              >
                <DatasetLogo system={dataset.system} />
                <span className="name">{dataset.label}</span>
                <span className="join">{[...keys].join(', ')}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className={`dataset-dock-chip${broken ? ' highlighted' : ''}`}>
          {props.docked.length}{' '}
          {props.docked.length === 1 ? 'dataset' : 'datasets'}
        </span>
      )}
    </div>
  );
}
