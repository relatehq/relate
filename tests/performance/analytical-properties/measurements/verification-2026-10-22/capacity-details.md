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

## Workload: 12500 customers / 100000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.126 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.026 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.020 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    64.726 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    56.862 |    n/a |
| relate/objects/warm                           |       3 |        0 |    56.925 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.233 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.107 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.083 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   121.790 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   110.040 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   111.060 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    28.120 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.788 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    26.879 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4124.785 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3671.529 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3613.275 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     27 |
| objects    | objectLoads           |     27 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     77 |
| objects    | sourceCalls           |     77 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     27 |
| enrichment | objectLoads           |     52 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    152 |
| enrichment | sourceCalls           |    152 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 12500 customers / 100000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.044 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.021 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    58.876 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    56.212 |    n/a |
| relate/objects/warm                           |       3 |        0 |    56.185 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.147 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.075 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.068 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   104.869 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   105.005 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   105.295 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.762 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.837 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    25.153 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3566.677 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3664.786 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3651.660 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     30 |
| objects    | objectLoads           |     30 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     80 |
| objects    | sourceCalls           |     80 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     30 |
| enrichment | objectLoads           |     55 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    155 |
| enrichment | sourceCalls           |    155 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.659 |            1 |               0.793 |
| enrichment | dependencyReads   |           14.953 |           55 |               0.736 |
| enrichment | finalization      |            0.274 |            4 |               0.140 |
| enrichment | candidates        |           56.909 |            1 |              57.262 |
| enrichment | planning          |            0.241 |            2 |               0.205 |
| enrichment | queueWait         |            0.004 |            1 |               0.004 |
| enrichment | connectionStartup |           31.325 |            1 |              32.126 |
| enrichment | execution         |           13.362 |            1 |              13.491 |
| enrichment | revalidation      |            2.120 |            1 |               2.229 |
| ranking    | preparation       |            0.626 |            1 |               0.690 |
| ranking    | dependencyReads   |         5929.878 |        22525 |              20.938 |
| ranking    | finalization      |           61.142 |          162 |              12.567 |
| ranking    | candidates        |         2562.287 |            1 |            2570.556 |
| ranking    | planning          |           51.930 |           11 |              47.100 |
| ranking    | queueWait         |            0.037 |           10 |               0.011 |
| ranking    | connectionStartup |          319.121 |           10 |              34.616 |
| ranking    | execution         |          408.985 |           10 |              46.847 |
| ranking    | revalidation      |          777.635 |            2 |             819.253 |

## Workload: 12500 customers / 100000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.046 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.021 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    57.187 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    55.794 |    n/a |
| relate/objects/warm                           |       3 |        0 |    56.018 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.143 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.079 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.064 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    79.541 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    81.763 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    81.764 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    27.216 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.636 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    25.508 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3474.484 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3554.778 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3573.108 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     29 |
| objects    | objectLoads           |     29 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     79 |
| objects    | sourceCalls           |     79 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     29 |
| enrichment | objectLoads           |     54 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    154 |
| enrichment | sourceCalls           |    154 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 12500 customers / 100000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.048 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    59.301 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    57.735 |    n/a |
| relate/objects/warm                           |       3 |        0 |    57.037 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.147 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.074 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.070 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    80.070 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    79.981 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    84.841 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    27.567 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.508 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    25.204 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3570.502 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3619.472 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3574.898 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     28 |
| objects    | objectLoads           |     28 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     78 |
| objects    | sourceCalls           |     78 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     28 |
| enrichment | objectLoads           |     53 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    153 |
| enrichment | sourceCalls           |    153 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.648 |            1 |               0.670 |
| enrichment | dependencyReads   |           13.872 |           53 |               0.554 |
| enrichment | finalization      |            0.297 |            4 |               0.148 |
| enrichment | candidates        |           57.598 |            1 |              57.730 |
| enrichment | planning          |            0.247 |            2 |               0.209 |
| enrichment | queueWait         |            0.003 |            1 |               0.004 |
| enrichment | connectionStartup |            9.814 |            1 |              10.679 |
| enrichment | execution         |           15.243 |            1 |              15.823 |
| enrichment | revalidation      |            2.226 |            1 |               2.339 |
| ranking    | preparation       |            0.653 |            1 |               0.756 |
| ranking    | dependencyReads   |         6117.917 |        22525 |               3.735 |
| ranking    | finalization      |           60.777 |          162 |              12.165 |
| ranking    | candidates        |         2605.748 |            1 |            2611.234 |
| ranking    | planning          |           52.988 |           11 |              46.555 |
| ranking    | queueWait         |            0.036 |           10 |               0.012 |
| ranking    | connectionStartup |          118.462 |           10 |              15.525 |
| ranking    | execution         |          316.609 |           10 |              44.521 |
| ranking    | revalidation      |          763.981 |            2 |             782.937 |

