# /// script
# requires-python = ">=3.11"
# dependencies = ["matplotlib==3.10.7"]
# ///
"""Regenerate report figures: uv run path/to/plot.py (no benchmark rerun)."""

import gzip
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LogNorm

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "figures"
OUT.mkdir(exist_ok=True)
DATA = {
    name: json.loads(gzip.decompress((ROOT / f"{name}.json.gz").read_bytes()))
    for name in ("full", "capacity", "refresh")
}
COLORS = {"sqlite": "#2563a6", "postgres": "#b64e25"}
plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.titleweight": "bold",
        "savefig.facecolor": "white",
    }
)


def workload(run, backend, customers, events):
    return next(
        w
        for w in DATA[run]["workloads"]
        if w["config"]["backend"] == backend
        and w["config"]["customers"] == customers
        and w["config"]["events"] == events
        and w["config"]["capture"] == "enabled"
    )


def samples(w, scenario="ranking"):
    result = [
        s
        for s in w["samples"]
        if s["mode"] == "relate" and s["phase"] == "warm" and s["scenario"] == scenario
    ]
    assert result and all(s["status"] == "ok" for s in result)
    return result


def percentile(values, fraction=0.5):
    values = sorted(values)
    return values[math.ceil(len(values) * fraction) - 1]


def latency(w, scenario="ranking", fraction=0.5):
    return percentile([s["durationMs"] for s in samples(w, scenario)], fraction) / 1000


def save(fig, name, note):
    fig.text(0.02, 0.02, note, fontsize=9, color="#475569")
    fig.savefig(OUT / f"{name}.png", dpi=170)
    plt.close(fig)


fig, axes = plt.subplots(1, 2, figsize=(12, 5.3))
fig.subplots_adjust(left=0.12, right=0.95, top=0.78, bottom=0.24, wspace=0.63)
fig.suptitle(
    "Returning 25 customers can require very different amounts of work",
    y=0.97,
    fontsize=16,
)
for ax, run, population, events, labels in [
    (axes[0], "full", 10000, 1000000, ["Read page", "Enrich page", "Rank full scope"]),
    (axes[1], "capacity", 12500, 100000, ["Cached memory", "Postgres + refresh"]),
]:
    for j, (backend, color) in enumerate(COLORS.items()):
        ws = (
            [workload(run, backend, population, events)] * 3
            if run == "full"
            else [
                workload(r, backend, population, events)
                for r in ["capacity", "refresh"]
            ]
        )
        vals = [
            latency(w, sc)
            for w, sc in zip(
                ws,
                ["objects", "enrichment", "ranking"]
                if run == "full"
                else ["ranking"] * 2,
            )
        ]
        bars = ax.barh(
            np.arange(len(labels)) + (j - 0.5) * 0.34,
            vals,
            height=0.31,
            color=color,
            label={"sqlite": "SQLite", "postgres": "PostgreSQL"}[backend],
        )
        ax.bar_label(
            bars,
            labels=[f"{v:.3f} s" if v < 1 else f"{v:.2f} s" for v in vals],
            padding=4,
            fontsize=10,
        )
    ax.set_yticks(range(len(labels)), labels)
    ax.invert_yaxis()
    ax.set_xlabel("Median request latency (seconds)")
    ax.set_xlim(0, 4 if run == "full" else 19)
    ax.grid(axis="x", alpha=0.18)
    ax.set_axisbelow(True)
    ax.set_title(
        "8,000 admitted / 1M events\n30 warm requests per bar"
        if run == "full"
        else "10,000 admitted / 100K events\n3 warm requests per bar",
        fontsize=12,
    )
fig.legend(
    *axes[0].get_legend_handles_labels(),
    loc="upper center",
    bbox_to_anchor=(0.5, 0.90),
    ncol=2,
    frameon=False,
)
save(
    fig,
    "latency",
    "Capture enabled. Independent requests; bars are not additive. Right panel changes BOTH object storage and freshness.\nDeveloper machine, concurrency one. Source: full/capacity/refresh.json.gz; measured commit 279a529.",
)

