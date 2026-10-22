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

## Workload: 100 customers / 100000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.096 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.023 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.016 |   0.025 |
| relate/objects/first-of-scenario              |       1 |        0 |     4.924 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     1.611 |     n/a |
| relate/objects/warm                           |      30 |        0 |     1.078 |   1.506 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     4.210 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     4.346 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     4.034 |   4.217 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    88.158 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    80.650 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    76.610 |  79.076 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    17.210 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    16.062 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    16.088 |  16.640 |
| relate/ranking/first-of-scenario              |       1 |        0 |   137.780 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   139.073 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   138.249 | 141.243 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     35 |
| objects    | objectLoads           |     35 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     85 |
| objects    | sourceCalls           |     85 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     35 |
| enrichment | objectLoads           |     60 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    160 |
| enrichment | sourceCalls           |    160 |
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

## Workload: 100 customers / 100000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.034 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.018 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.015 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.915 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     0.963 |     n/a |
| relate/objects/warm                           |      30 |        0 |     0.857 |   1.000 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     3.406 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     3.469 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.363 |   3.537 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    72.231 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    73.130 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    71.926 |  75.057 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    16.848 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    16.187 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    15.983 |  16.482 |
| relate/ranking/first-of-scenario              |       1 |        0 |   146.257 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   138.641 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   138.972 | 146.827 |

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
| objects    | capturedOperations    |      1 |
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
| enrichment | preparation       |            0.564 |            1 |               0.673 |
| enrichment | dependencyReads   |            3.315 |           54 |               0.149 |
| enrichment | finalization      |            0.261 |            4 |               0.179 |
| enrichment | candidates        |            0.851 |            1 |               1.107 |
| enrichment | planning          |            0.198 |            2 |               0.189 |
| enrichment | queueWait         |            0.003 |            1 |               0.007 |
| enrichment | connectionStartup |           30.773 |            1 |              35.539 |
| enrichment | execution         |           37.898 |            1 |              39.713 |
| enrichment | revalidation      |            0.918 |            1 |               1.139 |
| ranking    | preparation       |            0.566 |            1 |               0.694 |
| ranking    | dependencyReads   |           11.543 |          205 |               0.676 |
| ranking    | finalization      |            0.645 |           29 |               0.694 |
| ranking    | candidates        |            1.962 |            1 |               2.536 |
| ranking    | planning          |            0.468 |            2 |               0.814 |
| ranking    | queueWait         |            0.003 |            1 |               0.019 |
| ranking    | connectionStartup |           31.394 |            1 |              33.207 |
| ranking    | execution         |           99.832 |            1 |             127.860 |
| ranking    | revalidation      |            3.417 |            2 |               3.016 |

## Workload: 100 customers / 100000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.045 |    n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |    n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |  0.018 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.532 |    n/a |
| relate/objects/warmup                         |       3 |        0 |     0.938 |    n/a |
| relate/objects/warm                           |      30 |        0 |     0.870 |  0.975 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     3.733 |    n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     3.685 |    n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.718 |  3.899 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    39.293 |    n/a |
| relate/enrichment/warmup                      |       3 |        0 |    26.537 |    n/a |
| relate/enrichment/warm                        |      30 |        0 |    29.577 | 32.306 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    38.148 |    n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    19.530 |    n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    15.876 | 16.567 |
| relate/ranking/first-of-scenario              |       1 |        0 |    52.379 |    n/a |
| relate/ranking/warmup                         |       3 |        0 |    37.032 |    n/a |
| relate/ranking/warm                           |      30 |        0 |    33.175 | 41.989 |

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
| objects    | capturedOperations    |      0 |
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

## Workload: 100 customers / 100000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.039 |    n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.018 |    n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |  0.024 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.421 |    n/a |
| relate/objects/warmup                         |       3 |        0 |     0.978 |    n/a |
| relate/objects/warm                           |      30 |        0 |     0.960 |  1.105 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     3.539 |    n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     3.493 |    n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.410 |  3.521 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    37.556 |    n/a |
| relate/enrichment/warmup                      |       3 |        0 |    25.202 |    n/a |
| relate/enrichment/warm                        |      30 |        0 |    27.576 | 30.301 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.259 |    n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    20.127 |    n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    16.091 | 16.858 |
| relate/ranking/first-of-scenario              |       1 |        0 |    51.106 |    n/a |
| relate/ranking/warmup                         |       3 |        0 |    36.872 |    n/a |
| relate/ranking/warm                           |      30 |        0 |    37.728 | 41.193 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     33 |
| objects    | objectLoads           |     33 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     83 |
| objects    | sourceCalls           |     83 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     33 |
| enrichment | objectLoads           |     58 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    158 |
| enrichment | sourceCalls           |    158 |
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
| enrichment | preparation       |            1.320 |            1 |               1.724 |
| enrichment | dependencyReads   |            8.430 |           58 |               0.428 |
| enrichment | finalization      |            0.685 |            4 |               0.433 |
| enrichment | candidates        |            2.404 |            1 |               3.058 |
| enrichment | planning          |            0.237 |            2 |               0.527 |
| enrichment | queueWait         |            0.004 |            1 |               0.011 |
| enrichment | connectionStartup |            5.482 |            1 |               7.959 |
| enrichment | execution         |           14.120 |            1 |              14.900 |
| enrichment | revalidation      |            2.209 |            1 |               3.243 |
| ranking    | preparation       |            0.614 |            1 |               0.975 |
| ranking    | dependencyReads   |           12.725 |          205 |               0.883 |
| ranking    | finalization      |            1.094 |           29 |               1.082 |
| ranking    | candidates        |            1.929 |            1 |               2.866 |
| ranking    | planning          |            0.524 |            2 |               0.620 |
| ranking    | queueWait         |            0.003 |            1 |               0.005 |
| ranking    | connectionStartup |            5.527 |            1 |               6.615 |
| ranking    | execution         |           20.599 |            1 |              21.890 |
| ranking    | revalidation      |            6.805 |            2 |               7.518 |

