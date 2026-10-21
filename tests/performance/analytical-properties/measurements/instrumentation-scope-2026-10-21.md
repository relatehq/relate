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
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.129 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.026 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.023 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    93.281 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    84.150 |    n/a |
| relate/objects/warm                           |       3 |        0 |    84.541 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.164 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.080 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.067 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   145.674 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   133.965 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   135.104 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.165 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.043 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    24.861 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4016.354 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3560.676 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3587.499 |    n/a |

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
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.047 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    92.557 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    84.672 |    n/a |
| relate/objects/warm                           |       3 |        0 |    82.680 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.158 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.085 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.073 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   131.130 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   134.599 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   131.182 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.462 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    24.591 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    24.764 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3524.479 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3660.389 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3573.090 |    n/a |

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
| enrichment | preparation       |            0.677 |            1 |               0.773 |
| enrichment | dependencyReads   |           13.495 |           55 |               0.549 |
| enrichment | finalization      |            0.279 |            4 |               0.149 |
| enrichment | candidates        |           82.747 |            1 |              83.767 |
| enrichment | planning          |            0.228 |            2 |               0.217 |
| enrichment | queueWait         |            0.003 |            1 |               0.003 |
| enrichment | connectionStartup |           31.432 |            1 |              31.567 |
| enrichment | execution         |           13.386 |            1 |              13.451 |
| enrichment | revalidation      |            2.128 |            1 |               2.266 |
| ranking    | preparation       |            0.649 |            1 |               0.655 |
| ranking    | dependencyReads   |         5850.412 |        22525 |               2.953 |
| ranking    | finalization      |           57.193 |          162 |              12.630 |
| ranking    | candidates        |         2530.945 |            1 |            2549.524 |
| ranking    | planning          |           47.425 |           11 |              44.126 |
| ranking    | queueWait         |            0.033 |           10 |               0.008 |
| ranking    | connectionStartup |          317.428 |           10 |              35.070 |
| ranking    | execution         |          406.233 |           10 |              47.621 |
| ranking    | revalidation      |          748.337 |            2 |             747.139 |

## Workload: 12500 customers / 100000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.053 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.025 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    87.078 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    85.097 |    n/a |
| relate/objects/warm                           |       3 |        0 |    83.852 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.148 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.079 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.068 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   108.371 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   114.216 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   114.481 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.702 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    24.831 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    24.703 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3739.909 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3508.893 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3528.877 |    n/a |

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
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.049 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.026 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.018 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    57.401 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    55.513 |    n/a |
| relate/objects/warm                           |       3 |        0 |    55.537 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.202 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.088 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.083 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |    74.488 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    71.754 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    82.008 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.838 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    24.843 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    24.735 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  3666.093 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  3495.818 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  3495.761 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
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
| enrichment | membershipScans       |      2 |
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
| enrichment | preparation       |            0.576 |            1 |               0.624 |
| enrichment | dependencyReads   |           14.854 |           59 |               0.491 |
| enrichment | finalization      |            0.250 |            4 |               0.148 |
| enrichment | candidates        |           56.477 |            1 |              56.630 |
| enrichment | planning          |            0.210 |            2 |               0.209 |
| enrichment | queueWait         |            0.003 |            1 |               0.004 |
| enrichment | connectionStartup |            9.463 |            1 |              11.775 |
| enrichment | execution         |           10.321 |            1 |              13.752 |
| enrichment | revalidation      |            1.982 |            1 |               1.998 |
| ranking    | preparation       |            0.640 |            1 |               0.655 |
| ranking    | dependencyReads   |         5817.893 |        22525 |               1.752 |
| ranking    | finalization      |           59.330 |          162 |              12.567 |
| ranking    | candidates        |         2532.944 |            1 |            2538.697 |
| ranking    | planning          |           49.406 |           11 |              45.256 |
| ranking    | queueWait         |            0.033 |           10 |               0.007 |
| ranking    | connectionStartup |          110.951 |           10 |              16.004 |
| ranking    | execution         |          310.558 |           10 |              45.462 |
| ranking    | revalidation      |          757.688 |            2 |             766.258 |

## Workload: 12500 customers / 1000000 events

Backend: sqlite; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.056 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.022 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.017 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |   111.804 |    n/a |
| relate/objects/warmup                         |       1 |        0 |   110.994 |    n/a |
| relate/objects/warm                           |       3 |        0 |   111.278 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.426 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.320 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.314 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   244.693 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   246.533 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   246.943 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   207.199 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   220.168 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   208.555 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4365.863 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4365.571 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4348.253 |    n/a |

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
| objects    | capturedOperations    |      0 |
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
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.049 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    62.149 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    59.838 |    n/a |
| relate/objects/warm                           |       3 |        0 |    57.189 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.467 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.380 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.364 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   193.514 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   193.974 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   194.203 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   211.327 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   206.751 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   205.432 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4408.183 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4370.358 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4403.822 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     26 |
| objects    | objectLoads           |     26 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |      0 |
| objects    | sourceIdentifications |     76 |
| objects    | sourceCalls           |     76 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      2 |
| enrichment | candidatesScanned     |     26 |
| enrichment | objectLoads           |     51 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |      0 |
| enrichment | sourceIdentifications |    151 |
| enrichment | sourceCalls           |    151 |
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
| enrichment | preparation       |            0.582 |            1 |               0.598 |
| enrichment | dependencyReads   |           10.896 |           51 |               0.405 |
| enrichment | finalization      |            0.310 |            4 |               0.154 |
| enrichment | candidates        |           55.787 |            1 |              56.316 |
| enrichment | planning          |            0.218 |            2 |               0.190 |
| enrichment | queueWait         |            0.003 |            1 |               0.003 |
| enrichment | connectionStartup |           31.096 |            1 |              31.265 |
| enrichment | execution         |          104.047 |            1 |             106.001 |
| enrichment | revalidation      |            1.953 |            1 |               2.128 |
| ranking    | preparation       |            0.708 |            1 |               0.730 |
| ranking    | dependencyReads   |         5850.798 |        22525 |               1.412 |
| ranking    | finalization      |           57.721 |          162 |              14.069 |
| ranking    | candidates        |         2538.371 |            1 |            2546.845 |
| ranking    | planning          |           49.654 |           11 |              47.272 |
| ranking    | queueWait         |            0.041 |           10 |               0.008 |
| ranking    | connectionStartup |          313.682 |           10 |              34.946 |
| ranking    | execution         |         3023.477 |           10 |             311.962 |
| ranking    | revalidation      |          773.445 |            2 |             773.608 |

