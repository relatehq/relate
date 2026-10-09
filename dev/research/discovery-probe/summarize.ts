import type { Episode } from './episode.js';

function group<K>(episodes: readonly Episode[], key: (e: Episode) => K) {
  const groups = new Map<K, Episode[]>();

  for (const episode of episodes)
    groups.set(key(episode), [...(groups.get(key(episode)) ?? []), episode]);

  return groups;
}

/** Per-goal rates without transcripts, safe to publish as evidence. */
export function summarize(episodes: readonly Episode[]) {
  const byGoal = group(episodes, (episode) => episode.goal);
  const rate = (list: readonly Episode[], pick: (e: Episode) => boolean) =>
    `${list.filter(pick).length}/${list.length}`;
  const mean = (list: readonly Episode[], pick: (e: Episode) => number) =>
    list.length ? list.reduce((t, e) => t + pick(e), 0) / list.length : 0;
  const traversed = (e: Episode) =>
    e.operations.some((path) => path.includes('.traverse.'));
  const groups: [string, readonly Episode[]][] = [...byGoal, ['all', episodes]];
  const rows = groups.map(([goal, list]) => ({
    goal,
    success: rate(list, (e) => e.success),
    clean: rate(list, (e) => e.clean),
    usedTraversal: rate(list, traversed),
    meanTurns: Number(mean(list, (e) => e.turns).toFixed(1)),
    meanSdkErrors: Number(mean(list, (e) => e.sdkErrors.length).toFixed(1)),
    usd: Number(list.reduce((t, e) => t + e.usd, 0).toFixed(4)),
  }));
  const table = [
    '| Goal | Success | Clean | Used traversal | Mean turns | Mean SDK errors | Est. USD |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.goal} | ${r.success} | ${r.clean} | ${r.usedTraversal} | ${r.meanTurns} | ${r.meanSdkErrors} | ${r.usd} |`,
    ),
  ].join('\n');

  return {
    sdk: [...new Set(episodes.map((e) => e.sdk))],
    model: [...new Set(episodes.map((e) => e.model))],
    rows,
    terminations: Object.fromEntries(
      [...group(episodes, (e) => e.termination)].map(([key, list]) => [
        key,
        list.length,
      ]),
    ),
    table,
  };
}