## Workload: 12500 customers / 1000000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.049 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.022 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |   117.139 |    n/a |
| relate/objects/warmup                         |       1 |        0 |   118.168 |    n/a |
| relate/objects/warm                           |       3 |        0 |   116.690 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.493 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.385 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.460 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   264.194 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   260.391 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   263.710 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   218.946 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   219.286 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   218.946 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4532.017 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4552.913 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  6876.914 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      4 |
| objects    | candidatesScanned     |     33 |
| objects    | objectLoads           |     33 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     83 |
| objects    | sourceCalls           |     83 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      4 |
| enrichment | candidatesScanned     |     33 |
| enrichment | objectLoads           |     58 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    158 |
| enrichment | sourceCalls           |    158 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 12500 customers / 1000000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.058 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.026 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    58.419 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    57.139 |    n/a |
| relate/objects/warm                           |       3 |        0 |    57.664 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.421 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.326 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.321 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   199.963 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   202.479 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   201.097 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   233.183 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   214.291 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   215.860 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4455.796 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4476.432 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4482.803 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     30 |
| objects    | objectLoads           |     30 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     80 |
| objects    | sourceCalls           |     80 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     30 |
| enrichment | objectLoads           |     55 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    155 |
| enrichment | sourceCalls           |    155 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.585 |            1 |               0.613 |
| enrichment | dependencyReads   |           14.049 |           55 |               0.527 |
| enrichment | finalization      |            0.288 |            4 |               0.143 |
| enrichment | candidates        |           57.544 |            1 |              58.724 |
| enrichment | planning          |            0.217 |            2 |               0.196 |
| enrichment | queueWait         |            0.004 |            1 |               0.004 |
| enrichment | connectionStartup |           33.302 |            1 |              33.994 |
| enrichment | execution         |          106.577 |            1 |             108.361 |
| enrichment | revalidation      |            2.091 |            1 |               2.095 |
| ranking    | preparation       |            0.617 |            1 |               0.749 |
| ranking    | dependencyReads   |         6037.022 |        22525 |               2.616 |
| ranking    | finalization      |           63.855 |          162 |              14.940 |
| ranking    | candidates        |         2612.344 |            1 |            2677.829 |
| ranking    | planning          |           50.746 |           11 |              47.581 |
| ranking    | queueWait         |            0.044 |           10 |               0.010 |
| ranking    | connectionStartup |          314.367 |           10 |              33.504 |
| ranking    | execution         |         3082.723 |           10 |             327.919 |
| ranking    | revalidation      |          784.828 |            2 |             785.185 |

