# Full measured results

Warm requests only. All durations are milliseconds; p95 is nearest rank. Setup
and warmups are retained in the raw archives.

## small: 100 customers / 1,000 events

| Scenario     | Path              |   n | Median ms | p95 ms | Plan median | Collect median |
| ------------ | ----------------- | --: | --------: | -----: | ----------: | -------------: |
| bulk         | child-federated   |  24 |      3.80 |   4.73 |        1.14 |           2.46 |
| bulk         | child-scan        |  24 |      4.27 |   5.21 |        1.44 |           2.55 |
| bulk         | child-snapshot    |  24 |      2.09 |   2.65 |        1.52 |           0.31 |
| bulk         | http-federated    |  24 |      4.30 |   5.32 |        1.23 |           2.60 |
| bulk         | http-scan         |  24 |      4.07 |   5.36 |        1.34 |           2.23 |
| bulk         | native-js         |  24 |      1.48 |   2.22 |           — |              — |
| bulk         | neon-federated    |  24 |      4.03 |   5.06 |        1.40 |           2.57 |
| bulk         | neon-scan         |  24 |      4.42 |   5.76 |        1.66 |           2.53 |
| control      | child-federated   |  24 |      0.19 |   0.27 |        0.12 |           0.01 |
| control      | child-scan        |  24 |      0.18 |   0.31 |        0.12 |           0.01 |
| control      | child-snapshot    |  24 |      0.20 |   0.30 |        0.13 |           0.01 |
| control      | http-federated    |  24 |      0.59 |   0.77 |        0.12 |           0.01 |
| control      | http-scan         |  24 |      0.61 |   0.79 |        0.12 |           0.01 |
| control      | native-js         |  24 |    0.0039 | 0.0080 |           — |              — |
| control      | neon-federated    |  24 |      0.22 |   0.38 |        0.17 |           0.02 |
| control      | neon-scan         |  24 |      0.23 |   0.33 |        0.18 |           0.02 |
| multi        | child-federated   |  24 |      5.34 |   6.38 |        2.49 |           2.62 |
| multi        | child-scan        |  24 |      5.24 |   5.86 |        2.72 |           2.41 |
| multi        | child-snapshot    |  24 |      3.26 |   3.80 |        2.58 |           0.47 |
| multi        | http-federated    |  24 |      5.88 |   7.27 |        2.60 |           2.65 |
| multi        | http-scan         |  24 |      5.55 |   6.31 |        2.60 |           2.30 |
| multi        | native-js         |  24 |      1.53 |   2.14 |           — |              — |
| multi        | neon-federated    |  24 |      5.88 |   7.52 |        2.94 |           2.84 |
| multi        | neon-scan         |  24 |      5.40 |   6.23 |        2.90 |           2.45 |
| ranking-db   | child-federated   |  24 |      3.57 |   4.32 |        1.29 |           2.21 |
| ranking-db   | child-scan        |  24 |      3.40 |   4.23 |        1.61 |           1.51 |
| ranking-db   | child-snapshot    |  24 |      2.28 |   2.66 |        1.85 |           0.29 |
| ranking-db   | http-federated    |  24 |      3.99 |   4.87 |        1.33 |           2.24 |
| ranking-db   | http-scan         |  24 |      4.13 |   5.36 |        1.51 |           2.22 |
| ranking-db   | native-js         |  24 |      1.36 |   1.96 |           — |              — |
| ranking-db   | neon-federated    |  24 |      3.67 |   4.78 |        1.46 |           2.16 |
| ranking-db   | neon-scan         |  24 |      3.80 |   4.88 |        1.75 |           2.13 |
| ranking-db   | relate-child-scan |  24 |     15.99 |  24.06 |           — |              — |
| ranking-db   | relate-http-scan  |  24 |     16.72 |  19.07 |           — |              — |
| ranking-db   | relate-neon-scan  |  24 |     15.66 |  30.41 |           — |              — |
| ranking-db   | relate-postgres   |  24 |     18.00 |  23.73 |           — |              — |
| ranking-file | child-federated   |  24 |      2.60 |   2.99 |        1.82 |           0.63 |
| ranking-file | child-scan        |  24 |      2.92 |   3.53 |        2.03 |           0.69 |
| ranking-file | child-snapshot    |  24 |      2.26 |   2.90 |        1.77 |           0.31 |
| ranking-file | http-federated    |  24 |      2.91 |   3.82 |        1.86 |           0.56 |
| ranking-file | http-scan         |  24 |      3.11 |   3.55 |        1.87 |           0.60 |
| ranking-file | native-js         |  24 |      1.18 |   1.34 |           — |              — |
| ranking-file | neon-federated    |  24 |      3.05 |   3.52 |        2.20 |           0.73 |
| ranking-file | neon-scan         |  24 |      3.10 |   3.34 |        2.17 |           0.74 |
| selective    | child-federated   |  24 |      5.22 |   5.79 |        2.75 |           2.30 |
| selective    | child-scan        |  24 |      5.40 |   6.35 |        2.88 |           2.33 |
| selective    | child-snapshot    |  24 |      3.39 |   4.06 |        2.93 |           0.31 |
| selective    | http-federated    |  24 |      5.99 |   6.50 |        2.86 |           2.55 |
| selective    | http-scan         |  24 |      5.85 |   6.53 |        2.81 |           2.39 |
| selective    | native-js         |  24 |      1.15 |   1.39 |           — |              — |
| selective    | neon-federated    |  24 |      5.54 |   6.36 |        3.12 |           2.35 |
| selective    | neon-scan         |  24 |      5.66 |   6.50 |        3.17 |           2.38 |