## Workload: 100 customers / 1000000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.036 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.020 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.017 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.135 |      n/a |
| relate/objects/warmup                         |       3 |        0 |     0.886 |      n/a |
| relate/objects/warm                           |      30 |        0 |     0.840 |    0.911 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |    59.949 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |    60.277 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |    59.700 |   61.905 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   443.586 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   429.179 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   440.515 |  456.016 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   204.409 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   197.139 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   191.353 |  195.301 |
| relate/ranking/first-of-scenario              |       1 |        0 |  1139.764 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  1147.845 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  1151.699 | 1205.020 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     35 |
| objects    | objectLoads           |     35 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     85 |
| objects    | sourceCalls           |     85 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     35 |
| enrichment | objectLoads           |     60 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    160 |
| enrichment | sourceCalls           |    160 |
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

## Workload: 100 customers / 1000000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.058 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.019 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |    0.019 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.260 |      n/a |
| relate/objects/warmup                         |       3 |        0 |     0.872 |      n/a |
| relate/objects/warm                           |      30 |        0 |     0.764 |    0.883 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |    57.669 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |    57.110 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |    57.359 |   59.030 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   425.541 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   420.559 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   422.445 |  435.534 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   194.270 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   193.935 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   191.435 |  199.547 |
| relate/ranking/first-of-scenario              |       1 |        0 |  1159.670 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  1162.013 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  1161.065 | 1362.775 |

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
| enrichment | preparation       |            0.545 |            1 |               0.606 |
| enrichment | dependencyReads   |            2.762 |           55 |               0.116 |
| enrichment | finalization      |            0.245 |            4 |               0.119 |
| enrichment | candidates        |            0.763 |            1 |               0.831 |
| enrichment | planning          |            0.204 |            2 |               0.191 |
| enrichment | queueWait         |            0.003 |            1 |               0.003 |
| enrichment | connectionStartup |           30.941 |            1 |              34.314 |
| enrichment | execution         |          388.392 |            1 |             401.943 |
| enrichment | revalidation      |            0.810 |            1 |               0.909 |
| ranking    | preparation       |            0.563 |            1 |               0.818 |
| ranking    | dependencyReads   |            9.745 |          205 |               0.599 |
| ranking    | finalization      |            0.636 |           29 |               0.683 |
| ranking    | candidates        |            1.714 |            1 |               2.311 |
| ranking    | planning          |            0.474 |            2 |               1.130 |
| ranking    | queueWait         |            0.003 |            1 |               0.009 |
| ranking    | connectionStartup |           31.797 |            1 |              33.884 |
| ranking    | execution         |         1121.871 |            1 |            1339.279 |
| ranking    | revalidation      |            3.083 |            2 |               4.952 |

## Workload: 100 customers / 1000000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.036 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.018 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.015 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.430 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     0.975 |     n/a |
| relate/objects/warm                           |      30 |        0 |     0.825 |   1.018 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |    59.943 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |    58.156 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |    58.706 |  60.782 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   135.045 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |   124.506 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |   123.945 | 132.724 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   220.702 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   191.363 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   191.110 | 198.666 |
| relate/ranking/first-of-scenario              |       1 |        0 |   214.901 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   195.046 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   197.530 | 379.817 |

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