## Workload: 12500 customers / 1000000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.048 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    61.099 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    59.151 |    n/a |
| relate/objects/warm                           |       3 |        0 |    59.417 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.468 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.386 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.367 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   115.948 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   114.389 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   117.541 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   216.847 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   218.410 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   218.794 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4423.318 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4155.793 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4139.838 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     28 |
| objects    | objectLoads           |     28 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     78 |
| objects    | sourceCalls           |     78 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     28 |
| enrichment | objectLoads           |     53 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    153 |
| enrichment | sourceCalls           |    153 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 12500 customers / 1000000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.053 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.023 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.018 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    88.639 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    85.855 |    n/a |
| relate/objects/warm                           |       3 |        0 |    85.052 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.413 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.297 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.295 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   163.237 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   154.472 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   152.427 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   208.735 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   205.514 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   205.761 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4229.291 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4070.722 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4097.677 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     32 |
| objects    | objectLoads           |     32 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     82 |
| objects    | sourceCalls           |     82 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     32 |
| enrichment | objectLoads           |     57 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    157 |
| enrichment | sourceCalls           |    157 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    125 |
| ranking    | candidatesScanned     |  12500 |
| ranking    | objectLoads           |  22525 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  62575 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.644 |            1 |               4.618 |
| enrichment | dependencyReads   |           25.947 |           57 |               1.165 |
| enrichment | finalization      |            0.336 |            4 |               0.212 |
| enrichment | candidates        |           88.760 |            1 |              90.368 |
| enrichment | planning          |            0.234 |            2 |               0.205 |
| enrichment | queueWait         |            0.004 |            1 |               0.004 |
| enrichment | connectionStartup |            5.765 |            1 |               5.853 |
| enrichment | execution         |           53.024 |            1 |              59.444 |
| enrichment | revalidation      |            3.173 |            1 |               7.171 |
| ranking    | preparation       |            0.656 |            1 |               0.678 |
| ranking    | dependencyReads   |         6051.989 |        22525 |               1.843 |
| ranking    | finalization      |           87.320 |          162 |              13.420 |
| ranking    | candidates        |         2574.757 |            1 |            2578.565 |
| ranking    | planning          |           57.363 |           11 |              45.807 |
| ranking    | queueWait         |            0.078 |           10 |               0.029 |
| ranking    | connectionStartup |          140.513 |           10 |              29.967 |
| ranking    | execution         |         1973.300 |           10 |             219.763 |
| ranking    | revalidation      |          791.082 |            2 |             795.189 |

## Activity instrumentation comparison

Paired configurations use the same seeded data and request semantics. These
sequential median differences include capture and timing overhead plus
run-to-run noise; negative differences are retained. They exclude waiting for
asynchronous activity delivery and are not causal estimates of timing calls
alone.

| Backend/store/freshness | Customers/events | Scenario   | Disabled ms | Enabled ms | Difference ms | Ratio |
| ----------------------- | ---------------- | ---------- | ----------: | ---------: | ------------: | ----: |
| sqlite/memory/cached    | 12500/100000     | objects    |      56.925 |     56.185 |        -0.739 | 0.987 |
| sqlite/memory/cached    | 12500/100000     | enrichment |     111.060 |    105.295 |        -5.765 | 0.948 |
| sqlite/memory/cached    | 12500/100000     | ranking    |    3613.275 |   3651.660 |        38.384 | 1.011 |
| postgres/memory/cached  | 12500/100000     | objects    |      56.018 |     57.037 |         1.019 | 1.018 |
| postgres/memory/cached  | 12500/100000     | enrichment |      81.764 |     84.841 |         3.078 | 1.038 |
| postgres/memory/cached  | 12500/100000     | ranking    |    3573.108 |   3574.898 |         1.790 | 1.001 |
| sqlite/memory/cached    | 12500/1000000    | objects    |     116.690 |     57.664 |       -59.026 | 0.494 |
| sqlite/memory/cached    | 12500/1000000    | enrichment |     263.710 |    201.097 |       -62.613 | 0.763 |
| sqlite/memory/cached    | 12500/1000000    | ranking    |    6876.914 |   4482.803 |     -2394.112 | 0.652 |
| postgres/memory/cached  | 12500/1000000    | objects    |      59.417 |     85.052 |        25.635 | 1.431 |
| postgres/memory/cached  | 12500/1000000    | enrichment |     117.541 |    152.427 |        34.886 | 1.297 |
| postgres/memory/cached  | 12500/1000000    | ranking    |    4139.838 |   4097.677 |       -42.160 | 0.990 |