### Within-block contrasts

Positive ratio means the numerator took longer. These are descriptive paired
observations, not causal effects.

| Scenario   | Numerator / denominator             | Median per-block ratio | Median per-block difference ms |
| ---------- | ----------------------------------- | ---------------------: | -----------------------------: |
| ranking-db | neon-scan / neon-federated          |                  1.16× |                           0.54 |
| ranking-db | child-scan / child-federated        |                  1.02× |                           0.07 |
| ranking-db | http-scan / http-federated          |                  1.11× |                           0.35 |
| ranking-db | neon-federated / native-js          |                  2.76× |                           2.12 |
| ranking-db | child-federated / native-js         |                  2.74× |                           2.00 |
| ranking-db | http-federated / native-js          |                  2.94× |                           2.40 |
| ranking-db | relate-neon-scan / relate-postgres  |                  0.89× |                          -1.98 |
| ranking-db | relate-child-scan / relate-postgres |                  0.90× |                          -1.74 |
| ranking-db | relate-http-scan / relate-postgres  |                  0.93× |                          -1.28 |
| multi      | neon-scan / neon-federated          |                  0.96× |                          -0.22 |
| multi      | child-scan / child-federated        |                  0.99× |                          -0.06 |
| multi      | http-scan / http-federated          |                  0.91× |                          -0.57 |
| multi      | neon-federated / native-js          |                  3.69× |                           4.30 |
| multi      | child-federated / native-js         |                  3.45× |                           3.65 |
| multi      | http-federated / native-js          |                  3.82× |                           4.23 |

### Four-arrival bursts

| Path            | Requests | Requests/sec including client checks | Request median ms | Request p95 ms |
| --------------- | -------: | -----------------------------------: | ----------------: | -------------: |
| neon-scan       |       20 |                               572.81 |              6.17 |           8.62 |
| neon-federated  |       20 |                               668.08 |              5.82 |           6.13 |
| child-scan      |       20 |                               235.28 |             10.79 |          16.90 |
| child-federated |       20 |                               246.51 |              9.95 |          16.41 |
| http-scan       |       20 |                               434.57 |              8.19 |          10.82 |
| http-federated  |       20 |                               510.43 |              7.09 |           7.94 |

## medium: 1,000 customers / 100,000 events

