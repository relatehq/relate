import {
  siDuckdb,
  siPostgresql,
  siSalesforce,
  siSqlite,
  siStripe,
} from 'simple-icons';
import type { SimpleIcon } from 'simple-icons';

/** Brand logos (Simple Icons, CC0) for the systems Relate ships connectors for. */
const systems = {
  stripe: siStripe,
  postgres: siPostgresql,
  sqlite: siSqlite,
  duckdb: siDuckdb,
  salesforce: siSalesforce,
} as const satisfies Record<string, SimpleIcon>;

export type SystemName = keyof typeof systems;

export function isSystemName(value: string): value is SystemName {
  return Object.hasOwn(systems, value);
}

export function systemTitle(system: SystemName): string {
  return systems[system].title;
}

/** One system's logo in its brand color, sized for the node's icon tab. */
export function SystemLogo(props: {
  readonly system: SystemName;
  readonly size?: number;
}) {
  const icon = systems[props.system];
  const size = props.size ?? 12;
  // DuckDB's mark is a black disk with a yellow head and bill cut out of it;
  // brand yellow on a light tile would vanish.
  const duck = props.system === 'duckdb';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={duck ? '#000' : `#${icon.hex}`}
      aria-hidden="true"
    >
      {duck && <circle cx="12" cy="12" r="11" fill={`#${icon.hex}`} />}
      <path d={icon.path} />
    </svg>
  );
}