## Workload: 12500 customers / 1000000 events

Backend: postgres; object store: memory; capture: disabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.055 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.022 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    58.157 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    57.180 |    n/a |
| relate/objects/warm                           |       3 |        0 |    57.571 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.393 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.309 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.305 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   139.278 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   121.076 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   120.450 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   212.998 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   206.793 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   210.272 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4329.888 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4034.746 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4062.862 |    n/a |

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

## Workload: 12500 customers / 1000000 events

Backend: postgres; object store: memory; capture: enabled; freshness: cached;
synthetic refresh delay: 0 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.048 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.020 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.016 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    56.928 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    59.196 |    n/a |
| relate/objects/warm                           |       3 |        0 |    58.561 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.371 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.275 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.267 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   136.629 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   118.502 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   123.501 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |   210.018 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |   208.938 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |   206.931 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 |  4064.026 |    n/a |
| relate/ranking/warmup                         |       1 |        0 |  4071.701 |    n/a |
| relate/ranking/warm                           |       3 |        0 |  4089.900 |    n/a |

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
| enrichment | preparation       |            0.643 |            1 |               0.778 |
| enrichment | dependencyReads   |           14.968 |           55 |               1.243 |
| enrichment | finalization      |            0.304 |            4 |               0.164 |
| enrichment | candidates        |           59.657 |            1 |              96.775 |
| enrichment | planning          |            0.244 |            2 |               0.220 |
| enrichment | queueWait         |            0.004 |            1 |               0.005 |
| enrichment | connectionStartup |            6.687 |            1 |              11.847 |
| enrichment | execution         |           50.056 |            1 |              53.306 |
| enrichment | revalidation      |            2.325 |            1 |               2.681 |
| ranking    | preparation       |            0.650 |            1 |               0.655 |
| ranking    | dependencyReads   |         6090.008 |        22525 |               3.127 |
| ranking    | finalization      |           87.061 |          162 |              13.949 |
| ranking    | candidates        |         2567.068 |            1 |            2588.566 |
| ranking    | planning          |           54.546 |           11 |              46.891 |
| ranking    | queueWait         |            0.093 |           10 |               0.088 |
| ranking    | connectionStartup |          142.881 |           10 |              27.587 |
| ranking    | execution         |         1965.833 |           10 |             222.061 |
| ranking    | revalidation      |          785.953 |            2 |             801.861 |

## Activity instrumentation comparison

Paired configurations use the same seeded data and request semantics. These
sequential median differences include capture and timing overhead plus
run-to-run noise; negative differences are retained. They exclude waiting for
asynchronous activity delivery and are not causal estimates of timing calls
alone.

| Backend/store/freshness | Customers/events | Scenario   | Disabled ms | Enabled ms | Difference ms | Ratio |
| ----------------------- | ---------------- | ---------- | ----------: | ---------: | ------------: | ----: |
| sqlite/memory/cached    | 12500/100000     | objects    |      84.541 |     82.680 |        -1.862 | 0.978 |
| sqlite/memory/cached    | 12500/100000     | enrichment |     135.104 |    131.182 |        -3.922 | 0.971 |
| sqlite/memory/cached    | 12500/100000     | ranking    |    3587.499 |   3573.090 |       -14.409 | 0.996 |
| postgres/memory/cached  | 12500/100000     | objects    |      83.852 |     55.537 |       -28.315 | 0.662 |
| postgres/memory/cached  | 12500/100000     | enrichment |     114.481 |     82.008 |       -32.473 | 0.716 |
| postgres/memory/cached  | 12500/100000     | ranking    |    3528.877 |   3495.761 |       -33.117 | 0.991 |
| sqlite/memory/cached    | 12500/1000000    | objects    |     111.278 |     57.189 |       -54.089 | 0.514 |
| sqlite/memory/cached    | 12500/1000000    | enrichment |     246.943 |    194.203 |       -52.741 | 0.786 |
| sqlite/memory/cached    | 12500/1000000    | ranking    |    4348.253 |   4403.822 |        55.569 | 1.013 |
| postgres/memory/cached  | 12500/1000000    | objects    |      57.571 |     58.561 |         0.990 | 1.017 |
| postgres/memory/cached  | 12500/1000000    | enrichment |     120.450 |    123.501 |         3.051 | 1.025 |
| postgres/memory/cached  | 12500/1000000    | ranking    |    4062.862 |   4089.900 |        27.038 | 1.007 |