## Workload: 100 customers / 1000000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.039 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.013 |   0.025 |
| relate/objects/first-of-scenario              |       1 |        0 |     1.643 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     1.167 |     n/a |
| relate/objects/warm                           |      30 |        0 |     0.996 |   1.105 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |    56.068 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |    54.224 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |    54.236 |  55.597 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   140.115 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |   119.411 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |   120.547 | 130.199 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   227.674 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   192.818 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   191.916 | 230.016 |
| relate/ranking/first-of-scenario              |       1 |        0 |   187.296 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   177.409 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   192.167 | 204.246 |

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
| objects    | capturedOperations    |      1 |
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
| enrichment | preparation       |            1.343 |            1 |               2.151 |
| enrichment | dependencyReads   |           10.172 |           56 |               1.001 |
| enrichment | finalization      |            0.780 |            4 |               0.709 |
| enrichment | candidates        |            2.704 |            1 |               3.753 |
| enrichment | planning          |            0.585 |            2 |               0.734 |
| enrichment | queueWait         |            0.007 |            1 |               0.161 |
| enrichment | connectionStartup |            7.185 |            1 |               8.842 |
| enrichment | execution         |          103.296 |            1 |             118.709 |
| enrichment | revalidation      |            2.749 |            1 |               4.438 |
| ranking    | preparation       |            1.344 |            1 |               2.463 |
| ranking    | dependencyReads   |           33.105 |          205 |               4.133 |
| ranking    | finalization      |            1.851 |           29 |               1.318 |
| ranking    | candidates        |            5.549 |            1 |              13.776 |
| ranking    | planning          |            1.407 |            2 |               1.575 |
| ranking    | queueWait         |            0.007 |            1 |               0.009 |
| ranking    | connectionStartup |            7.313 |            1 |               8.841 |
| ranking    | execution         |          162.717 |            1 |             174.435 |
| ranking    | revalidation      |           10.133 |            2 |              12.402 |

## Workload: 1000 customers / 100000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.050 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.020 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.016 |   0.026 |
| relate/objects/first-of-scenario              |       1 |        0 |     6.358 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     6.100 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.649 |   5.860 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.485 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.438 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.406 |   0.439 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    56.078 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    55.413 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    57.010 |  60.243 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    17.741 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    17.648 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    17.399 |  18.103 |
| relate/ranking/first-of-scenario              |       1 |        0 |   224.201 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   220.829 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   212.986 | 218.947 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     35 |
| objects    | objectLoads           |     35 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     85 |
| objects    | sourceCalls           |     85 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     35 |
| enrichment | objectLoads           |     60 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    160 |
| enrichment | sourceCalls           |    160 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 1000 customers / 100000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.038 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.021 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.018 |
| relate/objects/first-of-scenario              |       1 |        0 |     6.027 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     5.441 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.398 |   5.692 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.452 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.383 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.367 |   0.375 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    55.375 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    57.329 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    57.826 |  60.633 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    18.822 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    18.685 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    17.742 |  19.825 |
| relate/ranking/first-of-scenario              |       1 |        0 |   208.907 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   214.425 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   213.145 | 217.851 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
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
| enrichment | membershipScans       |      3 |
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
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.581 |            1 |               0.700 |
| enrichment | dependencyReads   |            3.770 |           55 |               0.231 |
| enrichment | finalization      |            0.273 |            4 |               0.172 |
| enrichment | candidates        |            5.515 |            1 |               5.763 |
| enrichment | planning          |            0.203 |            2 |               0.229 |
| enrichment | queueWait         |            0.003 |            1 |               0.004 |
| enrichment | connectionStartup |           32.790 |            1 |              36.230 |
| enrichment | execution         |           17.083 |            1 |              17.732 |
| enrichment | revalidation      |            0.914 |            1 |               1.111 |
| ranking    | preparation       |            0.576 |            1 |               1.421 |
| ranking    | dependencyReads   |          130.563 |         1825 |               1.395 |
| ranking    | finalization      |            4.830 |           38 |               3.307 |
| ranking    | candidates        |           30.030 |            1 |              30.901 |
| ranking    | planning          |            3.549 |            2 |               3.615 |
| ranking    | queueWait         |            0.005 |            1 |               0.009 |
| ranking    | connectionStartup |           32.320 |            1 |              34.951 |
| ranking    | execution         |          117.176 |            1 |             167.136 |
| ranking    | revalidation      |           25.244 |            2 |              32.826 |

