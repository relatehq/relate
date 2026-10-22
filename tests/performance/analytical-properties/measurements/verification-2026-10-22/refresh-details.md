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

Backend: sqlite; object store: postgres; capture: enabled; freshness: refresh;
synthetic refresh delay: 2 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.111 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.027 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.024 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |    55.959 |    n/a |
| relate/objects/warmup                         |       1 |        0 |    38.898 |    n/a |
| relate/objects/warm                           |       3 |        0 |    38.605 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.172 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.079 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.066 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   108.756 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |    97.009 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |    94.661 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    26.283 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    25.311 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    25.347 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 | 14555.346 |    n/a |
| relate/ranking/warmup                         |       1 |        0 | 14822.318 |    n/a |
| relate/ranking/warm                           |       3 |        0 | 14799.943 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      2 |
| objects    | candidatesScanned     |     28 |
| objects    | objectLoads           |     28 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |     28 |
| objects    | sourceIdentifications |     78 |
| objects    | sourceCalls           |    106 |
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
| enrichment | sourceFetches         |     28 |
| enrichment | sourceIdentifications |    153 |
| enrichment | sourceCalls           |    181 |
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
| ranking    | sourceFetches         |  12500 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  75075 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            0.915 |            1 |               0.958 |
| enrichment | dependencyReads   |          165.433 |           53 |               7.376 |
| enrichment | finalization      |            0.423 |            4 |               0.218 |
| enrichment | candidates        |           38.107 |            1 |              38.298 |
| enrichment | planning          |            0.316 |            2 |               0.303 |
| enrichment | queueWait         |            0.004 |            1 |               0.007 |
| enrichment | connectionStartup |           31.866 |            1 |              32.575 |
| enrichment | execution         |           13.181 |            1 |              13.189 |
| enrichment | revalidation      |            9.700 |            1 |               9.922 |
| ranking    | preparation       |            0.999 |            1 |               1.036 |
| ranking    | dependencyReads   |        73571.469 |        22525 |              56.824 |
| ranking    | finalization      |           89.683 |          162 |              24.387 |
| ranking    | candidates        |        11531.300 |            1 |           11531.458 |
| ranking    | planning          |           55.120 |           11 |              49.300 |
| ranking    | queueWait         |            0.042 |           10 |               0.013 |
| ranking    | connectionStartup |          317.693 |           10 |              36.034 |
| ranking    | execution         |          411.889 |           10 |              46.934 |
| ranking    | revalidation      |         2954.122 |            2 |            2947.606 |

## Workload: 12500 customers / 100000 events

Backend: postgres; object store: postgres; capture: enabled; freshness: refresh;
synthetic refresh delay: 2 ms.

| Mode/scenario/phase                           | Samples | Failures | Median ms | p95 ms |
| --------------------------------------------- | ------: | -------: | --------: | -----: |
| sqlite-reference/objects/first-of-scenario    |       1 |        0 |     0.061 |    n/a |
| sqlite-reference/objects/warmup               |       1 |        0 |     0.021 |    n/a |
| sqlite-reference/objects/warm                 |       3 |        0 |     0.019 |    n/a |
| relate/objects/first-of-scenario              |       1 |        0 |   157.533 |    n/a |
| relate/objects/warmup                         |       1 |        0 |   118.714 |    n/a |
| relate/objects/warm                           |       3 |        0 |   120.783 |    n/a |
| sqlite-reference/enrichment/first-of-scenario |       1 |        0 |     0.335 |    n/a |
| sqlite-reference/enrichment/warmup            |       1 |        0 |     0.190 |    n/a |
| sqlite-reference/enrichment/warm              |       3 |        0 |     0.202 |    n/a |
| relate/enrichment/first-of-scenario           |       1 |        0 |   209.133 |    n/a |
| relate/enrichment/warmup                      |       1 |        0 |   199.578 |    n/a |
| relate/enrichment/warm                        |       3 |        0 |   193.491 |    n/a |
| sqlite-reference/ranking/first-of-scenario    |       1 |        0 |    55.746 |    n/a |
| sqlite-reference/ranking/warmup               |       1 |        0 |    36.613 |    n/a |
| sqlite-reference/ranking/warm                 |       3 |        0 |    27.063 |    n/a |
| relate/ranking/first-of-scenario              |       1 |        0 | 20828.244 |    n/a |
| relate/ranking/warmup                         |       1 |        0 | 15095.471 |    n/a |
| relate/ranking/warm                           |       3 |        0 | 14704.496 |    n/a |