| Scenario     | Path              |   n | Median ms | p95 ms | Plan median | Collect median |
| ------------ | ----------------- | --: | --------: | -----: | ----------: | -------------: |
| bulk         | child-federated   |  24 |     17.27 |  18.04 |        1.52 |          14.42 |
| bulk         | child-scan        |  24 |     21.87 |  22.52 |        1.74 |          18.53 |
| bulk         | child-snapshot    |  24 |      4.16 |   4.39 |        1.91 |           0.88 |
| bulk         | http-federated    |  24 |     17.96 |  18.77 |        1.47 |          14.55 |
| bulk         | http-scan         |  24 |     22.56 |  23.20 |        1.59 |          18.85 |
| bulk         | native-js         |  24 |     12.23 |  13.15 |           — |              — |
| bulk         | neon-federated    |  24 |     17.28 |  18.55 |        1.59 |          14.38 |
| bulk         | neon-scan         |  24 |     21.91 |  23.06 |        1.80 |          18.67 |
| control      | child-federated   |  24 |      0.20 |   0.26 |        0.13 |           0.01 |
| control      | child-scan        |  24 |      0.22 |   0.33 |        0.14 |           0.01 |
| control      | child-snapshot    |  24 |      0.22 |   0.37 |        0.14 |           0.01 |
| control      | http-federated    |  24 |      0.61 |   0.89 |        0.13 |           0.01 |
| control      | http-scan         |  24 |      0.65 |   0.91 |        0.14 |           0.01 |
| control      | native-js         |  24 |    0.0040 | 0.0085 |           — |              — |
| control      | neon-federated    |  24 |      0.21 |   0.42 |        0.16 |           0.02 |
| control      | neon-scan         |  24 |      0.24 |   0.35 |        0.19 |           0.02 |
| multi        | child-federated   |  24 |      8.09 |   8.60 |        2.78 |           5.05 |
| multi        | child-scan        |  24 |      9.48 |  10.07 |        2.91 |           6.26 |
| multi        | child-snapshot    |  24 |      4.51 |   4.84 |        2.79 |           1.44 |
| multi        | http-federated    |  24 |      8.50 |   9.27 |        2.76 |           5.07 |
| multi        | http-scan         |  24 |      9.84 |  10.33 |        2.86 |           6.15 |
| multi        | native-js         |  24 |      5.07 |   6.71 |           — |              — |
| multi        | neon-federated    |  24 |      8.41 |   8.94 |        3.07 |           5.14 |
| multi        | neon-scan         |  24 |      9.71 |  10.29 |        3.14 |           6.33 |
| ranking-db   | child-federated   |  24 |     16.18 |  16.84 |        1.68 |          14.27 |
| ranking-db   | child-scan        |  24 |     20.95 |  21.49 |        1.95 |          18.74 |
| ranking-db   | child-snapshot    |  24 |      3.19 |   3.45 |        2.16 |           0.83 |
| ranking-db   | http-federated    |  24 |     16.45 |  16.98 |        1.59 |          14.16 |
| ranking-db   | http-scan         |  24 |     21.43 |  22.13 |        1.79 |          18.97 |
| ranking-db   | native-js         |  24 |     11.55 |  12.15 |           — |              — |
| ranking-db   | neon-federated    |  24 |     16.09 |  16.93 |        1.80 |          14.13 |
| ranking-db   | neon-scan         |  24 |     21.12 |  21.46 |        2.02 |          18.91 |
| ranking-db   | relate-child-scan |  24 |    135.13 | 136.95 |           — |              — |
| ranking-db   | relate-http-scan  |  24 |    135.93 | 161.76 |           — |              — |
| ranking-db   | relate-neon-scan  |  24 |    135.92 | 138.97 |           — |              — |
| ranking-db   | relate-postgres   |  24 |    105.30 | 111.35 |           — |              — |
| ranking-file | child-federated   |  24 |      4.02 |   4.67 |        1.97 |           1.86 |
| ranking-file | child-scan        |  24 |      4.40 |   4.66 |        2.20 |           1.94 |
| ranking-file | child-snapshot    |  24 |      3.31 |   3.84 |        1.99 |           1.10 |
| ranking-file | http-federated    |  24 |      4.65 |   5.20 |        2.06 |           1.86 |
| ranking-file | http-scan         |  24 |      4.64 |   5.17 |        2.04 |           1.83 |
| ranking-file | native-js         |  24 |      4.40 |   5.18 |           — |              — |
| ranking-file | neon-federated    |  24 |      4.40 |   4.78 |        2.29 |           1.94 |
| ranking-file | neon-scan         |  24 |      4.43 |   4.84 |        2.34 |           1.95 |
| selective    | child-federated   |  24 |      5.91 |   6.71 |        2.74 |           2.92 |
| selective    | child-scan        |  24 |      6.19 |   6.88 |        3.01 |           3.05 |
| selective    | child-snapshot    |  24 |      3.81 |   4.36 |        2.96 |           0.67 |
| selective    | http-federated    |  24 |      6.52 |   7.05 |        2.87 |           3.05 |
| selective    | http-scan         |  24 |      6.47 |   7.37 |        2.84 |           2.93 |
| selective    | native-js         |  24 |      1.40 |   1.56 |           — |              — |
| selective    | neon-federated    |  24 |      6.32 |   7.36 |        3.09 |           3.08 |
| selective    | neon-scan         |  24 |      6.40 |   7.49 |        3.15 |           3.01 |