## Workload: 1000 customers / 100000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.041 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.018 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.018 |
| relate/objects/first-of-scenario              |       1 |        0 |     5.665 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     5.475 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.325 |   5.617 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.388 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.319 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.321 |   0.352 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    32.704 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    24.766 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    23.313 |  25.506 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    20.213 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    17.413 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    17.626 |  18.496 |
| relate/ranking/first-of-scenario              |       1 |        0 |   122.179 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   110.728 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   108.546 | 116.777 |

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
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 1000 customers / 100000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.040 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.015 |
| relate/objects/first-of-scenario              |       1 |        0 |     5.477 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     5.389 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.484 |   5.759 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.474 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.408 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.406 |   0.464 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    32.087 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    23.574 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    23.887 |  25.366 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    20.623 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    17.701 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    17.581 |  20.937 |
| relate/ranking/first-of-scenario              |       1 |        0 |   127.597 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   115.426 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   105.843 | 117.093 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     27 |
| objects    | objectLoads           |     27 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     77 |
| objects    | sourceCalls           |     77 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     27 |
| enrichment | objectLoads           |     52 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    152 |
| enrichment | sourceCalls           |    152 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.581 |            1 |               0.654 |
| enrichment | dependencyReads   |            3.890 |           52 |               0.192 |
| enrichment | finalization      |            0.256 |            4 |               0.229 |
| enrichment | candidates        |            6.089 |            1 |               6.522 |
| enrichment | planning          |            0.224 |            2 |               0.270 |
| enrichment | queueWait         |            0.003 |            1 |               0.004 |
| enrichment | connectionStartup |            5.481 |            1 |               5.870 |
| enrichment | execution         |            9.882 |            1 |              11.642 |
| enrichment | revalidation      |            0.942 |            1 |               1.046 |
| ranking    | preparation       |            0.604 |            1 |               0.903 |
| ranking    | dependencyReads   |          129.223 |         1825 |               1.357 |
| ranking    | finalization      |            4.937 |           38 |               1.905 |
| ranking    | candidates        |           29.981 |            1 |              30.938 |
| ranking    | planning          |            3.687 |            2 |               3.470 |
| ranking    | queueWait         |            0.005 |            1 |               0.012 |
| ranking    | connectionStartup |            6.783 |            1 |              20.525 |
| ranking    | execution         |           34.527 |            1 |              44.472 |
| ranking    | revalidation      |           25.479 |            2 |              27.859 |

## Workload: 1000 customers / 1000000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.049 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.019 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.017 |
| relate/objects/first-of-scenario              |       1 |        0 |    10.874 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    10.636 |      n/a |
| relate/objects/warm                           |      30 |        0 |    10.500 |   12.033 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     4.076 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     3.898 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.887 |    4.028 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   184.218 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   183.342 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   183.149 |  353.029 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   233.804 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   206.135 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   207.331 |  231.121 |
| relate/ranking/first-of-scenario              |       1 |        0 |  1399.833 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  1419.143 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  1371.735 | 1426.284 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      6 |
| objects    | candidatesScanned     |     34 |
| objects    | objectLoads           |     34 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     84 |
| objects    | sourceCalls           |     84 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      0 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      6 |
| enrichment | candidatesScanned     |     34 |
| enrichment | objectLoads           |     59 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    159 |
| enrichment | sourceCalls           |    159 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 1000 customers / 1000000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.046 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.020 |
| relate/objects/first-of-scenario              |       1 |        0 |     8.199 |      n/a |
| relate/objects/warmup                         |       3 |        0 |     7.649 |      n/a |
| relate/objects/warm                           |      30 |        0 |     7.148 |    7.411 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     3.016 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     2.992 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.046 |    3.215 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   172.304 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   168.614 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   166.085 |  174.521 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   189.602 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   193.132 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   191.074 |  198.705 |
| relate/ranking/first-of-scenario              |       1 |        0 |  1385.043 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  1379.827 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  1369.308 | 1589.190 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      4 |
| objects    | candidatesScanned     |     35 |
| objects    | objectLoads           |     35 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     85 |
| objects    | sourceCalls           |     85 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      4 |
| enrichment | candidatesScanned     |     35 |
| enrichment | objectLoads           |     60 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    160 |
| enrichment | sourceCalls           |    160 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.580 |            1 |               0.919 |
| enrichment | dependencyReads   |            5.672 |           60 |               0.241 |
| enrichment | finalization      |            0.287 |            4 |               0.288 |
| enrichment | candidates        |            7.309 |            1 |               7.926 |
| enrichment | planning          |            0.208 |            2 |               0.263 |
| enrichment | queueWait         |            0.003 |            1 |               0.008 |
| enrichment | connectionStartup |           31.245 |            1 |              33.115 |
| enrichment | execution         |          124.394 |            1 |             188.315 |
| enrichment | revalidation      |            1.120 |            1 |               1.670 |
| ranking    | preparation       |            0.639 |            1 |               0.749 |
| ranking    | dependencyReads   |          134.478 |         1825 |               0.943 |
| ranking    | finalization      |            4.839 |           38 |               1.676 |
| ranking    | candidates        |           30.410 |            1 |              34.435 |
| ranking    | planning          |            4.066 |            2 |               3.831 |
| ranking    | queueWait         |            0.005 |            1 |               0.009 |
| ranking    | connectionStartup |           31.634 |            1 |              35.179 |
| ranking    | execution         |         1270.233 |            1 |            1830.064 |
| ranking    | revalidation      |           27.386 |            2 |              28.986 |

