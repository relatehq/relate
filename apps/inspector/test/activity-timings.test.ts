import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AnalyticalTimings } from '../src/screens/ActivityScreen.js';
import type { OperationEvent } from '../src/protocol.js';

it('renders summed stage work beside elapsed time without inventing unentered stages', () => {
  const operation = {
    ms: 10,
    runtime: {
      analytical: {
        stages: {
          dependencyReads: { count: 2, totalMs: 15, maxMs: 9 },
          execution: { count: 1, totalMs: 4.5, maxMs: 4.5 },
        },
      },
    },
  } as OperationEvent;
  const html = renderToStaticMarkup(
    createElement(AnalyticalTimings, { operation }),
  );

  expect(html).toContain('Elapsed: 10 ms');
  expect(html).toContain('Summed work durations overlap');
  expect(html).toContain('15.00 ms');
  expect(html).toContain('4.50 ms');
  expect(html).toContain('Dependency reads');
  expect(html).not.toContain('Connection startup');
  expect(
    renderToStaticMarkup(
      createElement(AnalyticalTimings, { operation: {} as OperationEvent }),
    ),
  ).toBe('');
});
