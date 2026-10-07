import { expect, it } from 'vitest';
import { LinePrefixer, streamPrefix } from '@relate/cli';

function collect(
  options: { maxLineBytes?: number; saturated?: () => boolean } = {},
) {
  const lines: string[] = [];
  const prefixer = new LinePrefixer({
    prefix: streamPrefix(5, 'stdout'),
    write: (line) => {
      lines.push(line);
    },
    ...(options.maxLineBytes !== undefined
      ? { maxLineBytes: options.maxLineBytes }
      : {}),
    ...(options.saturated ? { isSaturated: options.saturated } : {}),
  });

  return { lines, prefixer };
}

it('prefixes every line and reassembles lines split across chunks', () => {
  const { lines, prefixer } = collect();

  prefixer.push(Buffer.from('Loading cust'));
  prefixer.push(Buffer.from('omer definitions\nSecond line\r\nthird'));
  expect(lines).toEqual([
    '[app attempt 5 stdout] Loading customer definitions',
    '[app attempt 5 stdout] Second line',
  ]);
  prefixer.end();
  expect(lines[2]).toBe('[app attempt 5 stdout] third');
});

it('decodes UTF-8 split across chunk boundaries', () => {
  const { lines, prefixer } = collect();
  const bytes = Buffer.from('café ✓\n');

  prefixer.push(bytes.subarray(0, 4));
  prefixer.push(bytes.subarray(4, 7));
  prefixer.push(bytes.subarray(7));
  expect(lines).toEqual(['[app attempt 5 stdout] café ✓']);
});

it('truncates overlong lines explicitly instead of growing without bound', () => {
  const { lines, prefixer } = collect({ maxLineBytes: 16 });

  prefixer.push('a'.repeat(10));
  prefixer.push('b'.repeat(10));
  prefixer.push('c'.repeat(10));
  prefixer.push('\nshort\n');
  expect(lines).toEqual([
    `[app attempt 5 stdout] ${'a'.repeat(10)}${'b'.repeat(6)} …(+14 bytes truncated)`,
    '[app attempt 5 stdout] short',
  ]);
});

it('counts lines dropped while the sink is saturated and reports them once', () => {
  let saturated = false;
  const { lines, prefixer } = collect({ saturated: () => saturated });

  prefixer.push('one\n');
  saturated = true;
  prefixer.push('two\nthree\n');
  expect(prefixer.droppedLines).toBe(2);
  saturated = false;
  prefixer.push('four\n');
  expect(lines).toEqual([
    '[app attempt 5 stdout] one',
    '[app attempt 5 stdout] …(2 lines dropped while output was saturated)',
    '[app attempt 5 stdout] four',
  ]);
  expect(prefixer.droppedLines).toBe(0);
});

it('never turns JSON-looking output into anything but a prefixed line', () => {
  const { lines, prefixer } = collect();

  prefixer.push('{"type":"model","manifest":{}}\n');
  expect(lines).toEqual([
    '[app attempt 5 stdout] {"type":"model","manifest":{}}',
  ]);
});
