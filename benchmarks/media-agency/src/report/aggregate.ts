import type { RunResult } from '../harness/run.js';
import { rng } from '../world/generator.js';

export function aggregate(results: RunResult[], k: number) {
  const groups = new Map<string, RunResult[]>();

  for (const r of results) {
    const key = `${r.arm}/${r.tier}`;

    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  return [...groups].map(([key, all]) => {
    const runs = all.filter((r) => r.status !== 'deferred'),
      deferred = all.filter((r) => r.status === 'deferred');
    const successes = runs.filter((r) => r.passed).length;
    const tasks = new Map<string, RunResult[]>();

    for (const r of runs) {
      const key = `${r.task}/${r.seed}`;

      tasks.set(key, [...(tasks.get(key) ?? []), r]);
    }

    const complete = [...tasks.values()].filter(
      (rs) => new Set(rs.map((r) => r.repeat)).size === k,
    );
    const wall = runs
      .flatMap((r) => (typeof r.wallMs === 'number' ? [r.wallMs] : []))
      .sort((a, b) => a - b);
    const percentile = (q: number) =>
      wall.length ? wall[Math.ceil(wall.length * q) - 1] : null;
    const knownCost = runs.every((r) => typeof r.costUsd === 'number');
    const totalCost = knownCost
      ? runs.reduce((sum, r) => sum + Number(r.costUsd), 0)
      : null;
    const mistakes: Record<string, number> = {};

    for (const r of runs)
      for (const m of r.mistakes ?? []) mistakes[m] = (mistakes[m] ?? 0) + 1;

    return {
      group: key,
      runs: runs.length,
      successes,
      passAt1: runs.length ? successes / runs.length : null,
      passAllK: complete.length
        ? complete.filter((rs) => rs.every((r) => r.passed)).length /
          complete.length
        : null,
      completeTaskGroups: complete.length,
      incompleteTaskGroups: tasks.size - complete.length,
      deferredTasks: [...new Set(deferred.map((r) => r.task))],
      costPerSuccess:
        totalCost !== null && successes ? totalCost / successes : null,
      unknownCostRuns: runs.filter((r) => typeof r.costUsd !== 'number').length,
      medianWallMs: percentile(0.5),
      p90WallMs: percentile(0.9),
      mistakesPer100: Object.fromEntries(
        Object.entries(mistakes).map(([tag, n]) => [
          tag,
          runs.length ? (n / runs.length) * 100 : 0,
        ]),
      ),
    };
  });
}

/** Paired bootstrap samples whole tasks, preserving all repetitions within a task. */
export function paired(
  results: RunResult[],
  left: string,
  right: string,
  k: number,
) {
  const keys = [
    ...new Set(
      results
        .filter((r) => r.status !== 'deferred')
        .map((r) => `${r.task}/${r.seed}/${r.tier}`),
    ),
  ];
  const deltas: number[] = [];

  for (const key of keys) {
    const group = results.filter(
      (r) => `${r.task}/${r.seed}/${r.tier}` === key,
    );
    const a = group.filter((r) => r.arm === left),
      b = group.filter((r) => r.arm === right);

    if (a.length !== k || b.length !== k) continue;

    deltas.push(
      a.filter((r) => r.passed).length / k -
        b.filter((r) => r.passed).length / k,
    );
  }

  if (!deltas.length)
    return { left, right, pairedTasks: 0, difference: null, interval95: null };

  const random = rng(883),
    samples = Array.from(
      { length: 2000 },
      () =>
        deltas.reduce(
          (sum) => sum + deltas[Math.floor(random() * deltas.length)]!,
          0,
        ) / deltas.length,
    ).sort((a, b) => a - b);

  return {
    left,
    right,
    pairedTasks: deltas.length,
    difference: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    interval95: [samples[49], samples[1949]],
  };
}

export function renderReport(report: {
  mode: string;
  summary: ReturnType<typeof aggregate>;
  comparisons: ReturnType<typeof paired>[];
  intendedTasks: number;
  runnableTasks: number;
  deferredTasks: unknown[];
  missingRuns: number;
}) {
  const percent = (n: unknown) =>
    typeof n === 'number' ? `${(n * 100).toFixed(1)}%` : 'n/a';

  return `# Northlight Media benchmark\n\nMode: **${report.mode}**. ${report.mode === 'reference' ? 'These are deterministic reference-solution checks, not model performance results.' : 'Results compare the access arms plus their benchmark integrations.'}\n\nIntended tasks: ${report.intendedTasks}; runnable: ${report.runnableTasks}; deferred: ${report.deferredTasks.length}; missing scheduled runs: ${report.missingRuns}.\n\n| Arm / tier | Runs | pass@1 | pass^k | Incomplete task groups | Cost / success | Median ms | p90 ms |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${report.summary.map((r) => `| ${r.group} | ${r.runs} | ${percent(r.passAt1)} | ${percent(r.passAllK)} | ${r.incompleteTaskGroups} | ${r.costPerSuccess === null ? 'unknown' : r.costPerSuccess.toFixed(6)} | ${r.medianWallMs?.toFixed(0) ?? 'n/a'} | ${r.p90WallMs?.toFixed(0) ?? 'n/a'} |`).join('\n')}\n\nDeferred tasks remain in report.json with reasons. Cost per success includes failed runs; unknown costs are never replaced with zero. pass^k includes only groups with all requested repetitions and reports incomplete groups separately. Paired task bootstrap intervals and mistake breakdowns are in report.json. This development executor is not a security sandbox; reference validation does not establish adversarial isolation.\n`;
}
