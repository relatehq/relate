import { describe, expect, it } from 'vitest';
import { delivery, fx, generateWorld, loaded } from '../src/world/generator.js';
import { catalogue, instantiate } from '../src/tasks/catalogue.js';
import { matches } from '../src/tasks/grading.js';

describe('world and intended workload', () => {
  it('reproduces truth across seeds and retains deferred tasks', () => {
    const first = generateWorld({ seed: 7, tier: 'S' }),
      second = generateWorld({ seed: 7, tier: 'S' });

    expect(first).toEqual(second);
    expect(generateWorld({ seed: 19, tier: 'S' })).not.toEqual(first);
    expect(catalogue).toHaveLength(80);
    expect(catalogue.filter((t) => t.pilot)).toHaveLength(20);
    expect(catalogue.filter((t) => t.status === 'deferred')).toHaveLength(14);

    for (const task of catalogue)
      expect(instantiate(task, first)).toEqual(instantiate(task, second));

    for (const task of catalogue.filter(
      (t) => t.kind === 'create' || (t.kind === 'refuse' && t.index >= 8),
    )) {
      const instance = instantiate(task, first);

      expect(instance.params.platform).toBe('tiktok');
      expect(
        first.lines.some(
          (line) =>
            line.linkedId === instance.params.campaignId &&
            line.flightEnd >= '2026-10-15',
        ),
      ).toBe(true);
    }

    expect(catalogue.find((t) => t.id === 'action.create-2')?.pilot).toBe(true);
  });
  it('keeps the warehouse incomplete and conversion rates complete, including identity/weekends', () => {
    const world = generateWorld({ seed: 7, tier: 'S' });
    let hidden = 0,
      shown = 0;

    for (const row of delivery(world))
      if (row.platform === 'tiktok' && row.date > '2026-10-12') {
        expect(loaded(row)).toBe(false);
        hidden++;
      } else if (loaded(row)) shown++;

    expect(hidden).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(150000);
    expect(fx('2026-10-11', 'GBP', 'GBP')).toBe(1);
    expect(
      fx('2026-10-11', 'GBP', 'USD') * fx('2026-10-11', 'USD', 'GBP'),
    ).toBeCloseTo(1);
  });
  it('rejects duplicate answers, non-finite numbers and excess fields', () => {
    expect(
      matches([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'a' }]),
    ).toBe(false);
    expect(matches({ spend: 100 }, { spend: NaN })).toBe(false);
    expect(
      matches({ status: 'ACTIVE' }, { status: 'ACTIVE', invented: true }),
    ).toBe(false);
    expect(
      matches([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]),
    ).toBe(true);
  });
});