## Workload: 1000 customers / 1000000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.057 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |   0.019 |
| relate/objects/first-of-scenario              |       1 |        0 |     6.408 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     5.595 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.646 |   5.906 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     4.501 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     4.454 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     4.421 |   4.545 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   107.438 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    83.714 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    94.217 | 104.603 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   220.261 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   191.382 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   193.634 | 203.795 |
| relate/ranking/first-of-scenario              |       1 |        0 |   387.029 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   374.335 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   394.324 | 427.721 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
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
| enrichment | membershipScans       |      3 |
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
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 1000 customers / 1000000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |  p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | ------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.044 |     n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.019 |     n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |   0.016 |
| relate/objects/first-of-scenario              |       1 |        0 |     6.621 |     n/a |
| relate/objects/warmup                         |       3 |        0 |     5.624 |     n/a |
| relate/objects/warm                           |      30 |        0 |     5.513 |   5.670 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     4.101 |     n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     3.898 |     n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     3.956 |   4.185 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    97.177 |     n/a |
| relate/enrichment/warmup                      |       3 |        0 |    79.349 |     n/a |
| relate/enrichment/warm                        |      30 |        0 |    96.174 |  99.093 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   228.521 |     n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   192.897 |     n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   197.016 | 205.776 |
| relate/ranking/first-of-scenario              |       1 |        0 |   438.988 |     n/a |
| relate/ranking/warmup                         |       3 |        0 |   410.120 |     n/a |
| relate/ranking/warm                           |      30 |        0 |   410.861 | 436.197 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
| objects    | candidatesScanned     |     36 |
| objects    | objectLoads           |     36 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     86 |
| objects    | sourceCalls           |     86 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      3 |
| enrichment | candidatesScanned     |     36 |
| enrichment | objectLoads           |     61 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    161 |
| enrichment | sourceCalls           |    161 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |     10 |
| ranking    | candidatesScanned     |   1000 |
| ranking    | objectLoads           |   1825 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |   5075 |
| ranking    | sourceCalls           |   5075 |
| ranking    | analyticalBatches     |      1 |
| ranking    | analyticalStatements  |      1 |
| ranking    | computedSlots         |    800 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |    800 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            1.548 |            1 |               2.094 |
| enrichment | dependencyReads   |           19.212 |           61 |               0.812 |
| enrichment | finalization      |            0.870 |            4 |               0.557 |
| enrichment | candidates        |           17.604 |            1 |              21.333 |
| enrichment | planning          |            0.596 |            2 |               0.622 |
| enrichment | queueWait         |            0.008 |            1 |               0.011 |
| enrichment | connectionStartup |            6.850 |            1 |               8.202 |
| enrichment | execution         |           63.829 |            1 |              67.263 |
| enrichment | revalidation      |            3.596 |            1 |               5.671 |
| ranking    | preparation       |            0.818 |            1 |               1.100 |
| ranking    | dependencyReads   |          168.036 |         1825 |               3.343 |
| ranking    | finalization      |            8.667 |           38 |               7.157 |
| ranking    | candidates        |           35.898 |            1 |              38.193 |
| ranking    | planning          |            3.802 |            2 |               3.762 |
| ranking    | queueWait         |            0.005 |            1 |               0.011 |
| ranking    | connectionStartup |            6.236 |            1 |             286.920 |
| ranking    | execution         |          300.490 |            1 |             324.095 |
| ranking    | revalidation      |           55.907 |            2 |              61.737 |

## Workload: 10000 customers / 100000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.062 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.023 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.022 |
| relate/objects/first-of-scenario              |       1 |        0 |    68.173 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    66.550 |      n/a |
| relate/objects/warm                           |      30 |        0 |    66.191 |   67.562 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.164 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.085 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.080 |    0.094 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   117.870 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   117.680 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   117.922 |  121.700 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    27.048 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    24.431 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    23.493 |   24.485 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2369.901 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2447.222 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2403.453 | 2486.330 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
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
| enrichment | membershipScans       |      3 |
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
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 10000 customers / 100000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.050 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.018 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |    0.021 |
| relate/objects/first-of-scenario              |       1 |        0 |    68.749 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    66.742 |      n/a |
| relate/objects/warm                           |      30 |        0 |    66.352 |   67.810 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.170 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.094 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.083 |    0.095 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   115.578 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   114.344 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   119.194 |  121.476 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    25.792 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    25.985 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    25.212 |   26.625 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2351.082 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2457.833 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2470.973 | 5272.799 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
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
| enrichment | membershipScans       |      3 |
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
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.580 |            1 |               0.680 |
| enrichment | dependencyReads   |           11.087 |           55 |               0.477 |
| enrichment | finalization      |            0.288 |            4 |               0.160 |
| enrichment | candidates        |           68.416 |            1 |              69.988 |
| enrichment | planning          |            0.233 |            2 |               0.238 |
| enrichment | queueWait         |            0.004 |            1 |               0.005 |
| enrichment | connectionStartup |           32.468 |            1 |              34.724 |
| enrichment | execution         |           14.564 |            1 |              15.348 |
| enrichment | revalidation      |            1.786 |            1 |               2.091 |
| ranking    | preparation       |            0.596 |            1 |               1.103 |
| ranking    | dependencyReads   |         4087.142 |        18025 |              90.495 |
| ranking    | finalization      |           48.817 |          135 |              38.005 |
| ranking    | candidates        |         1711.631 |            1 |            4374.095 |
| ranking    | planning          |           38.118 |            9 |             221.829 |
| ranking    | queueWait         |            0.031 |            8 |               0.014 |
| ranking    | connectionStartup |          261.921 |            8 |             155.523 |
| ranking    | execution         |          349.661 |            8 |             198.666 |
| ranking    | revalidation      |          543.357 |            2 |            1530.955 |

