import type { AnalyticalScalar, ComputedResultType } from 'relate/analytics';

/** Backend suites reuse these expected encodings; no driver dependencies here. */
export const scalarCases: readonly {
  name: string;
  result: ComputedResultType;
  input: string | number | bigint | boolean | null;
  json: AnalyticalScalar;
}[] = [
  {
    name: 'boolean',
    result: { type: 'boolean', nullable: false },
    input: true,
    json: true,
  },
  {
    name: 'string',
    result: { type: 'string', nullable: false },
    input: 'Acme',
    json: 'Acme',
  },
  {
    name: 'int32 minimum',
    result: { type: 'int32', nullable: false },
    input: -2147483648n,
    json: -2147483648,
  },
  {
    name: 'int32 maximum',
    result: { type: 'int32', nullable: false },
    input: 2147483647,
    json: 2147483647,
  },
  {
    name: 'zero count',
    result: { type: 'int64', nullable: false },
    input: 0n,
    json: '0',
  },
  {
    name: 'wide count',
    result: { type: 'int64', nullable: false },
    input: 9007199254740993n,
    json: '9007199254740993',
  },
  {
    name: 'int64 minimum',
    result: { type: 'int64', nullable: false },
    input: '-9223372036854775808',
    json: '-9223372036854775808',
  },
  {
    name: 'int64 maximum',
    result: { type: 'int64', nullable: false },
    input: 9223372036854775807n,
    json: '9223372036854775807',
  },
  {
    name: 'average',
    result: { type: 'float64', nullable: true },
    input: 1.5,
    json: 1.5,
  },
  {
    name: 'millisecond instant',
    result: { type: 'timestamp', precision: 3, nullable: true },
    input: '2026-10-09T10:30:00.123Z',
    json: '2026-10-09T10:30:00.123Z',
  },
  {
    name: 'microsecond instant',
    result: { type: 'timestamp', precision: 6, nullable: true },
    input: '2026-10-09T10:30:00.123456Z',
    json: '2026-10-09T10:30:00.123456Z',
  },
  {
    name: 'calendar date',
    result: { type: 'date', nullable: false },
    input: '2024-02-29',
    json: '2024-02-29',
  },
  {
    name: 'year-zero date',
    result: { type: 'date', nullable: true },
    input: '0000-01-01',
    json: '0000-01-01',
  },
  ...(['boolean', 'string', 'int32', 'int64', 'float64', 'date'] as const).map(
    (type) => ({
      name: `null ${type}`,
      result: { type, nullable: true },
      input: null,
      json: null,
    }),
  ),
  {
    name: 'null timestamp',
    result: { type: 'timestamp', precision: 6, nullable: true },
    input: null,
    json: null,
  },
];
