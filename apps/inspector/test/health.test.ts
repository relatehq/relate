import { expect, it } from 'vitest';
import { healthOf } from '../src/health.js';
import type { RuntimeStatus } from '../src/protocol.js';

function runtime(
  state: RuntimeStatus['state'],
  definitionRevision: string | null = 'sha256:a',
): RuntimeStatus {
  return {
    state,
    runtimeId: 'runtime-1',
    generation: 1,
    definitionRevision,
    store: 'memory',
    dataReset: false,
    diagnostics: [],
  };
}

it('shows the connection first, because a disconnected page has a stale runtime state', () => {
  const running = runtime('running');

  expect(healthOf('unauthorized', running, 'sha256:a')).toEqual({
    color: 'red',
    label: 'No session',
  });
  expect(healthOf('reconnecting', running, 'sha256:a').label).toBe(
    'Reconnecting',
  );
  expect(healthOf('stale', running, 'sha256:a').label).toBe('Paused');
});

it('shows the runtime once the page is live', () => {
  expect(healthOf('live', runtime('running'), 'sha256:a')).toEqual({
    color: 'green',
    label: 'Live',
  });
  expect(healthOf('live', runtime('failed'), 'sha256:a').color).toBe('red');
  expect(healthOf('live', runtime('restarting'), 'sha256:a').label).toBe(
    'Restarting',
  );
  expect(healthOf('live', runtime('not-configured', null), 'sha256:a')).toEqual(
    { color: 'gray', label: 'No runtime' },
  );
});

it('says Updating while the runtime serves an older revision than the model', () => {
  expect(
    healthOf('live', runtime('running', 'sha256:old'), 'sha256:new'),
  ).toEqual({ color: 'orange', label: 'Updating' });
});

it('is live when the server reports no runtime yet', () => {
  expect(healthOf('live', null, null).label).toBe('Live');
});
