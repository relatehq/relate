import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import {
  PROTOCOL_VERSION,
  ProtocolError,
  assertFailureSeverity,
  diagnosticOrigin,
  parseDevEvent,
  readProtocolVersion,
} from '../src/protocol.js';
import type { DevEvent, Diagnostic } from '../src/protocol.js';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph } = createInvoiceGraph();

const model = compile(graph);
const envelope = { protocolVersion: PROTOCOL_VERSION, instanceId: 'i1' };

const compileDiagnostic: Diagnostic = {
  kind: 'compile',
  severity: 'error',
  code: 'policy.unknown-role',
  message: "Unknown policy role 'finanse' in policy Invoice.read",
  definitionId: 'business.invoice',
  path: { root: 'graph', segments: ['policies', 'Invoice', 'read', 'gate'] },
  site: {
    file: 'src/relate/graph.ts',
    line: 24,
    column: 22,
    precision: 'declaration',
  },
};

it('validates snapshot, model, diagnostics and typecheck events round-tripped through JSON', () => {
  const events: DevEvent[] = [
    {
      ...envelope,
      sequence: 0,
      type: 'snapshot',
      model: {
        generation: 1,
        definitionRevision: model.definitionRevision,
        manifest: model.manifest,
      },
      failure: null,
    },
    {
      ...envelope,
      sequence: 1,
      type: 'model',
      model: {
        generation: 2,
        definitionRevision: model.definitionRevision,
        manifest: model.manifest,
      },
      fromGeneration: 1,
      diff: {
        objects: { added: [], changed: ['business.customer'], removed: [] },
        relationships: { added: [], changed: [], removed: [] },
        otherChanged: false,
      },
      durationMs: 61,
    },
    {
      ...envelope,
      sequence: 2,
      type: 'diagnostics',
      attempt: 3,
      diagnostics: [
        compileDiagnostic,
        {
          kind: 'worker',
          severity: 'error',
          code: 'worker.timeout',
          message: 'Application evaluation exceeded 30000 ms',
        },
      ],
    },
    {
      ...envelope,
      sequence: 3,
      type: 'typecheck',
      revision: 4,
      diagnostics: [
        {
          kind: 'type',
          severity: 'warning',
          code: 'ts.2322',
          message: "Type 'number' is not assignable to type 'string'.",
          site: {
            file: 'src/relate/objects.ts',
            line: 3,
            column: 5,
            precision: 'expression',
          },
          frame: {
            file: 'src/relate/objects.ts',
            line: 3,
            column: 5,
            precision: 'expression',
            excerpt: '  name: 1,',
          },
        },
      ],
    },
    {
      ...envelope,
      sequence: 4,
      type: 'snapshot',
      model: null,
      failure: { attempt: 1, diagnostics: [compileDiagnostic] },
      typecheck: { revision: 0, diagnostics: [] },
    },
  ];

  for (const event of events)
    expect(parseDevEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
});

it('rejects unsupported protocol versions before decoding the payload', () => {
  expect(readProtocolVersion({ protocolVersion: 2 })).toBe(2);
  expect(readProtocolVersion(null)).toBeUndefined();

  for (const input of [
    { protocolVersion: 2, type: 'snapshot' },
    { type: 'snapshot' },
    'text',
  ]) {
    let caught: unknown;

    try {
      parseDevEvent(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).reason).toBe('unsupported-version');
  }
});

it('rejects malformed events from a compatible supervisor as invalid, not as upgrades', () => {
  const cases: unknown[] = [
    { ...envelope, sequence: 1, type: 'model' },
    { ...envelope, sequence: -1, type: 'snapshot', model: null, failure: null },
    {
      ...envelope,
      sequence: 1,
      type: 'snapshot',
      model: {
        generation: 0,
        definitionRevision: 'x',
        manifest: model.manifest,
      },
      failure: null,
    },
    {
      ...envelope,
      sequence: 1,
      type: 'diagnostics',
      attempt: 1,
      diagnostics: [{ kind: 'compile', message: 'no code', severity: 'error' }],
    },
    {
      ...envelope,
      sequence: 1,
      type: 'diagnostics',
      attempt: 1,
      diagnostics: [
        {
          kind: 'other',
          code: 'x',
          message: 'unknown kind',
          severity: 'error',
        },
      ],
    },
    {
      ...envelope,
      sequence: 1,
      type: 'snapshot',
      model: null,
      failure: null,
      extra: true,
    },
  ];

  for (const input of cases) {
    let caught: unknown;

    try {
      parseDevEvent(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProtocolError);
    expect((caught as ProtocolError).reason).toBe('invalid');
  }
});

it('requires error severity for failure diagnostics and classifies loader failures', () => {
  expect(() => assertFailureSeverity([compileDiagnostic])).not.toThrow();
  expect(() =>
    assertFailureSeverity([{ ...compileDiagnostic, severity: 'warning' }]),
  ).toThrow(/must be errors/);
  expect(diagnosticOrigin({ kind: 'worker' })).toBe('loader');
  expect(diagnosticOrigin({ kind: 'layout' })).toBe('layout');

  for (const kind of ['compile', 'syntax', 'import', 'type'] as const)
    expect(diagnosticOrigin({ kind })).toBe('code');
});
