import { describe, expect, it } from 'vitest';
import { delivery, fx, generateWorld, loaded } from '../src/world/generator.js';
import { catalogue, instantiate, pacing } from '../src/tasks/catalogue.js';
import { matches } from '../src/tasks/grading.js';

describe('world and intended workload', () => {
  it('reproduces truth across seeds and runs every catalogued task', () => {
    const first = generateWorld({ seed: 7, tier: 'S' }),
      second = generateWorld({ seed: 7, tier: 'S' });

    expect(first).toEqual(second);
    expect(generateWorld({ seed: 19, tier: 'S' })).not.toEqual(first);
    expect(catalogue).toHaveLength(53);
    expect(catalogue.filter((t) => t.pilot)).toHaveLength(22);
    expect(catalogue.filter((t) => t.status === 'deferred')).toHaveLength(0);

    for (const task of catalogue)
      expect(instantiate(task, first)).toEqual(instantiate(task, second));

    for (const task of catalogue.filter((t) => t.kind === 'create')) {
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
  it('removes identifier, ownership and uniform-data shortcuts', () => {
    const world = generateWorld({ seed: 7, tier: 'S' });

    // IDs reveal neither the platform nor the owning client.
    for (const c of world.campaigns) {
      expect(c.id).not.toMatch(/meta|tiktok|ttd|google|campaign/);
      expect(c.accountId).not.toMatch(/account/);
    }

    // CRM merges leave plan links on deleted duplicates.
    const merged = world.clients.filter((c) => c.mergedIds.length);

    expect(merged.length).toBeGreaterThanOrEqual(2);
    expect(
      world.accounts.some((a) =>
        merged.some((c) => c.mergedIds.includes(a.linkedSfId)),
      ),
    ).toBe(true);

    // Drifting invoices and credit notes span every platform.
    const platformOf = (id: string) =>
      world.campaigns.find((c) => c.id === id)!.platform;

    expect(
      new Set(
        world.invoices
          .filter((i) => i.kind === 'credit')
          .map((i) => platformOf(i.campaignId)),
      ).size,
    ).toBeGreaterThan(2);
    expect(
      new Set(
        world.campaigns
          .filter((c) => c.status === 'ARCHIVED')
          .map((c) => c.platform),
      ).size,
    ).toBeGreaterThan(1);
    expect(world.campaigns.some((c) => c.flightEnd < '2026-10-15')).toBe(true);
    expect(
      world.campaigns.some(
        (c) =>
          world.campaigns.filter((o) => o.budgetId === c.budgetId).length > 1,
      ),
    ).toBe(true);

    // Freshness is per account, and pacing has both tails.
    expect(new Set(world.accounts.map((a) => a.loadedThrough)).size).toBe(4);
    const pcts = world.clients.flatMap((c) =>
      pacing(world, c.id).map((p) => p.pct),
    );

    expect(pcts.some((p) => p > 110)).toBe(true);
    expect(pcts.some((p) => p < 85)).toBe(true);
  });
  it('keeps the warehouse incomplete per account and rates that move day to day', () => {
    const world = generateWorld({ seed: 7, tier: 'S' });
    let hidden = 0,
      shown = 0;

    for (const row of delivery(world))
      if (row.date > row.loadedThrough) {
        expect(loaded(row)).toBe(false);
        hidden++;
      } else shown++;

    expect(hidden).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(150000);
    expect(fx('2026-10-11', 'GBP', 'GBP')).toBe(1);
    expect(
      fx('2026-10-11', 'GBP', 'USD') * fx('2026-10-11', 'USD', 'GBP'),
    ).toBeCloseTo(1);
    // Converting a two-week total at one rate is outside the FX task tolerance.
    expect(
      Math.abs(
        fx('2026-10-01', 'EUR', 'GBP') / fx('2026-10-14', 'EUR', 'GBP') - 1,
      ),
    ).toBeGreaterThan(0.001);
  });
  it('rejects duplicate answers, non-finite numbers, excess fields and inexact integers', () => {
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
    expect(matches({ budgetMinor: 12345 }, { budgetMinor: 12346 })).toBe(false);
    expect(matches({ spend: 100000 }, { spend: 100009 }, 0.0001)).toBe(true);
    expect(matches({ spend: 100000 }, { spend: 100050 }, 0.0001)).toBe(false);
    expect(matches({ pct: 110.3 }, { pct: 110.4 }, -0.15)).toBe(true);
    expect(
      matches(
        [{ channel: 'search' }, { channel: 'social' }],
        [{ channel: 'social' }, { channel: 'search' }],
      ),
    ).toBe(true);
  });
});