### Within-block contrasts

Positive ratio means the numerator took longer. These are descriptive paired
observations, not causal effects.

| Scenario   | Numerator / denominator             | Median per-block ratio | Median per-block difference ms |
| ---------- | ----------------------------------- | ---------------------: | -----------------------------: |
| ranking-db | neon-scan / neon-federated          |                  1.32× |                           5.16 |
| ranking-db | child-scan / child-federated        |                  1.29× |                           4.72 |
| ranking-db | http-scan / http-federated          |                  1.31× |                           5.03 |
| ranking-db | neon-federated / native-js          |                  1.40× |                           4.60 |
| ranking-db | child-federated / native-js         |                  1.39× |                           4.51 |
| ranking-db | http-federated / native-js          |                  1.43× |                           4.94 |
| ranking-db | relate-neon-scan / relate-postgres  |                  1.29× |                          31.24 |
| ranking-db | relate-child-scan / relate-postgres |                  1.29× |                          30.27 |
| ranking-db | relate-http-scan / relate-postgres  |                  1.31× |                          32.14 |
| multi      | neon-scan / neon-federated          |                  1.16× |                           1.38 |
| multi      | child-scan / child-federated        |                  1.18× |                           1.48 |
| multi      | http-scan / http-federated          |                  1.15× |                           1.30 |
| multi      | neon-federated / native-js          |                  1.64× |                           3.31 |
| multi      | child-federated / native-js         |                  1.58× |                           2.93 |
| multi      | http-federated / native-js          |                  1.66× |                           3.28 |

### Four-arrival bursts

| Path            | Requests | Requests/sec including client checks | Request median ms | Request p95 ms |
| --------------- | -------: | -----------------------------------: | ----------------: | -------------: |
| neon-scan       |       20 |                               184.56 |             19.10 |          23.79 |
| neon-federated  |       20 |                               339.17 |             11.42 |          12.18 |
| child-scan      |       20 |                               108.81 |             23.52 |          36.90 |
| child-federated |       20 |                               125.11 |             20.09 |          32.16 |
| http-scan       |       20 |                               175.89 |             20.20 |          25.89 |
| http-federated  |       20 |                               303.70 |             12.77 |          13.55 |

## large: 12,500 customers / 1,000,000 events

