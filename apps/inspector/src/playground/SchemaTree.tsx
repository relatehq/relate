/**
 * Every object the principal can see, collapsed, with a search over object and
 * field names. The object the cursor's query uses opens and is marked; any
 * object can be opened by hand. Clicking a field inserts its name.
 */
import { memo, useState } from 'react';
import type { ReactNode } from 'react';
import type { PlaygroundDiscovery } from '../protocol.js';
import { Icon } from '../icons.js';
import {
  columnType,
  datasetsOf,
  isComputed,
  objectNames,
  propertyType,
} from './model.js';

function Highlighted(props: { readonly text: string; readonly query: string }) {
  const index = props.query
    ? props.text.toLowerCase().indexOf(props.query)
    : -1;

  if (index < 0) return <>{props.text}</>;

  return (
    <>
      {props.text.slice(0, index)}
      <mark>{props.text.slice(index, index + props.query.length)}</mark>
      {props.text.slice(index + props.query.length)}
    </>
  );
}

function Field(props: {
  readonly name: ReactNode;
  readonly type: string;
  readonly title?: string | undefined;
  readonly forbidden?: boolean;
  readonly onInsert: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`pg-field${props.forbidden ? ' forbidden' : ''}`}
        title={props.title}
        onClick={props.onInsert}
      >
        <span className="pg-field-name">{props.name}</span>
        <span className="pg-field-type">{props.type}</span>
      </button>
    </li>
  );
}

export const SchemaTree = memo(function SchemaTree(props: {
  readonly discovery: PlaygroundDiscovery | null;
  readonly loading: string | null;
  /** The object of the query at the cursor. */
  readonly focus: string | null;
  readonly onInsert: (text: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const { discovery } = props;
  const query = search.trim().toLowerCase();
  const hit = (name: string) =>
    query !== '' && name.toLowerCase().includes(query);
  const names = discovery ? objectNames(discovery) : [];

  const objects = names.flatMap((name) => {
    const object = discovery!.objects[name]!;
    const datasets = datasetsOf(object);
    const all = !query || hit(name);
    const properties = all
      ? object.properties
      : object.properties.filter((p) => hit(p.name));
    const shownDatasets = datasets
      .map((dataset) => ({
        dataset,
        columns:
          all || hit(dataset.name)
            ? dataset.columns
            : dataset.columns.filter((c) => hit(c.name)),
      }))
      .filter(
        ({ dataset, columns }) => all || hit(dataset.name) || columns.length,
      );

    if (!all && !properties.length && !shownDatasets.length) return [];

    const isFocus = name === props.focus;
    const open = query ? true : (toggled.get(name) ?? isFocus);

    return [
      <div key={name} className={`pg-object${isFocus ? ' focus' : ''}`}>
        <button
          type="button"
          className="pg-object-row"
          aria-expanded={open}
          title={object.description}
          onClick={() =>
            setToggled((current) => new Map(current).set(name, !open))
          }
        >
          <span className="pg-chevron">
            <Icon name="chevron-right" size={12} />
          </span>
          <span className="pg-object-name">
            <Highlighted text={name} query={query} />
          </span>
          {isFocus ? (
            <span className="pg-in-query">in query</span>
          ) : (
            <span className="pg-object-meta">
              {object.properties.length} fields
              {datasets.length
                ? ` · ${datasets.length} dataset${datasets.length > 1 ? 's' : ''}`
                : ''}
            </span>
          )}
        </button>
        {open && (
          <div className="pg-object-body">
            {properties.length > 0 && (
              <>
                <div className="pg-group">Properties</div>
                <ul className="pg-fields">
                  {properties.map((property) => (
                    <Field
                      key={property.name}
                      name={<Highlighted text={property.name} query={query} />}
                      type={`${propertyType(property)}${isComputed(property) ? ' · computed' : ''}`}
                      title={[
                        property.description,
                        property['readable'] === false
                          ? `Not readable as ${discovery!.principal}`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join('\n')}
                      forbidden={property['readable'] === false}
                      onInsert={() => props.onInsert(property.name)}
                    />
                  ))}
                </ul>
              </>
            )}
            {shownDatasets.length > 0 && (
              <>
                <div className="pg-group">Datasets</div>
                {shownDatasets.map(({ dataset, columns }) => (
                  <div key={dataset.name} className="pg-dataset">
                    <div className="pg-dataset-head">
                      <code>
                        self.
                        <Highlighted text={dataset.name} query={query} />
                      </code>
                    </div>
                    {dataset.description && (
                      <div className="pg-dataset-note">
                        {dataset.description}
                      </div>
                    )}
                    {dataset.correlation && (
                      <div className="pg-dataset-note pg-mono">
                        on {dataset.correlation}
                      </div>
                    )}
                    <ul className="pg-fields">
                      {columns.map((column) => (
                        <Field
                          key={column.name}
                          name={
                            <Highlighted text={column.name} query={query} />
                          }
                          type={columnType(column)}
                          title={[
                            column.description,
                            column.readable
                              ? undefined
                              : `Not readable as ${discovery!.principal}`,
                          ]
                            .filter(Boolean)
                            .join('\n')}
                          forbidden={!column.readable}
                          onInsert={() => props.onInsert(column.name)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>,
    ];
  });

  return (
    <aside className="pg-schema" aria-label="Objects">
      <div className="pg-schema-top">
        <div className="pg-schema-title">
          <span>Objects</span>
          {discovery && (
            <span className="pg-muted">
              {names.length} visible to {discovery.principal}
            </span>
          )}
        </div>
        <input
          type="search"
          className="pg-search"
          placeholder="Search objects and fields"
          aria-label="Search objects and fields"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="pg-objects">
        {props.loading !== null ? (
          <p className="pg-schema-note">{props.loading}</p>
        ) : discovery && names.length === 0 ? (
          <p className="pg-schema-note">
            {discovery.principal} cannot see any objects.
          </p>
        ) : objects.length ? (
          objects
        ) : (
          <p className="pg-schema-note">
            No objects or fields match “{search}”.
          </p>
        )}
      </div>
    </aside>
  );
});
