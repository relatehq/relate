# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.8"]
# ///
"""Rebuild tables and figures from the committed raw JSON archives."""
import collections
import gzip
import hashlib
import json
import math
from pathlib import Path
import statistics

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).parent
runs = {name: json.loads(gzip.decompress((ROOT / f'{name}.json.gz').read_bytes()))
        for name in ['small', 'medium', 'large']}
summary = {}
lines = ['# Full measured results', '', 'Warm requests only. All durations are milliseconds; p95 is nearest rank. Setup and warmups are retained in the raw archives.', '']
for name, run in runs.items():
    groups = collections.defaultdict(list)
    for sample in run['samples']:
        if sample['phase'] == 'warm' and sample['status'] == 'ok':
            groups[(sample['scenario'], sample['path'])].append(sample)
    summary[name] = {}
    lines += [f'## {name}: {run["metadata"]["customers"]:,} customers / {run["metadata"]["events"]:,} events', '',
              '| Scenario | Path | n | Median ms | p95 ms | Plan median | Collect median |',
              '| --- | --- | ---: | ---: | ---: | ---: | ---: |']
    for (scenario, path), samples in sorted(groups.items()):
        values = sorted(s['elapsedMs'] for s in samples)
        median = statistics.median(values)
        p95 = values[math.ceil(len(values) * .95) - 1] if len(values) >= 20 else None
        entry = {'n': len(values), 'median': median, 'p95': p95}
        for stage in ['planMs', 'collectMs', 'encodeMs']:
            stage_values = [s[stage] for s in samples if stage in s]
            entry[stage] = statistics.median(stage_values) if stage_values else None
        summary[name][f'{scenario}/{path}'] = entry
        fmt = lambda value: '—' if value is None else f'{value:.2f}'
        lines += [f'| {scenario} | {path} | {len(values)} | {median:.2f} | {fmt(p95)} | {fmt(entry["planMs"])} | {fmt(entry["collectMs"])} |']
    lines += ['', '### Within-block contrasts', '', 'Positive ratio means the numerator took longer. These are descriptive paired observations, not causal effects.', '',
              '| Scenario | Numerator / denominator | Median per-block ratio | Median per-block difference ms |', '| --- | --- | ---: | ---: |']
    for scenario in ['ranking-db', 'multi']:
        pairs = [(f'{transport}-scan', f'{transport}-federated') for transport in ['neon', 'child', 'http']]
        pairs += [(f'{transport}-federated', 'native-js') for transport in ['neon', 'child', 'http']]
        if scenario == 'ranking-db': pairs += [(f'relate-{transport}-scan', 'relate-postgres') for transport in ['neon', 'child', 'http']]
        for numerator, denominator in pairs:
            first = {s['block']: s['elapsedMs'] for s in groups[(scenario, numerator)]}
            second = {s['block']: s['elapsedMs'] for s in groups[(scenario, denominator)]}
            blocks = sorted(first.keys() & second.keys())
            ratios = [first[b]/second[b] for b in blocks]
            differences = [first[b]-second[b] for b in blocks]
            lines += [f'| {scenario} | {numerator} / {denominator} | {statistics.median(ratios):.2f}× | {statistics.median(differences):.2f} |']
    lines += ['', '### Four-arrival bursts', '', '| Path | Requests | Requests/sec including client checks | Request median ms | Request p95 ms |', '| --- | ---: | ---: | ---: | ---: |']
    for row in run['concurrency']:
        values = sorted(row['latencies'])
        lines += [f'| {row["path"]} | {len(values)} | {row["requestsPerSecond"]:.2f} | {statistics.median(values):.2f} | {values[math.ceil(len(values)*.95)-1]:.2f} |']
    lines += ['']
lines += ['## Archive integrity', '', '| Archive | SHA-256 of decompressed JSON |', '| --- | --- |']
for name in runs:
    raw = gzip.decompress((ROOT/f'{name}.json.gz').read_bytes())
    lines += [f'| [{name}.json.gz]({name}.json.gz) | `{hashlib.sha256(raw).hexdigest()}` |']
(ROOT/'tables.md').write_text('\n'.join(lines)+'\n')
(ROOT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')

plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False})
paths = ['native-js','neon-scan','neon-federated','child-scan','child-federated','http-scan','http-federated','child-snapshot']
labels = ['Native JS','Neon scan','Neon pushdown','Child scan','Child pushdown','HTTP scan','HTTP pushdown','Child snapshot']
colors = ['#64748b','#93c5fd','#2563eb','#a7f3d0','#059669','#fcd34d','#d97706','#a78bfa']
fig, axes = plt.subplots(2,3,figsize=(16,9),layout='constrained')
for ax, scenario in zip(axes.flat, ['control','ranking-db','ranking-file','multi','selective','bulk']):
    values = [summary['large'][f'{scenario}/{p}']['median'] for p in paths]
    ax.barh(labels, values, color=colors)
    ax.invert_yaxis(); ax.set_xscale('log'); ax.set_xlabel('Median request ms (log scale)'); ax.set_title(scenario)
    for i,value in enumerate(values): ax.text(value*1.08,i,f'{value:.2f}',va='center',fontsize=8)
    ax.set_xlim(max(min(values)*.5,.0001),max(values)*2)
fig.suptitle('Whole-query execution: 12,500 customers / 1M events\nLive sources except explicit snapshot; 24 warm requests per path. Native control is a JS constant.', fontsize=14)
fig.savefig(ROOT/'whole-query.png',dpi=180)
plt.close(fig)

fig, axes = plt.subplots(1,3,figsize=(14,4.6),layout='constrained')
public_paths = ['relate-postgres','relate-neon-scan','relate-child-scan','relate-http-scan']
for ax,(name,run) in zip(axes,runs.items()):
    values=[summary[name][f'ranking-db/{p}']['median'] for p in public_paths]
    ax.bar(['Postgres','Neon','Child','HTTP'],values,color=['#64748b','#2563eb','#059669','#d97706'])
    ax.set_title(f'{run["metadata"]["customers"]:,} customers / {run["metadata"]["events"]:,} events')
    ax.set_ylabel('Median full Relate request ms')
    ax.set_ylim(0,max(values)*1.2)
    for i,value in enumerate(values):ax.text(i,value,f'{value:.1f}',ha='center',va='bottom')
fig.suptitle('Connector replacement inside the existing public Relate query\nAuthorization, evidence and revalidation retained; DataFusion adapters use scan mode.', fontsize=13)
fig.savefig(ROOT/'public-runtime.png',dpi=180)
plt.close(fig)