| Scenario     | Path              |   n | Median ms |   p95 ms | Plan median | Collect median |
| ------------ | ----------------- | --: | --------: | -------: | ----------: | -------------: |
| bulk         | child-federated   |  24 |     77.57 |    78.41 |        1.74 |          60.09 |
| bulk         | child-scan        |  24 |    193.98 |   195.63 |        1.85 |         176.72 |
| bulk         | child-snapshot    |  24 |     23.49 |    24.33 |        2.24 |           5.83 |
| bulk         | http-federated    |  24 |     79.07 |    80.95 |        1.69 |          60.58 |
| bulk         | http-scan         |  24 |    195.18 |   196.98 |        1.84 |         176.56 |
| bulk         | native-js         |  24 |     71.75 |    77.71 |           — |              — |
| bulk         | neon-federated    |  24 |     76.10 |    78.69 |        1.70 |          60.80 |
| bulk         | neon-scan         |  24 |    191.83 |   194.18 |        1.88 |         176.65 |
| control      | child-federated   |  24 |      0.19 |     0.27 |        0.12 |           0.01 |
| control      | child-scan        |  24 |      0.21 |     0.28 |        0.14 |           0.01 |
| control      | child-snapshot    |  24 |      0.22 |     0.45 |        0.14 |           0.01 |
| control      | http-federated    |  24 |      0.64 |     0.94 |        0.13 |           0.01 |
| control      | http-scan         |  24 |      0.61 |     0.91 |        0.14 |           0.01 |
| control      | native-js         |  24 |    0.0038 |   0.0055 |           — |              — |
| control      | neon-federated    |  24 |      0.23 |     0.41 |        0.18 |           0.02 |
| control      | neon-scan         |  24 |      0.22 |     0.38 |        0.17 |           0.02 |
| multi        | child-federated   |  24 |     47.15 |    48.53 |        3.18 |          43.58 |
| multi        | child-scan        |  24 |     52.31 |    54.03 |        3.22 |          48.81 |
| multi        | child-snapshot    |  24 |     13.09 |    14.19 |        3.29 |           9.47 |
| multi        | http-federated    |  24 |     47.36 |    49.65 |        3.17 |          43.26 |
| multi        | http-scan         |  24 |     53.16 |    54.69 |        3.20 |          48.97 |
| multi        | native-js         |  24 |     42.57 |    46.32 |           — |              — |
| multi        | neon-federated    |  24 |     47.00 |    48.11 |        3.24 |          43.49 |
| multi        | neon-scan         |  24 |     52.35 |    53.69 |        3.24 |          48.68 |
| ranking-db   | child-federated   |  24 |     62.62 |    64.47 |        1.87 |          60.41 |
| ranking-db   | child-scan        |  24 |    182.22 |   188.09 |        2.05 |         179.70 |
| ranking-db   | child-snapshot    |  24 |      7.96 |     8.32 |        2.56 |           5.08 |
| ranking-db   | http-federated    |  24 |     63.23 |    64.98 |        1.86 |          60.59 |
| ranking-db   | http-scan         |  24 |    182.90 |   186.41 |        2.04 |         180.03 |
| ranking-db   | native-js         |  24 |     68.04 |    71.06 |           — |              — |
| ranking-db   | neon-federated    |  24 |     62.62 |    63.77 |        1.83 |          60.54 |
| ranking-db   | neon-scan         |  24 |    182.33 |   183.83 |        2.10 |         180.02 |
| ranking-db   | relate-child-scan |  24 |   7867.50 | 12956.85 |           — |              — |
| ranking-db   | relate-http-scan  |  24 |   6219.02 | 13646.65 |           — |              — |
| ranking-db   | relate-neon-scan  |  24 |   6194.71 | 10982.96 |           — |              — |
| ranking-db   | relate-postgres   |  24 |   3835.31 |  5008.41 |           — |              — |
| ranking-file | child-federated   |  24 |     18.88 |    19.54 |        2.43 |          16.13 |
| ranking-file | child-scan        |  24 |     18.89 |    20.27 |        2.37 |          16.17 |
| ranking-file | child-snapshot    |  24 |     10.40 |    10.86 |        2.34 |           7.71 |
| ranking-file | http-federated    |  24 |     19.52 |    20.41 |        2.35 |          16.23 |
| ranking-file | http-scan         |  24 |     19.47 |    19.99 |        2.33 |          16.19 |
| ranking-file | native-js         |  24 |     30.64 |    33.18 |           — |              — |
| ranking-file | neon-federated    |  24 |     18.76 |    19.97 |        2.47 |          16.02 |
| ranking-file | neon-scan         |  24 |     19.09 |    20.04 |        2.48 |          16.32 |
| selective    | child-federated   |  24 |     16.03 |    17.09 |        3.15 |          12.65 |
| selective    | child-scan        |  24 |     16.19 |    17.49 |        3.30 |          12.79 |
| selective    | child-snapshot    |  24 |      7.59 |     8.28 |        3.59 |           3.72 |
| selective    | http-federated    |  24 |     16.61 |    17.53 |        3.15 |          12.80 |
| selective    | http-scan         |  24 |     16.78 |    18.01 |        3.21 |          12.86 |
| selective    | native-js         |  24 |      3.25 |     3.45 |           — |              — |
| selective    | neon-federated    |  24 |     16.22 |    17.13 |        3.39 |          12.80 |
| selective    | neon-scan         |  24 |     16.38 |    17.42 |        3.42 |          12.77 |

