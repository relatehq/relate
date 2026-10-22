# /// script
# dependencies = ["matplotlib==3.10.7"]
# ///
import json, gzip, math
from pathlib import Path
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

DEST = Path(__file__).resolve().parent
RUNS = {
    name: json.loads(gzip.decompress((DEST / f"{name}.json.gz").read_bytes()))
    for name in ["full", "persistent", "refresh"]
}


def median(v):
    return sorted(v)[math.ceil(len(v) * 0.5) - 1]


def summary(w, scenario, mode):
    return next(
        s for s in w["summary"] if s["scenario"] == scenario and s["mode"] == mode
    )


def get(run, backend, events=1000000, customers=12500):
    return next(
        w
        for w in RUNS[run]["workloads"]
        if w["config"]["backend"] == backend
        and w["config"]["events"] == events
        and w["config"]["customers"] == customers
    )


def rows(w, scenario="ranking"):
    return [
        s
        for s in w["samples"]
        if s["mode"] == "relate" and s["scenario"] == scenario and s["phase"] == "warm"
    ]


def diff(w, a, b, scenario="ranking"):
    return next(
        d["medianDifferenceMs"]
        for d in w["differences"]
        if d["scenario"] == scenario and d["comparison"] == f"{a} minus {b}"
    )


MODES = [
    "direct-warm",
    "direct-fresh",
    "connector",
    "relate",
    "colocated",
    "materialized",
]
LABELS = [
    "Exact SQL: warm driver",
    "Exact SQL: fresh handles",
    "Relate connector only",
    "Full Relate request",
    "Colocated join",
    "Precomputed snapshot",
]
plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
    }
)
fig, axes = plt.subplots(1, 2, figsize=(13, 5.8), sharex=True)
fig.subplots_adjust(left=0.20, right=0.94, wspace=0.65, bottom=0.20, top=0.78)
fig.suptitle("How much time does Relate add above its own SQL?", fontsize=17, y=0.97)
fig.text(
    0.20,
    0.87,
    "10,000 authorized customers / 1M events / cached memory objects / ranking\n24 measured requests per path; capture enabled; request concurrency one",
    fontsize=11,
)
for ax, backend in zip(axes, ["postgres", "duckdb"]):
    w = get("full", backend)
    vals = [summary(w, "ranking", m)["medianMs"] for m in MODES]
    ax.barh(
        range(6),
        vals,
        color=["#2563a6", "#2563a6", "#5095b7", "#d15b2b", "#458451", "#458451"],
    )
    ax.set_yticks(range(6), LABELS, fontsize=10)
    ax.invert_yaxis()
    ax.set_xscale("log")
    ax.set_xlim(0.1, max(vals) * 3)
    ax.set_xlabel("Median milliseconds (log scale: each decade is 10×)")
    for i, v in enumerate(vals):
        ax.text(v * 1.12, i, f"{v:,.1f}", va="center", fontsize=10)
    ax.set_title("PostgreSQL" if backend == "postgres" else "DuckDB", fontweight="bold")
    ax.grid(axis="x", alpha=0.15)
    ax.set_axisbelow(True)
fig.text(
    0.02,
    0.025,
    "Blue paths replay identical generated SQL/parameters. Orange adds runtime semantics. Green changes the architecture.\nSnapshot build/refresh/ingestion is NOT included in green read latency. Replay returns aggregate slots; full/green paths return 25 records.",
    fontsize=9,
)
fig.savefig(DEST / "paths.png", dpi=170)
plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(12.5, 5.7), sharex=True)
fig.subplots_adjust(left=0.18, right=0.97, wspace=0.65, bottom=0.24, top=0.76)
fig.suptitle("Where the full Relate request spends wall time", fontsize=17, y=0.97)
fig.text(
    0.18,
    0.86,
    "10,000 authorized customers / 100K events; one median-latency ranking request per configuration\nEach bar is a real single request, partitioned without double-counting overlap.",
    fontsize=11,
)
for ax, backend in zip(axes, ["postgres", "duckdb"]):
    for i, run in enumerate(["full", "persistent", "refresh"]):
        w = get(run, backend, 100000)
        ss = sorted(rows(w), key=lambda s: s["durationMs"])
        s = ss[math.ceil(len(ss) * 0.5) - 1]
        busy = s["connectorBusyMs"] / 1000
        outside = s["outsideConnectorMs"] / 1000
        ax.barh(
            i,
            busy,
            color="#2563a6",
            label="At least one connector call active" if i == 0 else None,
        )
        ax.barh(
            i,
            outside,
            left=busy,
            color="#d15b2b",
            label="Exclusively outside connector calls" if i == 0 else None,
        )
        ax.text(
            busy + outside + 0.10,
            i,
            f"{busy + outside:.2f} s",
            va="center",
            fontsize=10,
        )
    ax.set_yticks(
        range(3),
        ["Memory, cached", "Postgres store, cached", "Postgres store, refresh"],
        fontsize=10,
    )
    ax.invert_yaxis()
    ax.set_xlim(0, 16)
    ax.set_xlabel("Request elapsed time (seconds)")
    ax.set_title(
        "PostgreSQL analytics" if backend == "postgres" else "DuckDB analytics",
        fontweight="bold",
    )
    ax.grid(axis="x", alpha=0.15)
    ax.set_axisbelow(True)
fig.legend(
    *axes[0].get_legend_handles_labels(),
    loc="lower center",
    bbox_to_anchor=(0.5, 0.10),
    ncol=2,
    frameon=False,
    fontsize=10,
)
fig.text(
    0.02,
    0.02,
    "Connector-active time includes lifecycle and decoding, not just database CPU. Runtime work can also overlap the blue interval.\nRefresh adds a synthetic 2 ms fetch delay; provider identity checks remain immediate. Source: retained raw samples.",
    fontsize=9,
)
fig.savefig(DEST / "wall-time.png", dpi=170)
plt.close(fig)