| Scenario   | Counter               | Median |
| ---------- | --------------------- | -----: |
| objects    | membershipScans       |      5 |
| objects    | candidatesScanned     |     30 |
| objects    | objectLoads           |     30 |
| objects    | sourceResolutions     |      0 |
| objects    | sourceFetches         |     30 |
| objects    | sourceIdentifications |     80 |
| objects    | sourceCalls           |    110 |
| objects    | analyticalBatches     |      0 |
| objects    | analyticalStatements  |      0 |
| objects    | computedSlots         |      0 |
| objects    | capturedOperations    |      1 |
| objects    | candidatesAdmitted    |     25 |
| objects    | objectsReturned       |     25 |
| objects    | activityDrops         |      0 |
| enrichment | membershipScans       |      5 |
| enrichment | candidatesScanned     |     30 |
| enrichment | objectLoads           |     55 |
| enrichment | sourceResolutions     |      0 |
| enrichment | sourceFetches         |     30 |
| enrichment | sourceIdentifications |    155 |
| enrichment | sourceCalls           |    185 |
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
| ranking    | sourceFetches         |  12500 |
| ranking    | sourceIdentifications |  62575 |
| ranking    | sourceCalls           |  75075 |
| ranking    | analyticalBatches     |     10 |
| ranking    | analyticalStatements  |     10 |
| ranking    | computedSlots         |  10000 |
| ranking    | capturedOperations    |      1 |
| ranking    | candidatesAdmitted    |  10000 |
| ranking    | objectsReturned       |     25 |
| ranking    | activityDrops         |      0 |

| Scenario   | Stage             | Median summed ms | Median spans | Longest observed ms |
| ---------- | ----------------- | ---------------: | -----------: | ------------------: |
| enrichment | preparation       |            1.742 |            1 |               1.930 |
| enrichment | dependencyReads   |          302.805 |           55 |              11.833 |
| enrichment | finalization      |            0.910 |            4 |               0.441 |
| enrichment | candidates        |          120.430 |            1 |             122.223 |
| enrichment | planning          |            0.771 |            2 |               0.654 |
| enrichment | queueWait         |            0.007 |            1 |               0.007 |
| enrichment | connectionStartup |            7.568 |            1 |               7.951 |
| enrichment | execution         |            6.964 |            1 |               7.210 |
| enrichment | revalidation      |           55.471 |            1 |              56.128 |
| ranking    | preparation       |            0.646 |            1 |               0.787 |
| ranking    | dependencyReads   |        73830.716 |        22525 |              35.517 |
| ranking    | finalization      |           87.011 |          162 |              26.187 |
| ranking    | candidates        |        11607.595 |            1 |           11672.061 |
| ranking    | planning          |           54.934 |           11 |              46.530 |
| ranking    | queueWait         |            0.042 |           10 |               0.013 |
| ranking    | connectionStartup |           92.922 |           10 |              22.269 |
| ranking    | execution         |          271.555 |           10 |              39.940 |
| ranking    | revalidation      |         2831.642 |            2 |            3299.550 |

## Activity instrumentation comparison

Paired configurations use the same seeded data and request semantics. These
sequential median differences include capture and timing overhead plus
run-to-run noise; negative differences are retained. They exclude waiting for
asynchronous activity delivery and are not causal estimates of timing calls
alone.

| Backend/store/freshness | Customers/events | Scenario | Disabled ms | Enabled ms | Difference ms | Ratio |
| ----------------------- | ---------------- | -------- | ----------: | ---------: | ------------: | ----: |