## Workload: 10000 customers / 100000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.050 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.021 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.022 |
| relate/objects/first-of-scenario              |       1 |        0 |    72.989 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    68.708 |      n/a |
| relate/objects/warm                           |      30 |        0 |    68.349 |   70.976 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.154 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.075 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.070 |    0.072 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    96.054 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |    94.229 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |    92.325 |  114.460 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    27.815 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    24.915 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    23.702 |   29.203 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2345.152 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2312.398 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2330.707 | 2385.190 |

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
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 10000 customers / 100000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.063 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.025 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.020 |
| relate/objects/first-of-scenario              |       1 |        0 |    68.885 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    66.648 |      n/a |
| relate/objects/warm                           |      30 |        0 |    66.546 |   68.400 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.180 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.090 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.073 |    0.085 |
| relate/enrichment/first-of-scenario           |       1 |        0 |    90.394 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |    94.049 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |    92.169 |   95.793 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    25.666 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |    23.070 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |    23.831 |   26.562 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2353.595 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2322.883 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2337.443 | 2401.457 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      3 |
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
| enrichment | membershipScans       |      3 |
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
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.586 |            1 |               0.680 |
| enrichment | dependencyReads   |           11.003 |           55 |               0.447 |
| enrichment | finalization      |            0.247 |            4 |               0.156 |
| enrichment | candidates        |           67.410 |            1 |              68.888 |
| enrichment | planning          |            0.225 |            2 |               0.228 |
| enrichment | queueWait         |            0.004 |            1 |               0.009 |
| enrichment | connectionStartup |            9.644 |            1 |              11.240 |
| enrichment | execution         |           11.097 |            1 |              16.120 |
| enrichment | revalidation      |            1.706 |            1 |               1.986 |
| ranking    | preparation       |            0.605 |            1 |               0.731 |
| ranking    | dependencyReads   |         3916.551 |        18025 |              27.500 |
| ranking    | finalization      |           45.700 |          135 |               8.664 |
| ranking    | candidates        |         1653.701 |            1 |            1702.894 |
| ranking    | planning          |           38.532 |            9 |              37.533 |
| ranking    | queueWait         |            0.028 |            8 |               0.012 |
| ranking    | connectionStartup |           91.977 |            8 |              16.843 |
| ranking    | execution         |          255.314 |            8 |              46.372 |
| ranking    | revalidation      |          533.279 |            2 |             601.031 |

## Workload: 10000 customers / 1000000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.052 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.016 |
| relate/objects/first-of-scenario              |       1 |        0 |    65.852 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    67.958 |      n/a |
| relate/objects/warm                           |      30 |        0 |    66.337 |   70.111 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.534 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.428 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.396 |    0.473 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   208.863 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   210.293 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   206.891 |  221.637 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   205.343 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   207.360 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   209.236 |  214.238 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2984.897 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2991.779 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  3002.846 | 3093.900 |

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
| objects    | capturedOperations    |      0 |
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
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 10000 customers / 1000000 events

Backend: sqlite; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.048 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.022 |
| relate/objects/first-of-scenario              |       1 |        0 |    23.842 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    23.148 |      n/a |
| relate/objects/warm                           |      30 |        0 |    22.823 |   23.742 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.557 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.466 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.424 |    0.481 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   167.273 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   167.598 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   167.729 |  187.209 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   205.645 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   219.112 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   357.771 |  406.469 |
| relate/ranking/first-of-scenario              |       1 |        0 |  4204.819 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  3288.932 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  3039.929 | 3174.033 |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      1 |
| objects    | candidatesScanned     |     25 |
| objects    | objectLoads           |     25 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     75 |
| objects    | sourceCalls           |     75 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      1 |
| enrichment | candidatesScanned     |     25 |
| enrichment | objectLoads           |     50 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    150 |
| enrichment | sourceCalls           |    150 |
| enrichment | analyticalBatches     |      1 |
| enrichment | analyticalStatements  |      1 |
| enrichment | computedSlots         |     25 |
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.562 |            1 |               0.681 |
| enrichment | dependencyReads   |           10.696 |           50 |               1.676 |
| enrichment | finalization      |            0.286 |            4 |               0.307 |
| enrichment | candidates        |           22.798 |            1 |              28.345 |
| enrichment | planning          |            0.224 |            2 |               0.478 |
| enrichment | queueWait         |            0.004 |            1 |               0.007 |
| enrichment | connectionStartup |           32.841 |            1 |              51.728 |
| enrichment | execution         |          108.248 |            1 |             112.295 |
| enrichment | revalidation      |            1.810 |            1 |               1.958 |
| ranking    | preparation       |            0.583 |            1 |               0.829 |
| ranking    | dependencyReads   |         4030.744 |        18025 |              31.772 |
| ranking    | finalization      |           48.106 |          135 |              10.846 |
| ranking    | candidates        |         1669.112 |            1 |            1832.227 |
| ranking    | planning          |           38.509 |            9 |              37.699 |
| ranking    | queueWait         |            0.033 |            8 |               0.038 |
| ranking    | connectionStartup |          253.176 |            8 |              37.012 |
| ranking    | execution         |         2746.902 |            8 |             426.358 |
| ranking    | revalidation      |          541.218 |            2 |             593.790 |

