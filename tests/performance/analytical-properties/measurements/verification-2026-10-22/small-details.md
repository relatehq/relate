# Analytical benchmark harness

Relate samples execute real public query pages, analytical statements and
revalidation. Ranking executes one runtime scope-first query, including
all-candidate authorization, computation and revalidation before ordering and a
final page check.

SQLite reference is independent handwritten in-memory SQL. Its latency must not
be compared as equivalent work: it excludes graph authorization, evidence and
connector lifecycle. First-of-scenario uses shared, potentially warmed
resources; it is not a cold start. Warmups are separate. p95 is omitted below 20
successful samples.

Activity stages are summed work durations, with nesting and overlap; they are
not additive parts of request elapsed time. Diagnostic delivery drains outside
elapsed time. Object sources are synthetic; configured refresh delay is
measured, not a production provider estimate.

## Workload: 100 customers / 1000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.095 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.025 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.024 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |     4.876 |    n/a |
| relate/objects/warmup                         |       1 |        0 |     1.592 |    n/a |
| relate/objects/warm                           |       3 |        0 |     1.584 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.133 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.099 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.081 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    52.408 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    45.259 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    40.708 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |     0.234 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |     0.194 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |     0.174 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |    47.489 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |    47.349 |    n/a |
| relate/ranking/warm                           |       3 |        0 |    45.807 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     31 |
| objects    | objectLoads           |     31 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     81 |
| objects    | sourceCalls           |     81 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     31 |
| enrichment | objectLoads           |     56 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    156 |
| enrichment | sourceCalls           |    156 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |      1 |
| ranking    | candidatesScanned     |    100 |
| ranking    | objectLoads           |    205 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |    575 |
| ranking    | sourceCalls           |    575 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |     80 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |     80 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 100 customers / 1000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.028 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |     2.481 |    n/a |
| relate/objects/warmup                         |       1 |        0 |     1.328 |    n/a |
| relate/objects/warm                           |       3 |        0 |     1.218 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.122 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.106 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.076 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    40.892 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    41.586 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    40.737 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |     0.226 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |     0.198 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |     0.170 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |    43.213 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |    45.956 |    n/a |
| relate/ranking/warm                           |       3 |        0 |    44.518 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      4 |
| objects    | candidatesScanned     |     34 |
| objects    | objectLoads           |     34 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     84 |
| objects    | sourceCalls           |     84 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      4 |
| enrichment | candidatesScanned     |     34 |
| enrichment | objectLoads           |     59 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    159 |
| enrichment | sourceCalls           |    159 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |      1 |
| ranking    | candidatesScanned     |    100 |
| ranking    | objectLoads           |    205 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |    575 |
| ranking    | sourceCalls           |    575 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |     80 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |     80 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.698 |            1 |               0.766 |
| enrichment | dependencyReads   |            4.233 |           59 |               0.158 |
| enrichment | finalization      |            0.280 |            4 |               0.136 |
| enrichment | candidates        |            1.215 |            1 |               1.376 |
| enrichment | planning          |            0.197 |            2 |               0.185 |
| enrichment | queueWait         |            0.003 |            1 |               0.003 |
| enrichment | connectionStartup |           33.230 |            1 |              33.299 |
| enrichment | execution         |            3.782 |            1 |               4.054 |
| enrichment | revalidation      |            0.999 |            1 |               1.037 |
| ranking    | preparation       |            0.576 |            1 |               0.579 |
| ranking    | dependencyReads   |           12.033 |          205 |               0.368 |
| ranking    | finalization      |            0.659 |           29 |               0.280 |
| ranking    | candidates        |            1.981 |            1 |               2.044 |
| ranking    | planning          |            0.423 |            2 |               0.395 |
| ranking    | queueWait         |            0.002 |            1 |               0.006 |
| ranking    | connectionStartup |           32.145 |            1 |              32.421 |
| ranking    | execution         |            4.762 |            1 |               4.773 |
| ranking    | revalidation      |            3.574 |            2 |               2.984 |