### Within-block contrasts

Positive ratio means the numerator took longer. These are descriptive paired
observations, not causal effects.

| Scenario   | Numerator / denominator             | Median per-block ratio | Median per-block difference ms |
| ---------- | ----------------------------------- | ---------------------: | -----------------------------: |
| ranking-db | neon-scan / neon-federated          |                  2.92× |                         120.00 |
| ranking-db | child-scan / child-federated        |                  2.92× |                         119.35 |
| ranking-db | http-scan / http-federated          |                  2.88× |                         119.89 |
| ranking-db | neon-federated / native-js          |                  0.92× |                          -5.46 |
| ranking-db | child-federated / native-js         |                  0.92× |                          -5.48 |
| ranking-db | http-federated / native-js          |                  0.93× |                          -4.80 |
| ranking-db | relate-neon-scan / relate-postgres  |                  1.64× |                        2403.71 |
| ranking-db | relate-child-scan / relate-postgres |                  2.02× |                        4082.14 |
| ranking-db | relate-http-scan / relate-postgres  |                  1.66× |                        2476.43 |
| multi      | neon-scan / neon-federated          |                  1.11× |                           5.35 |
| multi      | child-scan / child-federated        |                  1.11× |                           5.26 |
| multi      | http-scan / http-federated          |                  1.13× |                           6.15 |
| multi      | neon-federated / native-js          |                  1.10× |                           4.08 |
| multi      | child-federated / native-js         |                  1.09× |                           4.04 |
| multi      | http-federated / native-js          |                  1.13× |                           5.25 |

### Four-arrival bursts

| Path            | Requests | Requests/sec including client checks | Request median ms | Request p95 ms |
| --------------- | -------: | -----------------------------------: | ----------------: | -------------: |
| neon-scan       |       20 |                                14.00 |            255.72 |         296.65 |
| neon-federated  |       20 |                                19.24 |            191.73 |         229.29 |
| child-scan      |       20 |                                 7.90 |            305.24 |         523.54 |
| child-federated |       20 |                                10.53 |            250.12 |         407.94 |
| http-scan       |       20 |                                12.62 |            281.30 |         328.53 |
| http-federated  |       20 |                                26.64 |            144.66 |         155.17 |

## Archive integrity

| Archive                          | SHA-256 of decompressed JSON                                       |
| -------------------------------- | ------------------------------------------------------------------ |
| [small.json.gz](small.json.gz)   | `d9bf8a593120867a6678a003328e5c9bc101798e2d1e72e4b6c8fe3cf499498f` |
| [medium.json.gz](medium.json.gz) | `2dfade362ec9bd1260ab85ace95453d6365d567e0ba6f7bf844e9117f59285dc` |
| [large.json.gz](large.json.gz)   | `7b4153912484ec6d901801e46caf436a39f101561b45099329d27e86abd334c8` |