## Workload: 10000 customers / 1000000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.058 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.020 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.015 |    0.016 |
| relate/objects/first-of-scenario              |       1 |        0 |    69.427 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    67.090 |      n/a |
| relate/objects/warm                           |      30 |        0 |    66.029 |   68.659 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.656 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.564 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.561 |    0.600 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   137.844 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   127.389 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   126.754 |  131.980 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   207.428 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   206.984 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   206.203 |  217.666 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2768.323 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2814.877 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2735.876 | 2813.211 |

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
| objects    | capturedOperations    |      0 |
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
| enrichment | capturedOperations    |      0 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      0 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |
| -------- | ----- | ---------------: | -----------: | ------------------: |

## Workload: 10000 customers / 1000000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms |   p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -------: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.047 |      n/a |
| sqlite-reference/objects/warmup               |       3 |        0 |     0.017 |      n/a |
| sqlite-reference/objects/warm                 |      30 |        0 |     0.014 |    0.015 |
| relate/objects/first-of-scenario              |       1 |        0 |    45.151 |      n/a |
| relate/objects/warmup                         |       3 |        0 |    43.594 |      n/a |
| relate/objects/warm                           |      30 |        0 |    43.405 |   44.151 |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.444 |      n/a |
| sqlite-reference/enrichment/warmup            |       3 |        0 |     0.349 |      n/a |
| sqlite-reference/enrichment/warm              |      30 |        0 |     0.348 |    0.382 |
| relate/enrichment/first-of-scenario           |       1 |        0 |   122.779 |      n/a |
| relate/enrichment/warmup                      |       3 |        0 |   103.588 |      n/a |
| relate/enrichment/warm                        |      30 |        0 |   102.395 |  105.320 |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   207.818 |      n/a |
| sqlite-reference/ranking/warmup               |       3 |        0 |   204.302 |      n/a |
| sqlite-reference/ranking/warm                 |      30 |        0 |   202.477 |  207.105 |
| relate/ranking/first-of-scenario              |       1 |        0 |  2637.974 |      n/a |
| relate/ranking/warmup                         |       3 |        0 |  2689.602 |      n/a |
| relate/ranking/warm                           |      30 |        0 |  2728.723 | 2784.650 |

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
| objects    | capturedOperations    |      1 |
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
| enrichment | capturedOperations    |      1 |
| enrichment | candidatesAdmitted    |     25 |
| enrichment | objectsReturned       |     25 |
| enrichment | activityDrops         |      0 |
| ranking    | membershipScans       |    100 |
| ranking    | candidatesScanned     |  10000 |
| ranking    | objectLoads           |  18025 |
| ranking    | sourceResolutions     |      0 |
| ranking    | sourceFetches         |      0 |
| ranking    | sourceIdentifications |  50075 |
| ranking    | sourceCalls           |  50075 |
| ranking    | analyticalBatches     |      8 |
| ranking    | analyticalStatements  |      8 |
| ranking    | computedSlots         |   8000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |   8000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.566 |            1 |               0.657 |
| enrichment | dependencyReads   |           10.985 |           52 |               0.432 |
| enrichment | finalization      |            0.269 |            4 |               0.157 |
| enrichment | candidates        |           45.217 |            1 |              47.283 |
| enrichment | planning          |            0.232 |            2 |               0.227 |
| enrichment | queueWait         |            0.004 |            1 |               0.009 |
| enrichment | connectionStartup |            6.227 |            1 |               7.439 |
| enrichment | execution         |           47.379 |            1 |              50.587 |
| enrichment | revalidation      |            1.850 |            1 |               2.117 |
| ranking    | preparation       |            0.599 |            1 |               0.696 |
| ranking    | dependencyReads   |         4022.018 |        18025 |              13.685 |
| ranking    | finalization      |           68.305 |          135 |              10.300 |
| ranking    | candidates        |         1652.461 |            1 |            1730.072 |
| ranking    | planning          |           40.100 |            9 |              37.111 |
| ranking    | queueWait         |            0.059 |            8 |               0.029 |
| ranking    | connectionStartup |          109.925 |            8 |              30.003 |
| ranking    | execution         |         1661.155 |            8 |             285.153 |
| ranking    | revalidation      |          547.842 |            2 |             590.205 |

## Activity instrumentation comparison

Paired configurations use the same seeded data and request semantics. These
sequential median differences include capture and timing overhead plus
run-to-run noise; negative differences are retained. They exclude waiting for
asynchronous activity delivery and are not causal estimates of timing calls
alone.