fig, axes = plt.subplots(1, 2, figsize=(12, 5.3), sharey=True)
fig.subplots_adjust(left=0.08, right=0.96, top=0.79, bottom=0.25, wspace=0.15)
fig.suptitle(
    "Ranking becomes expensive as the authorized customer scope grows",
    y=0.97,
    fontsize=16,
)
for ax, events in zip(axes, [100000, 1000000]):
    for backend, color in COLORS.items():
        ws = [workload("full", backend, n, events) for n in [100, 1000, 10000]]
        y = [latency(w) for w in ws]
        high = [latency(w, fraction=0.95) for w in ws]
        ax.plot(
            [80, 800, 8000],
            y,
            marker="o",
            linewidth=2,
            color=color,
            label={"sqlite": "SQLite", "postgres": "PostgreSQL"}[backend],
        )
        ax.plot([80, 800, 8000], high, linestyle=":", alpha=0.7, color=color)
    ax.set_xscale("log")
    ax.set_xticks([80, 800, 8000], ["80", "800", "8,000"])
    ax.set_ylim(0, 5.7)
    ax.set_xlabel("Authorized customers (log scale)")
    ax.set_title(f"{events:,} events", fontsize=12)
    ax.grid(alpha=0.18)
axes[0].set_ylabel("Request latency (seconds)")
axes[0].legend(frameon=False)
save(
    fig,
    "scaling",
    "Solid = median; dotted = p95 (not a confidence interval). Each point: 30 warm requests, capture enabled, cached memory objects.\nAll return 25 records. Event distribution changes with population; this does not isolate a per-customer cost. Source: full.json.gz.",
)

keys = [
    "preparation",
    "candidates",
    "dependencyReads",
    "planning",
    "queueWait",
    "connectionStartup",
    "execution",
    "revalidation",
    "finalization",
]
labels = [
    "Prepare query",
    "Read candidates",
    "Dependency reads (nested)",
    "Plan batches",
    "Wait for capacity",
    "Start connection/process",
    "Execute analytical work",
    "Revalidate dependencies",
    "Merge / sort / project",
]
columns = [(run, backend) for run in ["capacity", "refresh"] for backend in COLORS]
values = np.array(
    [
        [
            percentile(
                [
                    s["stages"][key]["totalMs"]
                    for s in samples(workload(run, backend, 12500, 100000))
                ]
            )
            for run, backend in columns
        ]
        for key in keys
    ]
)
fig, ax = plt.subplots(figsize=(11.2, 7.6))
fig.subplots_adjust(left=0.29, right=0.86, top=0.78, bottom=0.21)
fig.suptitle(
    "Recorded stage work: candidate reads and revalidation deserve attention",
    y=0.97,
    fontsize=15,
)
fig.text(
    0.29,
    0.88,
    "10,000 admitted customers / 100K events / capture enabled\nMedian summed milliseconds per stage; 3 warm ranking requests",
    fontsize=11,
)
im = ax.imshow(
    values, cmap="YlOrRd", norm=LogNorm(vmin=0.01, vmax=100000), aspect="auto"
)
ax.set_yticks(range(len(labels)), labels)
ax.tick_params(axis="x", labelsize=10)
ax.set_xticks(
    range(4),
    [
        "Memory\nSQLite",
        "Memory\nPostgres",
        "PG store + refresh\nSQLite",
        "PG store + refresh\nPostgres",
    ],
)
for i in range(len(labels)):
    for j in range(4):
        v = values[i, j]
        ax.text(
            j,
            i,
            f"{v:,.2f}",
            ha="center",
            va="center",
            color="white" if v > 2500 else "#17202a",
            fontsize=10,
        )
fig.colorbar(im, ax=ax, fraction=0.04, pad=0.035, label="Summed ms (log color scale)")
save(
    fig,
    "stages",
    "These cells overlap: do NOT sum them, treat them as a waterfall, or turn them into percentages of request latency.\nExecution is not database-server-only time. Dependency reads include work inside candidate and revalidation stages.\nRefresh changes object persistence and source freshness together. Source: capacity.json.gz and refresh.json.gz.",
)
print(f"Wrote figures to {OUT}")