## Workload: 100 customers / 1000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.034 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.019 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |     1.195 |    n/a |
| relate/objects/warmup                         |       1 |        0 |     1.046 |    n/a |
| relate/objects/warm                           |       3 |        0 |     1.080 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.126 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.082 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.082 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    13.615 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    10.799 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    11.719 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |     0.249 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |     0.192 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |     0.174 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |    16.915 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |    20.408 |    n/a |
| relate/ranking/warm                           |       3 |        0 |    17.378 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      4 |
| objects    | candidatesScanned     |     30 |
| objects    | objectLoads           |     30 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     80 |
| objects    | sourceCalls           |     80 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      4 |
| enrichment | candidatesScanned     |     30 |
| enrichment | objectLoads           |     55 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    155 |
| enrichment | sourceCalls           |    155 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |      1 |
| ranking    | candidatesScanned     |    100 |
| ranking    | objectLoads           |    205 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |    575 |
| ranking    | sourceCalls           |    575 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |     80 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |     80 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 100 customers / 1000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.024 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.017 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |     1.155 |    n/a |
| relate/objects/warmup                         |       1 |        0 |     0.927 |    n/a |
| relate/objects/warm                           |       3 |        0 |     0.904 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.101 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.068 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.064 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    11.871 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    11.315 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    10.419 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |     0.219 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |     0.172 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |     0.163 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |    15.986 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |    16.158 |    n/a |
| relate/ranking/warm                           |       3 |        0 |    16.937 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     31 |
| objects    | objectLoads           |     31 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     81 |
| objects    | sourceCalls           |     81 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     31 |
| enrichment | objectLoads           |     56 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    156 |
| enrichment | sourceCalls           |    156 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |      1 |
| ranking    | candidatesScanned     |    100 |
| ranking    | objectLoads           |    205 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |    575 |
| ranking    | sourceCalls           |    575 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |     80 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |     80 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.514 |            1 |               0.606 |
| enrichment | dependencyReads   |            3.423 |           56 |               0.119 |
| enrichment | finalization      |            0.225 |            4 |               0.119 |
| enrichment | candidates        |            0.853 |            1 |               0.894 |
| enrichment | planning          |            0.198 |            2 |               0.170 |
| enrichment | queueWait         |            0.002 |            1 |               0.003 |
| enrichment | connectionStartup |            4.747 |            1 |               4.840 |
| enrichment | execution         |            2.566 |            1 |               3.122 |
| enrichment | revalidation      |            0.820 |            1 |               0.872 |
| ranking    | preparation       |            0.562 |            1 |               0.597 |
| ranking    | dependencyReads   |           11.766 |          205 |               0.462 |
| ranking    | finalization      |            0.619 |           29 |               0.242 |
| ranking    | candidates        |            1.883 |            1 |               1.938 |
| ranking    | planning          |            0.434 |            2 |               0.414 |
| ranking    | queueWait         |            0.003 |            1 |               0.003 |
| ranking    | connectionStartup |            5.833 |            1 |               7.095 |
| ranking    | execution         |            3.652 |            1 |               3.751 |
| ranking    | revalidation      |            3.757 |            2 |               3.055 |

## Activity instrumentation comparison

Paired configurations use the same seeded data and request semantics. These
sequential median differences include capture and timing overhead plus
run-to-run noise; negative differences are retained. They exclude waiting for
asynchronous activity delivery and are not causal estimates of timing calls
alone.

| Backend/store/freshness | Customers/events | Scenario   | Disabled ms | Enabled ms | Difference ms | Ratio |
| ----------------------- | ---------------- | ---------- | ----------: | ---------: | ------------: | ----: |
| sqlite/memory/cached    | 100/1000         | objects    |       1.584 |      1.218 |        -0.366 | 0.769 |
| sqlite/memory/cached    | 100/1000         | enrichment |      40.708 |     40.737 |         0.028 | 1.001 |
| sqlite/memory/cached    | 100/1000         | ranking    |      45.807 |     44.518 |        -1.289 | 0.972 |
| postgres/memory/cached  | 100/1000         | objects    |       1.080 |      0.904 |        -0.175 | 0.838 |
| postgres/memory/cached  | 100/1000         | enrichment |      11.719 |     10.419 |        -1.301 | 0.889 |
| postgres/memory/cached  | 100/1000         | ranking    |      17.378 |     16.937 |        -0.442 | 0.975 |
