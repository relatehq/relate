import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import {
  applyEvent,
  failureDefinitionIds,
  failureOrigin,
  initialState,
  markStale,
} from '../src/connection/store.js';
import type { InspectorState } from '../src/connection/store.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { DevEvent, Diagnostic, ModelSnapshot } from '../src/protocol.js';
import { graph } from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

const compiled = compile(graph);
const snapshotModel = (generation: number): ModelSnapshot => ({
  generation,
  definitionRevision: compiled.definitionRevision,
  manifest: compiled.manifest,
});
const envelope = (sequence: number, instanceId = 'i1') => ({
  protocolVersion: PROTOCOL_VERSION,
  instanceId,
  sequence,
});
const diff = {
  objects: { added: [], changed: [], removed: [] },
  relationships: { added: [], changed: [], removed: [] },
  otherChanged: false,
};
const compileIssue: Diagnostic = {
  kind: 'compile',
  severity: 'error',
  code: 'policy.unknown-role',
  message: 'bad role',
  definitionId: 'business.invoice',
};
const workerCrash: Diagnostic = {
  kind: 'worker',
  severity: 'error',
  code: 'worker.crash',
  message: 'exited with code 1',
};

function live(): InspectorState {
  return applyEvent(initialState, {
    ...envelope(5),
    type: 'snapshot',
    model: snapshotModel(3),
    failure: null,
  }).state;
}

it('starts from a snapshot and applies in-order events', () => {
  const state = live();

  expect(state).toMatchObject({
    connection: 'live',
    instanceId: 'i1',
    sequence: 5,
    model: { generation: 3 },
    failure: null,
  });

  const failed = applyEvent(state, {
    ...envelope(6),
    type: 'diagnostics',
    attempt: 4,
    diagnostics: [compileIssue],
  });

  expect(failed.outcome).toBe('applied');
  expect(failed.state.model?.generation).toBe(3);
  expect(failed.state.failure).toEqual({
    attempt: 4,
    diagnostics: [compileIssue],
  });
  expect(failureDefinitionIds(failed.state.failure)).toEqual([
    'business.invoice',
  ]);
  expect(failureOrigin(failed.state.failure)).toBe('code');

  const recovered = applyEvent(failed.state, {
    ...envelope(7),
    type: 'model',
    model: snapshotModel(4),
    fromGeneration: 3,
    diff,
    durationMs: 58,
  });

  expect(recovered.outcome).toBe('applied');
  expect(recovered.state.failure).toBeNull();
  expect(recovered.state.model?.generation).toBe(4);
  expect(recovered.state.lastUpdate).toEqual({
    generation: 4,
    fromGeneration: 3,
    diff,
    durationMs: 58,
  });
});

it('ignores duplicates, reports gaps and treats another instance as a gap', () => {
  const state = live();
  const duplicate: DevEvent = {
    ...envelope(5),
    type: 'diagnostics',
    attempt: 9,
    diagnostics: [compileIssue],
  };

  expect(applyEvent(state, duplicate)).toEqual({ state, outcome: 'duplicate' });
  expect(applyEvent(state, { ...duplicate, sequence: 7 }).outcome).toBe('gap');
  expect(
    applyEvent(state, { ...duplicate, sequence: 6, instanceId: 'i2' }).outcome,
  ).toBe('gap');
  expect(applyEvent(initialState, { ...duplicate, sequence: 1 }).outcome).toBe(
    'gap',
  );
});

it('never restores an older model or attempt over a newer accepted one', () => {
  const state = live();
  const stale = applyEvent(state, {
    ...envelope(6),
    type: 'model',
    model: snapshotModel(2),
    fromGeneration: 1,
    diff,
    durationMs: 10,
  });

  expect(stale.outcome).toBe('ignored');
  expect(stale.state.model?.generation).toBe(3);
  expect(stale.state.sequence).toBe(6);

  const failed = applyEvent(stale.state, {
    ...envelope(7),
    type: 'diagnostics',
    attempt: 8,
    diagnostics: [workerCrash],
  }).state;
  const older = applyEvent(failed, {
    ...envelope(8),
    type: 'diagnostics',
    attempt: 7,
    diagnostics: [compileIssue],
  });

  expect(older.outcome).toBe('ignored');
  expect(older.state.failure?.attempt).toBe(8);
  expect(failureOrigin(older.state.failure)).toBe('loader');
});

it('keeps type warnings across successful attempts and replaces them only by newer revisions', () => {
  const typeWarning: Diagnostic = {
    kind: 'type',
    severity: 'warning',
    code: 'ts.2322',
    message: 'mismatch',
  };
  let state = applyEvent(live(), {
    ...envelope(6),
    type: 'typecheck',
    revision: 2,
    diagnostics: [typeWarning],
  }).state;

  state = applyEvent(state, {
    ...envelope(7),
    type: 'model',
    model: snapshotModel(4),
    fromGeneration: 3,
    diff,
    durationMs: 5,
  }).state;
  expect(state.typecheck?.diagnostics).toEqual([typeWarning]);

  const older = applyEvent(state, {
    ...envelope(8),
    type: 'typecheck',
    revision: 1,
    diagnostics: [],
  });

  expect(older.outcome).toBe('ignored');
  expect(older.state.typecheck?.revision).toBe(2);

  const cleared = applyEvent(older.state, {
    ...envelope(9),
    type: 'typecheck',
    revision: 3,
    diagnostics: [],
  });

  expect(cleared.state.typecheck).toEqual({ revision: 3, diagnostics: [] });
});

it('rejects warnings inside failures and resets on a new instance snapshot', () => {
  expect(() =>
    applyEvent(live(), {
      ...envelope(6),
      type: 'diagnostics',
      attempt: 4,
      diagnostics: [{ ...compileIssue, severity: 'warning' }],
    }),
  ).toThrow(/must be errors/);

  const restarted = applyEvent(markStale(live(), 'session'), {
    ...envelope(0, 'i2'),
    type: 'snapshot',
    model: null,
    failure: { attempt: 1, diagnostics: [compileIssue] },
  }).state;

  expect(restarted).toMatchObject({
    connection: 'live',
    staleReason: null,
    instanceId: 'i2',
    sequence: 0,
    model: null,
    failure: { attempt: 1 },
    lastUpdate: null,
  });
});
