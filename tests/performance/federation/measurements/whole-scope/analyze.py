# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.8"]
# ///
"""Generate all comparisons from frozen whole-scope benchmark archives."""
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

ROOT = Path(__file__).resolve().parent
runs = {size: json.loads(gzip.decompress((ROOT / f'{size}.json.gz').read_bytes())) for size in ['small', 'medium', 'large']}
summary = {}
lines = ['# Complete follow-up comparisons', '', 'Durations are milliseconds. Warm samples only; p95 uses nearest rank. First observations and two warmups remain in the archives. No values are copied from the earlier spike.', '']
fmt = lambda x: '—' if x is None else f'{x:.2f}'

for size, run in runs.items():
    assert not run['failures'], (size, run['failures'])
    assert not run['metadata']['dirty'], size
    groups = collections.defaultdict(list)
    for sample in run['samples']:
        assert sample['status'] == 'ok'
        if sample['path'].startswith('relate-'): assert sample['sourceRefreshes'] == 0
        if sample['phase'] == 'warm': groups[(sample['scenario'], sample['path'])].append(sample)
    summary[size] = {}
    lines += [f'## {size}: {run["metadata"]["customers"]:,} customers / {run["metadata"]["events"]:,} events', '', '| Scenario | Path | n | Median | p95 |', '| --- | --- | ---: | ---: | ---: |']
    for (scenario, path), samples in sorted(groups.items()):
        values = sorted(s['elapsedMs'] for s in samples)
        assert len(values) == 24, (size, scenario, path, len(values))
        row = {'n': len(values), 'median': statistics.median(values), 'p95': values[math.ceil(len(values)*.95)-1]}
        for stage in ['planMs', 'collectMs', 'encodeMs', 'maxObservedTimerLagMs', 'rssBytes']:
            stage_values = [s[stage] for s in samples if s.get(stage) is not None]
            if stage_values: row[stage] = statistics.median(stage_values)
        if 'scope' in samples[0]:
            for sample in samples: assert sample['scope']['statementCount'] == 1
            row['scope'] = {key: statistics.median(s['scope'][key] for s in samples) for key in samples[0]['scope']}
            row['runtimeOutsideScopeMs'] = statistics.median(s['elapsedMs'] - sum(s['scope'][stage] for stage in ['prepareMs', 'engineMs', 'mergeMs']) for s in samples)
        summary[size][f'{scenario}/{path}'] = row
        lines += [f'| {scenario} | {path} | {len(values)} | {row["median"]:.4f} | {row["p95"]:.4f} |']
    lines += ['', '### Paired public-runtime comparisons', '', 'A ratio below 1 means the numerator is faster. Ratios and differences pair observations from the same rotated block; these are descriptive, not isolated causal effects.', '', '| Query | Numerator / denominator | Median ratio | Median difference ms |', '| --- | --- | ---: | ---: |']
    for scenario, baseline in [('ranking-db', 'relate-postgres'), ('multi', 'relate-native')]:
        for transport in ['neon', 'child', 'http']:
            numerator = f'relate-{transport}-scope-federated'
            for denominator in [baseline, f'relate-{transport}-scan', f'relate-{transport}-scope-scan']:
                a = {s['block']: s['elapsedMs'] for s in groups[(scenario, numerator)]}
                b = {s['block']: s['elapsedMs'] for s in groups[(scenario, denominator)]}
                assert a.keys() == b.keys()
                lines += [f'| {scenario} | {numerator} / {denominator} | {statistics.median(a[k]/b[k] for k in a):.3f} | {statistics.median(a[k]-b[k] for k in a):.2f} |']
    lines += ['', '### Scope execution breakdown', '', 'The engine span includes serialization, request-local Arrow registration, planning, source reads, execution and JSON decoding. Plan/collect/encode are nested in that span and must not be added again. Outside-scope time includes ordinary authorization/dependency reads, materialization, revalidation, sorting and projection.', '', '| Query | Path | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for (scenario, path), samples in sorted(groups.items()):
        row = summary[size][f'{scenario}/{path}']
        if 'scope' not in row: continue
        s = row['scope']
        lines += [f'| {scenario} | {path} | {fmt(s["prepareMs"])} | {fmt(s["engineMs"])} | {fmt(s["mergeMs"])} | {fmt(row["runtimeOutsideScopeMs"])} | {fmt(s["planMs"])} | {fmt(s["collectMs"])} |']
    lines += ['', '### Observed timer lag and RSS', '', 'Timer lag is the largest observed delayed 2 ms tick within each request; null means no tick was observed, not zero blocking. RSS is after-request, not peak. Public paths sample Node only; Neon includes its engine, child/HTTP exclude their engine. Raw paths also differ in fixture/snapshot population. These observations cannot rank memory efficiency.', '', '| Query | Path | Median observed lag ms | Median observed RSS MiB |', '| --- | --- | ---: | ---: |']
    for (scenario, path) in sorted(groups):
        r = summary[size][f'{scenario}/{path}']
        rss = r.get('rssBytes')
        lines += [f'| {scenario} | {path} | {fmt(r.get("maxObservedTimerLagMs"))} | {fmt(rss / 1024**2 if rss is not None else None)} |']
    lines += ['', '### Setup observations', '', '| Component | Scenario | Setup ms |', '| --- | --- | ---: |']
    for row in run['startup']:
        lines += [f'| {row["kind"]} | {row.get("scenario", "engine")} | {row["ms"]:.2f} |']
    lines += [f'| Explicit four-table snapshot load | raw snapshot path | {run["snapshot"]["snapshotMs"]:.2f} |']
    lines += ['', '### Existing four-arrival raw SQL bursts, rerun', '', 'Five waves of four requests. Client assertions are included in wave throughput. These bursts do not include the public Relate runtime or authorized scope upload.', '', '| Path | Requests/sec | Request median | Request p95 |', '| --- | ---: | ---: | ---: |']
    for burst in run['concurrency']:
        values = sorted(burst['latencies'])
        lines += [f'| {burst["path"]} | {burst["requestsPerSecond"]:.2f} | {statistics.median(values):.2f} | {values[math.ceil(len(values)*.95)-1]:.2f} |']
    lines += ['']
assert len({r['metadata']['commit'] for r in runs.values()}) == 1
assert len({r['metadata']['binarySha256'] for r in runs.values()}) == 1
lines += ['## Provenance', '', '| Archive | Commit | Decompressed JSON SHA-256 |', '| --- | --- | --- |']
for size, run in runs.items():
    raw = gzip.decompress((ROOT/f'{size}.json.gz').read_bytes())
    lines += [f'| [{size}.json.gz]({size}.json.gz) | `{run["metadata"]["commit"]}` | `{hashlib.sha256(raw).hexdigest()}` |']
(ROOT/'tables.md').write_text('\n'.join(lines)+'\n')
(ROOT/'summary.json').write_text(json.dumps(summary, indent=2)+'\n')

plt.rcParams.update({'font.family':'DejaVu Sans', 'font.size':9, 'axes.spines.top':False, 'axes.spines.right':False})
variants = [('native','Native'), ('neon-scan','Neon slots'), ('child-scan','Child slots'), ('http-scan','HTTP slots'), ('neon-scope-scan','Neon scope scan'), ('child-scope-scan','Child scope scan'), ('http-scope-scan','HTTP scope scan'), ('neon-scope-federated','Neon scope fed.'), ('child-scope-federated','Child scope fed.'), ('http-scope-federated','HTTP scope fed.')]
colors = ['#64748b']+['#f59e0b']*3+['#93c5fd']*3+['#059669']*3
fig, axes = plt.subplots(2,3,figsize=(17,10),layout='constrained')
for row, scenario in enumerate(['ranking-db','multi']):
    for col, size in enumerate(['small','medium','large']):
        ax=axes[row,col]
        paths=[('relate-postgres' if scenario=='ranking-db' else 'relate-native') if p=='native' else f'relate-{p}' for p,_ in variants]
        values=[summary[size][f'{scenario}/{p}']['median'] for p in paths]
        tails=[summary[size][f'{scenario}/{p}']['p95'] for p in paths]
        ax.barh([label for _,label in variants],values,color=colors)
        ax.scatter(tails,range(len(values)),color='#334155',marker='|',s=80,label='p95')
        ax.invert_yaxis(); ax.set_xlabel('Full request milliseconds'); ax.set_title(f'{scenario} — {size}')
        for i,v in enumerate(values): ax.text(v-max(tails)*.015,i,f'{v:.1f}',va='center',ha='right',fontsize=8,color='white' if colors[i] in ['#64748b','#059669'] else '#172033')
        ax.set_xlim(0,max(tails)*1.2)
fig.suptitle('Complete Relate requests: original paths and authorized whole-scope execution\n24 warm samples per path; bars = median, ticks = p95. Native multi = PostgreSQL + DuckDB Parquet.',fontsize=14)
fig.savefig(ROOT/'public-comparison.png',dpi=160); plt.close(fig)

fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
for ax,scenario in zip(axes,['ranking-db','multi']):
    left=[0.,0.,0.]
    for stage,label,color in [('runtimeOutsideScopeMs','Runtime outside calculation','#64748b'),('prepareMs','Scope compilation','#f59e0b'),('engineMs','Complete engine request','#059669'),('mergeMs','Result merge','#93c5fd')]:
        values=[]
        for transport in ['neon','child','http']:
            r=summary['large'][f'{scenario}/relate-{transport}-scope-federated']
            values.append(r[stage] if stage in r else r['scope'][stage])
        ax.barh(['Neon','Child','HTTP'],values,left=left,label=label,color=color)
        left=[a+b for a,b in zip(left,values)]
    ax.invert_yaxis();ax.set_title(scenario);ax.set_xlabel('Milliseconds; medians of separate spans')
fig.legend(*axes[0].get_legend_handles_labels(),loc='outside lower center',ncol=2)
fig.suptitle('Where time remains at 12,500 customers / 1M events\nComponent medians are descriptive and may not sum to the median request.',fontsize=13)
fig.savefig(ROOT/'scope-breakdown.png',dpi=160);plt.close(fig)

fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
paths=['native-js','neon-scan','neon-federated','child-scan','child-federated','http-scan','http-federated','child-snapshot']
for ax,scenario in zip(axes,['ranking-db','multi']):
    values=[summary['large'][f'{scenario}/{p}']['median'] for p in paths]
    ax.barh(paths,values,color=['#64748b','#93c5fd','#059669','#93c5fd','#059669','#93c5fd','#059669','#a78bfa'])
    ax.invert_yaxis();ax.set_title(scenario);ax.set_xlabel('Raw SQL request milliseconds')
    for i,v in enumerate(values):ax.text(v+max(values)*.02,i,f'{v:.1f}',va='center')
    ax.set_xlim(0,max(values)*1.2)
fig.suptitle('Original whole-query alternatives rerun at 1M events\nThese exclude Relate authorization/evidence; snapshot excludes its separately recorded load.',fontsize=13)
fig.savefig(ROOT/'raw-comparison.png',dpi=160);plt.close(fig)