| Backend/store/freshness | Customers/events | Scenario   | Disabled ms | Enabled ms | Difference ms | Ratio |
| ----------------------- | ---------------- | ---------- | ----------: | ---------: | ------------: | ----: |
| sqlite/memory/cached    | 100/100000       | objects    |       1.078 |      0.857 |        -0.221 | 0.795 |
| sqlite/memory/cached    | 100/100000       | enrichment |      76.610 |     71.926 |        -4.684 | 0.939 |
| sqlite/memory/cached    | 100/100000       | ranking    |     138.249 |    138.972 |         0.723 | 1.005 |
| postgres/memory/cached  | 100/100000       | objects    |       0.870 |      0.960 |         0.090 | 1.104 |
| postgres/memory/cached  | 100/100000       | enrichment |      29.577 |     27.576 |        -2.001 | 0.932 |
| postgres/memory/cached  | 100/100000       | ranking    |      33.175 |     37.728 |         4.554 | 1.137 |
| sqlite/memory/cached    | 100/1000000      | objects    |       0.840 |      0.764 |        -0.076 | 0.910 |
| sqlite/memory/cached    | 100/1000000      | enrichment |     440.515 |    422.445 |       -18.070 | 0.959 |
| sqlite/memory/cached    | 100/1000000      | ranking    |    1151.699 |   1161.065 |         9.367 | 1.008 |
| postgres/memory/cached  | 100/1000000      | objects    |       0.825 |      0.996 |         0.170 | 1.207 |
| postgres/memory/cached  | 100/1000000      | enrichment |     123.945 |    120.547 |        -3.397 | 0.973 |
| postgres/memory/cached  | 100/1000000      | ranking    |     197.530 |    192.167 |        -5.364 | 0.973 |
| sqlite/memory/cached    | 1000/100000      | objects    |       5.649 |      5.398 |        -0.250 | 0.956 |
| sqlite/memory/cached    | 1000/100000      | enrichment |      57.010 |     57.826 |         0.817 | 1.014 |
| sqlite/memory/cached    | 1000/100000      | ranking    |     212.986 |    213.145 |         0.158 | 1.001 |
| postgres/memory/cached  | 1000/100000      | objects    |       5.325 |      5.484 |         0.159 | 1.030 |
| postgres/memory/cached  | 1000/100000      | enrichment |      23.313 |     23.887 |         0.574 | 1.025 |
| postgres/memory/cached  | 1000/100000      | ranking    |     108.546 |    105.843 |        -2.704 | 0.975 |
| sqlite/memory/cached    | 1000/1000000     | objects    |      10.500 |      7.148 |        -3.352 | 0.681 |
| sqlite/memory/cached    | 1000/1000000     | enrichment |     183.149 |    166.085 |       -17.064 | 0.907 |
| sqlite/memory/cached    | 1000/1000000     | ranking    |    1371.735 |   1369.308 |        -2.427 | 0.998 |
| postgres/memory/cached  | 1000/1000000     | objects    |       5.646 |      5.513 |        -0.133 | 0.977 |
| postgres/memory/cached  | 1000/1000000     | enrichment |      94.217 |     96.174 |         1.957 | 1.021 |
| postgres/memory/cached  | 1000/1000000     | ranking    |     394.324 |    410.861 |        16.538 | 1.042 |
| sqlite/memory/cached    | 10000/100000     | objects    |      66.191 |     66.352 |         0.160 | 1.002 |
| sqlite/memory/cached    | 10000/100000     | enrichment |     117.922 |    119.194 |         1.272 | 1.011 |
| sqlite/memory/cached    | 10000/100000     | ranking    |    2403.453 |   2470.973 |        67.520 | 1.028 |
| postgres/memory/cached  | 10000/100000     | objects    |      68.349 |     66.546 |        -1.803 | 0.974 |
| postgres/memory/cached  | 10000/100000     | enrichment |      92.325 |     92.169 |        -0.157 | 0.998 |
| postgres/memory/cached  | 10000/100000     | ranking    |    2330.707 |   2337.443 |         6.736 | 1.003 |
| sqlite/memory/cached    | 10000/1000000    | objects    |      66.337 |     22.823 |       -43.513 | 0.344 |
| sqlite/memory/cached    | 10000/1000000    | enrichment |     206.891 |    167.729 |       -39.162 | 0.811 |
| sqlite/memory/cached    | 10000/1000000    | ranking    |    3002.846 |   3039.929 |        37.083 | 1.012 |
| postgres/memory/cached  | 10000/1000000    | objects    |      66.029 |     43.405 |       -22.624 | 0.657 |
| postgres/memory/cached  | 10000/1000000    | enrichment |     126.754 |    102.395 |       -24.358 | 0.808 |
| postgres/memory/cached  | 10000/1000000    | ranking    |    2735.876 |   2728.723 |        -7.153 | 0.997 |
