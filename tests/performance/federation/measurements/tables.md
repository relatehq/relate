# Complete federation comparisons

Durations are milliseconds. Warm samples only; p95 uses nearest rank. First
observations and two warmups remain in the archives. Measured after the indexed
memory store (#49) was merged.

## small: 100 customers / 1,000 events

| Scenario     | Path                         |   n |  Median |     p95 |
| ------------ | ---------------------------- | --: | ------: | ------: |
| bulk         | child-federated              |  24 |  3.9502 |  4.9978 |
| bulk         | child-scan                   |  24 |  4.0083 |  5.0782 |
| bulk         | child-snapshot               |  24 |  2.5830 |  2.8677 |
| bulk         | http-federated               |  24 |  4.6353 |  5.7169 |
| bulk         | http-scan                    |  24 |  4.2644 |  5.6779 |
| bulk         | native-js                    |  24 |  1.6721 |  2.1758 |
| bulk         | neon-federated               |  24 |  4.0836 |  5.2128 |
| bulk         | neon-scan                    |  24 |  4.1275 |  5.3347 |
| control      | child-federated              |  24 |  0.2221 |  0.3922 |
| control      | child-scan                   |  24 |  0.2508 |  0.4345 |
| control      | child-snapshot               |  24 |  0.2606 |  0.5045 |
| control      | http-federated               |  24 |  0.7107 |  0.8400 |
| control      | http-scan                    |  24 |  0.7501 |  1.0740 |
| control      | native-js                    |  24 |  0.0053 |  0.0127 |
| control      | neon-federated               |  24 |  0.2572 |  0.4103 |
| control      | neon-scan                    |  24 |  0.3103 |  0.4205 |
| multi        | child-federated              |  24 |  5.9034 |  6.4219 |
| multi        | child-scan                   |  24 |  5.8948 |  6.3242 |
| multi        | child-snapshot               |  24 |  3.5365 |  3.9930 |
| multi        | http-federated               |  24 |  6.4142 |  6.9359 |
| multi        | http-scan                    |  24 |  6.4041 |  7.2142 |
| multi        | native-js                    |  24 |  1.6451 |  1.8830 |
| multi        | neon-federated               |  24 |  6.1203 |  6.9546 |
| multi        | neon-scan                    |  24 |  6.1899 |  6.5114 |
| multi        | relate-child-scan            |  24 | 21.9157 | 23.3222 |
| multi        | relate-child-scope-federated |  24 | 13.4790 | 14.5352 |
| multi        | relate-child-scope-scan      |  24 | 13.1944 | 14.8538 |
| multi        | relate-http-scan             |  24 | 21.7633 | 22.9900 |
| multi        | relate-http-scope-federated  |  24 | 13.4553 | 15.1490 |
| multi        | relate-http-scope-scan       |  24 | 13.8224 | 16.0586 |
| multi        | relate-native                |  24 | 19.6656 | 22.2931 |
| multi        | relate-neon-scan             |  24 | 14.7772 | 15.8835 |
| multi        | relate-neon-scope-federated  |  24 | 13.3568 | 14.6124 |
| multi        | relate-neon-scope-scan       |  24 | 13.1159 | 14.4814 |
| ranking-db   | child-federated              |  24 |  3.5178 |  4.8640 |
| ranking-db   | child-scan                   |  24 |  4.1378 |  5.2412 |
| ranking-db   | child-snapshot               |  24 |  2.6365 |  3.1020 |
| ranking-db   | http-federated               |  24 |  4.7528 |  5.4438 |
| ranking-db   | http-scan                    |  24 |  4.5474 |  5.5360 |
| ranking-db   | native-js                    |  24 |  1.1659 |  1.9837 |
| ranking-db   | neon-federated               |  24 |  3.6333 |  5.2178 |
| ranking-db   | neon-scan                    |  24 |  4.3388 |  5.1060 |
| ranking-db   | relate-child-scan            |  24 | 15.7911 | 16.9603 |
| ranking-db   | relate-child-scope-federated |  24 | 10.2661 | 11.4288 |
| ranking-db   | relate-child-scope-scan      |  24 | 10.5873 | 12.6065 |
| ranking-db   | relate-http-scan             |  24 | 16.4387 | 17.4428 |
| ranking-db   | relate-http-scope-federated  |  24 | 10.6294 | 12.0347 |
| ranking-db   | relate-http-scope-scan       |  24 | 10.7787 | 12.2267 |
| ranking-db   | relate-neon-scan             |  24 | 15.4416 | 17.4773 |
| ranking-db   | relate-neon-scope-federated  |  24 | 10.4983 | 11.2840 |
| ranking-db   | relate-neon-scope-scan       |  24 | 10.1468 | 10.9417 |
| ranking-db   | relate-postgres              |  24 | 19.5053 | 22.7485 |
| ranking-file | child-federated              |  24 |  3.1500 |  3.4580 |
| ranking-file | child-scan                   |  24 |  3.1793 |  3.7153 |
| ranking-file | child-snapshot               |  24 |  2.6731 |  3.1590 |
| ranking-file | http-federated               |  24 |  3.7280 |  4.1261 |
| ranking-file | http-scan                    |  24 |  3.6899 |  4.1582 |
| ranking-file | native-js                    |  24 |  1.2935 |  1.4042 |
| ranking-file | neon-federated               |  24 |  3.5258 |  3.8768 |
| ranking-file | neon-scan                    |  24 |  3.4311 |  3.7437 |
| selective    | child-federated              |  24 |  5.2789 |  6.2317 |
| selective    | child-scan                   |  24 |  5.6077 |  6.6606 |
| selective    | child-snapshot               |  24 |  3.8819 |  4.2310 |
| selective    | http-federated               |  24 |  6.3244 |  6.9902 |
| selective    | http-scan                    |  24 |  5.8480 |  6.5341 |
| selective    | native-js                    |  24 |  1.1849 |  1.5910 |
| selective    | neon-federated               |  24 |  5.6189 |  6.9310 |
| selective    | neon-scan                    |  24 |  5.7633 |  6.7883 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.541 |                -8.79 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.665 |                -5.24 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        1.005 |                 0.05 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.535 |                -9.07 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.648 |                -5.55 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.960 |                -0.44 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.562 |                -8.71 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.652 |                -5.72 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.981 |                -0.19 |
| multi      | relate-neon-scope-federated / relate-native            |        0.707 |                -5.87 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.892 |                -1.63 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        1.003 |                 0.04 |
| multi      | relate-child-scope-federated / relate-native           |        0.705 |                -5.84 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.601 |                -8.78 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        1.008 |                 0.10 |
| multi      | relate-http-scope-federated / relate-native            |        0.731 |                -5.28 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.612 |                -8.34 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        0.988 |                -0.16 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |               0.55 |           7.23 |         0.17 |          5.67 |            3.21 |           3.46 |
| multi      | relate-child-scope-scan      |               0.55 |           6.77 |         0.16 |          5.50 |            3.23 |           3.00 |
| multi      | relate-http-scope-federated  |               0.54 |           6.98 |         0.17 |          5.60 |            3.25 |           2.73 |
| multi      | relate-http-scope-scan       |               0.55 |           7.51 |         0.18 |          5.57 |            3.30 |           3.25 |
| multi      | relate-neon-scope-federated  |               0.56 |           7.17 |         0.17 |          5.65 |            3.24 |           3.47 |
| multi      | relate-neon-scope-scan       |               0.55 |           7.00 |         0.17 |          5.48 |            3.35 |           3.37 |
| ranking-db | relate-child-scope-federated |               0.36 |           4.74 |         0.25 |          4.84 |            1.64 |           2.77 |
| ranking-db | relate-child-scope-scan      |               0.37 |           5.14 |         0.25 |          4.82 |            1.93 |           2.75 |
| ranking-db | relate-http-scope-federated  |               0.37 |           5.29 |         0.25 |          4.92 |            1.74 |           2.81 |
| ranking-db | relate-http-scope-scan       |               0.37 |           5.33 |         0.25 |          4.93 |            1.87 |           2.51 |
| ranking-db | relate-neon-scope-federated  |               0.36 |           4.90 |         0.25 |          4.90 |            1.78 |           2.80 |
| ranking-db | relate-neon-scope-scan       |               0.37 |           4.69 |         0.25 |          4.85 |            1.96 |           2.65 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.29 |                   60.97 |
| bulk         | child-scan                   |                   0.29 |                   60.97 |
| bulk         | child-snapshot               |                   0.30 |                   60.97 |
| bulk         | http-federated               |                   0.38 |                   59.61 |
| bulk         | http-scan                    |                   0.40 |                   59.61 |
| bulk         | native-js                    |                   0.00 |                  413.42 |
| bulk         | neon-federated               |                   0.29 |                  414.54 |
| bulk         | neon-scan                    |                   0.29 |                  411.63 |
| control      | child-federated              |                      — |                   37.47 |
| control      | child-scan                   |                      — |                   37.47 |
| control      | child-snapshot               |                      — |                   37.47 |
| control      | http-federated               |                      — |                   33.08 |
| control      | http-scan                    |                      — |                   33.08 |
| control      | native-js                    |                      — |                  321.81 |
| control      | neon-federated               |                      — |                  321.80 |
| control      | neon-scan                    |                      — |                  321.80 |
| multi        | child-federated              |                   0.30 |                   59.75 |
| multi        | child-scan                   |                   0.30 |                   59.75 |
| multi        | child-snapshot               |                   0.30 |                   59.80 |
| multi        | http-federated               |                   0.50 |                   58.67 |
| multi        | http-scan                    |                   0.46 |                   58.67 |
| multi        | native-js                    |                   0.00 |                  402.98 |
| multi        | neon-federated               |                   0.29 |                  406.05 |
| multi        | neon-scan                    |                   0.29 |                  402.82 |
| multi        | relate-child-scan            |                   1.01 |                  515.27 |
| multi        | relate-child-scope-federated |                   0.81 |                  515.47 |
| multi        | relate-child-scope-scan      |                   0.73 |                  515.30 |
| multi        | relate-http-scan             |                   1.33 |                  516.05 |
| multi        | relate-http-scope-federated  |                   1.06 |                  515.34 |
| multi        | relate-http-scope-scan       |                   1.03 |                  516.04 |
| multi        | relate-native                |                   1.15 |                  515.55 |
| multi        | relate-neon-scan             |                   0.98 |                  515.97 |
| multi        | relate-neon-scope-federated  |                   0.78 |                  515.79 |
| multi        | relate-neon-scope-scan       |                   0.72 |                  515.48 |
| ranking-db   | child-federated              |                   0.29 |                   52.20 |
| ranking-db   | child-scan                   |                   0.29 |                   52.20 |
| ranking-db   | child-snapshot               |                   0.30 |                   52.20 |
| ranking-db   | http-federated               |                   0.30 |                   49.50 |
| ranking-db   | http-scan                    |                   0.29 |                   49.50 |
| ranking-db   | native-js                    |                      — |                  352.63 |
| ranking-db   | neon-federated               |                   0.29 |                  352.39 |
| ranking-db   | neon-scan                    |                   0.29 |                  352.52 |
| ranking-db   | relate-child-scan            |                   0.63 |                  506.57 |
| ranking-db   | relate-child-scope-federated |                   0.44 |                  508.27 |
| ranking-db   | relate-child-scope-scan      |                   0.44 |                  508.27 |
| ranking-db   | relate-http-scan             |                   0.94 |                  506.57 |
| ranking-db   | relate-http-scope-federated  |                   0.69 |                  508.27 |
| ranking-db   | relate-http-scope-scan       |                   0.94 |                  508.27 |
| ranking-db   | relate-neon-scan             |                   0.61 |                  508.02 |
| ranking-db   | relate-neon-scope-federated  |                   0.68 |                  508.27 |
| ranking-db   | relate-neon-scope-scan       |                   0.52 |                  506.56 |
| ranking-db   | relate-postgres              |                   0.86 |                  508.27 |
| ranking-file | child-federated              |                   0.30 |                   57.18 |
| ranking-file | child-scan                   |                   0.29 |                   57.18 |
| ranking-file | child-snapshot               |                   0.30 |                   57.18 |
| ranking-file | http-federated               |                   0.48 |                   56.09 |
| ranking-file | http-scan                    |                   0.52 |                   56.08 |
| ranking-file | native-js                    |                      — |                  394.45 |
| ranking-file | neon-federated               |                   0.29 |                  395.55 |
| ranking-file | neon-scan                    |                   0.29 |                  395.56 |
| selective    | child-federated              |                   0.30 |                   60.64 |
| selective    | child-scan                   |                   0.30 |                   60.64 |
| selective    | child-snapshot               |                   0.30 |                   60.64 |
| selective    | http-federated               |                   0.52 |                   59.31 |
| selective    | http-scan                    |                   0.46 |                   59.31 |
| selective    | native-js                    |                   0.00 |                  408.33 |
| selective    | neon-federated               |                   0.30 |                  408.32 |
| selective    | neon-scan                    |                   0.29 |                  409.20 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |    25.62 |
| child                             | engine            |    23.83 |
| http                              | engine            |    22.02 |
| relate-postgres                   | ranking-db        |    49.49 |
| relate-neon-scan                  | ranking-db        |    14.45 |
| relate-child-scan                 | ranking-db        |    13.84 |
| relate-http-scan                  | ranking-db        |    13.66 |
| relate-neon-scope-scan            | ranking-db        |    14.33 |
| relate-neon-scope-federated       | ranking-db        |    12.98 |
| relate-child-scope-scan           | ranking-db        |    11.85 |
| relate-child-scope-federated      | ranking-db        |    12.31 |
| relate-http-scope-scan            | ranking-db        |    13.32 |
| relate-http-scope-federated       | ranking-db        |    12.22 |
| relate-native                     | multi             |    19.03 |
| relate-neon-scan                  | multi             |    13.31 |
| relate-child-scan                 | multi             |    12.66 |
| relate-http-scan                  | multi             |    12.31 |
| relate-neon-scope-scan            | multi             |    11.78 |
| relate-neon-scope-federated       | multi             |    11.78 |
| relate-child-scope-scan           | multi             |    12.74 |
| relate-child-scope-federated      | multi             |    11.39 |
| relate-http-scope-scan            | multi             |    12.79 |
| relate-http-scope-federated       | multi             |    13.31 |
| Explicit four-table snapshot load | raw snapshot path |     4.21 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |       529.31 |           6.62 |       10.03 |
| neon-federated  |       659.96 |           5.93 |        6.26 |
| child-scan      |       221.97 |          11.48 |       18.13 |
| child-federated |       218.31 |          11.43 |       18.90 |
| http-scan       |       433.50 |           8.16 |       10.71 |
| http-federated  |       454.87 |           8.18 |        9.31 |

## medium: 1,000 customers / 100,000 events

| Scenario     | Path                         |   n |   Median |      p95 |
| ------------ | ---------------------------- | --: | -------: | -------: |
| bulk         | child-federated              |  24 |  18.0855 |  18.5907 |
| bulk         | child-scan                   |  24 |  22.7375 |  24.3957 |
| bulk         | child-snapshot               |  24 |   4.4517 |   4.7416 |
| bulk         | http-federated               |  24 |  18.5625 |  19.1453 |
| bulk         | http-scan                    |  24 |  23.4160 |  24.0727 |
| bulk         | native-js                    |  24 |  12.1792 |  13.1985 |
| bulk         | neon-federated               |  24 |  17.9954 |  18.5901 |
| bulk         | neon-scan                    |  24 |  22.6206 |  23.2699 |
| control      | child-federated              |  24 |   0.2404 |   0.3623 |
| control      | child-scan                   |  24 |   0.2652 |   0.4379 |
| control      | child-snapshot               |  24 |   0.2584 |   0.4160 |
| control      | http-federated               |  24 |   0.7291 |   0.9195 |
| control      | http-scan                    |  24 |   0.6875 |   1.0733 |
| control      | native-js                    |  24 |   0.0046 |   0.0082 |
| control      | neon-federated               |  24 |   0.2638 |   0.4165 |
| control      | neon-scan                    |  24 |   0.2893 |   0.4082 |
| multi        | child-federated              |  24 |   8.5741 |   9.1941 |
| multi        | child-scan                   |  24 |   9.9192 |  10.4417 |
| multi        | child-snapshot               |  24 |   4.7298 |   5.0484 |
| multi        | http-federated               |  24 |   9.3503 |   9.8120 |
| multi        | http-scan                    |  24 |  10.3924 |  10.9261 |
| multi        | native-js                    |  24 |   5.2672 |   6.4277 |
| multi        | neon-federated               |  24 |   8.8988 |   9.7903 |
| multi        | neon-scan                    |  24 |  10.0543 |  10.3360 |
| multi        | relate-child-scan            |  24 | 139.6108 | 141.6791 |
| multi        | relate-child-scope-federated |  24 |  59.1258 |  62.5829 |
| multi        | relate-child-scope-scan      |  24 |  59.7310 |  75.5609 |
| multi        | relate-http-scan             |  24 | 138.2932 | 140.2123 |
| multi        | relate-http-scope-federated  |  24 |  59.1384 |  65.1758 |
| multi        | relate-http-scope-scan       |  24 |  59.5317 |  63.9097 |
| multi        | relate-native                |  24 |  69.1477 |  73.7871 |
| multi        | relate-neon-scan             |  24 |  94.6645 |  97.1643 |
| multi        | relate-neon-scope-federated  |  24 |  58.8730 |  64.3242 |
| multi        | relate-neon-scope-scan       |  24 |  60.4226 |  64.8282 |
| ranking-db   | child-federated              |  24 |  16.6140 |  17.1093 |
| ranking-db   | child-scan                   |  24 |  21.4936 |  21.9257 |
| ranking-db   | child-snapshot               |  24 |   3.4156 |   3.6748 |
| ranking-db   | http-federated               |  24 |  16.8526 |  17.3287 |
| ranking-db   | http-scan                    |  24 |  21.9935 |  22.4847 |
| ranking-db   | native-js                    |  24 |  12.0768 |  12.8180 |
| ranking-db   | neon-federated               |  24 |  16.7288 |  17.1210 |
| ranking-db   | neon-scan                    |  24 |  21.4223 |  21.8259 |
| ranking-db   | relate-child-scan            |  24 | 114.5819 | 119.9563 |
| ranking-db   | relate-child-scope-federated |  24 |  58.8301 |  60.7816 |
| ranking-db   | relate-child-scope-scan      |  24 |  63.1200 |  65.0330 |
| ranking-db   | relate-http-scan             |  24 | 115.8088 | 120.6804 |
| ranking-db   | relate-http-scope-federated  |  24 |  59.3234 |  60.5517 |
| ranking-db   | relate-http-scope-scan       |  24 |  63.2274 |  64.7951 |
| ranking-db   | relate-neon-scan             |  24 | 115.1649 | 117.6923 |
| ranking-db   | relate-neon-scope-federated  |  24 |  57.8118 |  60.2498 |
| ranking-db   | relate-neon-scope-scan       |  24 |  62.9628 |  65.8125 |
| ranking-db   | relate-postgres              |  24 |  84.0653 | 103.1965 |
| ranking-file | child-federated              |  24 |   4.3237 |   4.7520 |
| ranking-file | child-scan                   |  24 |   4.5371 |   4.9222 |
| ranking-file | child-snapshot               |  24 |   3.5610 |   4.1571 |
| ranking-file | http-federated               |  24 |   4.9550 |   5.6458 |
| ranking-file | http-scan                    |  24 |   4.9440 |   5.1967 |
| ranking-file | native-js                    |  24 |   4.5340 |   4.8455 |
| ranking-file | neon-federated               |  24 |   4.4938 |   5.1720 |
| ranking-file | neon-scan                    |  24 |   4.5984 |   4.9725 |
| selective    | child-federated              |  24 |   6.6611 |   7.2444 |
| selective    | child-scan                   |  24 |   6.5669 |   7.6217 |
| selective    | child-snapshot               |  24 |   4.3469 |   4.5841 |
| selective    | http-federated               |  24 |   7.4255 |   8.1786 |
| selective    | http-scan                    |  24 |   7.0854 |   8.1163 |
| selective    | native-js                    |  24 |   1.4980 |   1.7733 |
| selective    | neon-federated               |  24 |   6.8958 |   7.4646 |
| selective    | neon-scan                    |  24 |   6.7114 |   7.5445 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.691 |               -25.48 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.501 |               -58.03 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        0.919 |                -5.07 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.699 |               -24.88 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.514 |               -55.88 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.937 |                -3.95 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.705 |               -24.74 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.511 |               -56.17 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.936 |                -4.11 |
| multi      | relate-neon-scope-federated / relate-native            |        0.829 |               -12.07 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.617 |               -36.80 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        0.976 |                -1.39 |
| multi      | relate-child-scope-federated / relate-native           |        0.850 |               -10.65 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.426 |               -79.25 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        0.990 |                -0.56 |
| multi      | relate-http-scope-federated / relate-native            |        0.838 |               -10.92 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.432 |               -77.91 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        0.985 |                -0.94 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |               4.57 |          14.27 |         1.29 |         38.83 |            3.31 |           8.53 |
| multi      | relate-child-scope-scan      |               4.67 |          16.37 |         1.28 |         37.82 |            3.31 |           9.71 |
| multi      | relate-http-scope-federated  |               4.87 |          13.66 |         1.27 |         38.10 |            3.33 |           7.40 |
| multi      | relate-http-scope-scan       |               4.56 |          14.23 |         1.33 |         38.07 |            3.38 |           7.92 |
| multi      | relate-neon-scope-federated  |               4.56 |          15.02 |         1.19 |         38.25 |            3.42 |           9.50 |
| multi      | relate-neon-scope-scan       |               4.50 |          16.81 |         1.21 |         38.21 |            3.48 |          11.21 |
| ranking-db | relate-child-scope-federated |               3.13 |          18.16 |         2.37 |         35.00 |            1.87 |          14.28 |
| ranking-db | relate-child-scope-scan      |               3.13 |          22.53 |         2.37 |         35.05 |            2.00 |          18.70 |
| ranking-db | relate-http-scope-federated  |               3.31 |          18.33 |         2.32 |         34.94 |            1.82 |          14.22 |
| ranking-db | relate-http-scope-scan       |               3.09 |          22.91 |         2.36 |         34.91 |            2.04 |          18.63 |
| ranking-db | relate-neon-scope-federated  |               3.27 |          17.50 |         2.25 |         34.60 |            1.88 |          14.23 |
| ranking-db | relate-neon-scope-scan       |               3.36 |          22.11 |         2.39 |         35.01 |            2.05 |          18.70 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.30 |                   81.52 |
| bulk         | child-scan                   |                   0.31 |                   81.52 |
| bulk         | child-snapshot               |                   0.31 |                   81.52 |
| bulk         | http-federated               |                   0.49 |                   69.88 |
| bulk         | http-scan                    |                   0.53 |                   69.88 |
| bulk         | native-js                    |                   0.69 |                  475.08 |
| bulk         | neon-federated               |                   0.31 |                  476.79 |
| bulk         | neon-scan                    |                   0.31 |                  478.83 |
| control      | child-federated              |                      — |                   47.69 |
| control      | child-scan                   |                      — |                   47.69 |
| control      | child-snapshot               |                      — |                   47.69 |
| control      | http-federated               |                      — |                   33.51 |
| control      | http-scan                    |                      — |                   33.51 |
| control      | native-js                    |                      — |                  404.58 |
| control      | neon-federated               |                      — |                  404.58 |
| control      | neon-scan                    |                      — |                  404.58 |
| multi        | child-federated              |                   0.31 |                   78.84 |
| multi        | child-scan                   |                   0.31 |                   78.86 |
| multi        | child-snapshot               |                   0.31 |                   78.87 |
| multi        | http-federated               |                   0.48 |                   67.27 |
| multi        | http-scan                    |                   0.52 |                   67.26 |
| multi        | native-js                    |                   0.00 |                  477.41 |
| multi        | neon-federated               |                   0.30 |                  475.70 |
| multi        | neon-scan                    |                   0.29 |                  477.69 |
| multi        | relate-child-scan            |                  18.68 |                  588.89 |
| multi        | relate-child-scope-federated |                  18.03 |                  583.66 |
| multi        | relate-child-scope-scan      |                  17.76 |                  588.89 |
| multi        | relate-http-scan             |                  19.15 |                  585.13 |
| multi        | relate-http-scope-federated  |                  18.66 |                  581.36 |
| multi        | relate-http-scope-scan       |                  18.09 |                  581.36 |
| multi        | relate-native                |                  19.07 |                  583.01 |
| multi        | relate-neon-scan             |                  18.88 |                  588.03 |
| multi        | relate-neon-scope-federated  |                  17.90 |                  585.13 |
| multi        | relate-neon-scope-scan       |                  17.97 |                  585.13 |
| ranking-db   | child-federated              |                   0.31 |                   68.48 |
| ranking-db   | child-scan                   |                   0.32 |                   68.48 |
| ranking-db   | child-snapshot               |                   0.31 |                   68.48 |
| ranking-db   | http-federated               |                   0.54 |                   56.14 |
| ranking-db   | http-scan                    |                   0.29 |                   56.14 |
| ranking-db   | native-js                    |                   0.67 |                  435.84 |
| ranking-db   | neon-federated               |                   0.30 |                  434.58 |
| ranking-db   | neon-scan                    |                   0.30 |                  435.61 |
| ranking-db   | relate-child-scan            |                  16.59 |                  593.04 |
| ranking-db   | relate-child-scope-federated |                  16.57 |                  591.77 |
| ranking-db   | relate-child-scope-scan      |                  16.35 |                  593.04 |
| ranking-db   | relate-http-scan             |                  17.10 |                  593.04 |
| ranking-db   | relate-http-scope-federated  |                  16.68 |                  592.53 |
| ranking-db   | relate-http-scope-scan       |                  16.23 |                  592.63 |
| ranking-db   | relate-neon-scan             |                  16.67 |                  595.24 |
| ranking-db   | relate-neon-scope-federated  |                  16.28 |                  595.27 |
| ranking-db   | relate-neon-scope-scan       |                  16.08 |                  595.27 |
| ranking-db   | relate-postgres              |                  16.52 |                  592.53 |
| ranking-file | child-federated              |                   0.29 |                   77.19 |
| ranking-file | child-scan                   |                   0.30 |                   77.19 |
| ranking-file | child-snapshot               |                   0.30 |                   77.19 |
| ranking-file | http-federated               |                   0.50 |                   66.14 |
| ranking-file | http-scan                    |                   0.50 |                   66.14 |
| ranking-file | native-js                    |                   0.62 |                  474.74 |
| ranking-file | neon-federated               |                   0.29 |                  477.72 |
| ranking-file | neon-scan                    |                   0.29 |                  475.68 |
| selective    | child-federated              |                   0.30 |                   79.84 |
| selective    | child-scan                   |                   0.30 |                   79.84 |
| selective    | child-snapshot               |                   0.30 |                   79.84 |
| selective    | http-federated               |                   0.54 |                   68.36 |
| selective    | http-scan                    |                   0.55 |                   68.36 |
| selective    | native-js                    |                   0.00 |                  480.33 |
| selective    | neon-federated               |                   0.29 |                  481.54 |
| selective    | neon-scan                    |                   0.29 |                  479.41 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |   215.79 |
| child                             | engine            |   279.29 |
| http                              | engine            |   130.92 |
| relate-postgres                   | ranking-db        |    91.24 |
| relate-neon-scan                  | ranking-db        |    43.56 |
| relate-child-scan                 | ranking-db        |    40.89 |
| relate-http-scan                  | ranking-db        |    39.92 |
| relate-neon-scope-scan            | ranking-db        |    41.23 |
| relate-neon-scope-federated       | ranking-db        |    39.12 |
| relate-child-scope-scan           | ranking-db        |    38.97 |
| relate-child-scope-federated      | ranking-db        |    39.37 |
| relate-http-scope-scan            | ranking-db        |    39.98 |
| relate-http-scope-federated       | ranking-db        |    39.01 |
| relate-native                     | multi             |    55.17 |
| relate-neon-scan                  | multi             |    45.13 |
| relate-child-scan                 | multi             |    41.95 |
| relate-http-scan                  | multi             |    43.47 |
| relate-neon-scope-scan            | multi             |    42.54 |
| relate-neon-scope-federated       | multi             |    44.01 |
| relate-child-scope-scan           | multi             |    47.73 |
| relate-child-scope-federated      | multi             |    44.21 |
| relate-http-scope-scan            | multi             |    42.48 |
| relate-http-scope-federated       | multi             |    43.64 |
| Explicit four-table snapshot load | raw snapshot path |    34.71 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |       180.27 |          19.33 |       26.90 |
| neon-federated  |       335.22 |          11.51 |       12.11 |
| child-scan      |       105.69 |          23.80 |       38.29 |
| child-federated |       121.32 |          20.57 |       33.75 |
| http-scan       |       177.53 |          19.95 |       23.70 |
| http-federated  |       298.68 |          12.64 |       13.84 |

## large: 12,500 customers / 1,000,000 events

| Scenario     | Path                         |   n |    Median |       p95 |
| ------------ | ---------------------------- | --: | --------: | --------: |
| bulk         | child-federated              |  24 |   78.1380 |   79.7578 |
| bulk         | child-scan                   |  24 |  195.2490 |  196.8013 |
| bulk         | child-snapshot               |  24 |   23.8935 |   24.2337 |
| bulk         | http-federated               |  24 |   79.5811 |   80.6385 |
| bulk         | http-scan                    |  24 |  195.6172 |  198.0850 |
| bulk         | native-js                    |  24 |   73.2907 |   76.0599 |
| bulk         | neon-federated               |  24 |   76.2016 |   77.2372 |
| bulk         | neon-scan                    |  24 |  193.2855 |  194.9419 |
| control      | child-federated              |  24 |    0.2291 |    0.3402 |
| control      | child-scan                   |  24 |    0.2876 |    0.3986 |
| control      | child-snapshot               |  24 |    0.2602 |    0.4278 |
| control      | http-federated               |  24 |    0.7151 |    0.9742 |
| control      | http-scan                    |  24 |    0.7071 |    1.0378 |
| control      | native-js                    |  24 |    0.0050 |    0.0064 |
| control      | neon-federated               |  24 |    0.2659 |    0.4265 |
| control      | neon-scan                    |  24 |    0.3522 |    0.4232 |
| multi        | child-federated              |  24 |   46.6586 |   47.9342 |
| multi        | child-scan                   |  24 |   52.9040 |   55.4157 |
| multi        | child-snapshot               |  24 |   13.2448 |   13.5936 |
| multi        | http-federated               |  24 |   47.5041 |   48.6404 |
| multi        | http-scan                    |  24 |   53.4842 |   54.5758 |
| multi        | native-js                    |  24 |   42.0020 |   46.9438 |
| multi        | neon-federated               |  24 |   46.8446 |   47.6980 |
| multi        | neon-scan                    |  24 |   52.8861 |   54.4775 |
| multi        | relate-child-scan            |  24 | 2293.1813 | 2429.8734 |
| multi        | relate-child-scope-federated |  24 |  606.8668 |  676.8183 |
| multi        | relate-child-scope-scan      |  24 |  624.7758 |  745.6195 |
| multi        | relate-http-scan             |  24 | 1319.2832 | 1514.2334 |
| multi        | relate-http-scope-federated  |  24 |  615.4145 |  690.8867 |
| multi        | relate-http-scope-scan       |  24 |  601.8588 |  751.4814 |
| multi        | relate-native                |  24 |  808.4424 |  861.6243 |
| multi        | relate-neon-scan             |  24 | 1396.4563 | 1488.0697 |
| multi        | relate-neon-scope-federated  |  24 |  611.2542 |  725.1664 |
| multi        | relate-neon-scope-scan       |  24 |  616.2417 |  746.6985 |
| ranking-db   | child-federated              |  24 |   62.8661 |   64.3277 |
| ranking-db   | child-scan                   |  24 |  179.3003 |  182.2903 |
| ranking-db   | child-snapshot               |  24 |    8.0109 |    9.1390 |
| ranking-db   | http-federated               |  24 |   63.3535 |   64.9745 |
| ranking-db   | http-scan                    |  24 |  180.3172 |  185.2335 |
| ranking-db   | native-js                    |  24 |   68.4294 |   70.6339 |
| ranking-db   | neon-federated               |  24 |   62.8003 |   63.9277 |
| ranking-db   | neon-scan                    |  24 |  179.8849 |  183.1169 |
| ranking-db   | relate-child-scan            |  24 | 4651.3364 | 5429.9295 |
| ranking-db   | relate-child-scope-federated |  24 |  573.5059 |  618.3924 |
| ranking-db   | relate-child-scope-scan      |  24 |  702.3116 |  797.3990 |
| ranking-db   | relate-http-scan             |  24 | 3448.8883 | 3873.5944 |
| ranking-db   | relate-http-scope-federated  |  24 |  580.6255 |  634.3544 |
| ranking-db   | relate-http-scope-scan       |  24 |  684.7126 |  734.4144 |
| ranking-db   | relate-neon-scan             |  24 | 3524.4377 | 3784.2169 |
| ranking-db   | relate-neon-scope-federated  |  24 |  577.7492 |  653.1910 |
| ranking-db   | relate-neon-scope-scan       |  24 |  731.2530 |  871.9725 |
| ranking-db   | relate-postgres              |  24 |  689.7823 |  814.7786 |
| ranking-file | child-federated              |  24 |   19.7475 |   20.8195 |
| ranking-file | child-scan                   |  24 |   19.7471 |   21.8692 |
| ranking-file | child-snapshot               |  24 |   10.6936 |   10.9817 |
| ranking-file | http-federated               |  24 |   20.6524 |   21.3038 |
| ranking-file | http-scan                    |  24 |   20.3815 |   21.6454 |
| ranking-file | native-js                    |  24 |   31.0999 |   35.1560 |
| ranking-file | neon-federated               |  24 |   19.8410 |   20.2291 |
| ranking-file | neon-scan                    |  24 |   19.7901 |   20.4512 |
| selective    | child-federated              |  24 |   16.5814 |   17.7444 |
| selective    | child-scan                   |  24 |   16.7647 |   17.7760 |
| selective    | child-snapshot               |  24 |    7.6844 |    7.9391 |
| selective    | http-federated               |  24 |   17.3257 |   18.5323 |
| selective    | http-scan                    |  24 |   17.3309 |   18.3907 |
| selective    | native-js                    |  24 |    3.3248 |    3.6210 |
| selective    | neon-federated               |  24 |   16.9543 |   17.9896 |
| selective    | neon-scan                    |  24 |   16.8086 |   18.4620 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.864 |               -91.67 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.167 |             -2950.53 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        0.807 |              -148.07 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.848 |              -102.31 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.127 |             -4042.77 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.821 |              -128.63 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.841 |              -109.62 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.170 |             -2863.25 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.849 |              -102.91 |
| multi      | relate-neon-scope-federated / relate-native            |        0.762 |              -195.27 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.434 |              -776.88 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        1.026 |                15.58 |
| multi      | relate-child-scope-federated / relate-native           |        0.747 |              -200.52 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.263 |             -1700.55 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        0.965 |               -22.09 |
| multi      | relate-http-scope-federated / relate-native            |        0.765 |              -191.88 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.465 |              -695.64 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        1.004 |                 2.24 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |              60.51 |          77.44 |        12.48 |        449.52 |            4.07 |          47.43 |
| multi      | relate-child-scope-scan      |              61.35 |          97.54 |        12.96 |        453.38 |            4.17 |          67.31 |
| multi      | relate-http-scope-federated  |              60.62 |          76.20 |        13.68 |        460.25 |            4.10 |          46.65 |
| multi      | relate-http-scope-scan       |              59.73 |          80.61 |        12.24 |        447.24 |            4.22 |          51.46 |
| multi      | relate-neon-scope-federated  |              63.54 |          72.89 |        14.15 |        456.24 |            4.19 |          47.65 |
| multi      | relate-neon-scope-scan       |              62.00 |          75.99 |        13.44 |        454.58 |            4.18 |          51.35 |
| ranking-db | relate-child-scope-federated |              40.30 |          88.03 |        28.16 |        417.36 |            2.25 |          67.77 |
| ranking-db | relate-child-scope-scan      |              41.95 |         201.24 |        27.66 |        421.88 |            2.43 |         180.48 |
| ranking-db | relate-http-scope-federated  |              40.23 |          90.48 |        28.30 |        421.59 |            2.24 |          69.07 |
| ranking-db | relate-http-scope-scan       |              40.12 |         199.27 |        27.61 |        417.47 |            2.42 |         178.39 |
| ranking-db | relate-neon-scope-federated  |              41.04 |          86.51 |        28.79 |        420.14 |            2.30 |          69.05 |
| ranking-db | relate-neon-scope-scan       |              45.87 |         196.48 |        28.47 |        461.25 |            2.48 |         179.02 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.31 |                  196.95 |
| bulk         | child-scan                   |                   0.32 |                  196.95 |
| bulk         | child-snapshot               |                   0.32 |                  196.95 |
| bulk         | http-federated               |                   0.61 |                  102.97 |
| bulk         | http-scan                    |                   0.46 |                  102.97 |
| bulk         | native-js                    |                   1.73 |                  648.45 |
| bulk         | neon-federated               |                   0.31 |                  648.64 |
| bulk         | neon-scan                    |                   0.31 |                  647.12 |
| control      | child-federated              |                      — |                  127.75 |
| control      | child-scan                   |                      — |                  127.75 |
| control      | child-snapshot               |                      — |                  127.75 |
| control      | http-federated               |                      — |                   33.69 |
| control      | http-scan                    |                      — |                   33.69 |
| control      | native-js                    |                      — |                  876.59 |
| control      | neon-federated               |                      — |                  876.59 |
| control      | neon-scan                    |                      — |                  876.59 |
| multi        | child-federated              |                   0.32 |                  177.27 |
| multi        | child-scan                   |                   0.33 |                  177.27 |
| multi        | child-snapshot               |                   0.32 |                  177.28 |
| multi        | http-federated               |                   0.53 |                   85.64 |
| multi        | http-scan                    |                   0.51 |                   85.65 |
| multi        | native-js                    |                   8.03 |                  590.82 |
| multi        | neon-federated               |                   0.31 |                  594.59 |
| multi        | neon-scan                    |                   0.31 |                  594.97 |
| multi        | relate-child-scan            |                 237.93 |                 1278.12 |
| multi        | relate-child-scope-federated |                 237.53 |                 1284.52 |
| multi        | relate-child-scope-scan      |                 239.66 |                 1287.59 |
| multi        | relate-http-scan             |                 239.98 |                 1282.26 |
| multi        | relate-http-scope-federated  |                 235.08 |                 1290.76 |
| multi        | relate-http-scope-scan       |                 237.35 |                 1292.40 |
| multi        | relate-native                |                 238.42 |                 1288.19 |
| multi        | relate-neon-scan             |                 241.40 |                 1288.48 |
| multi        | relate-neon-scope-federated  |                 241.33 |                 1285.34 |
| multi        | relate-neon-scope-scan       |                 239.15 |                 1290.27 |
| ranking-db   | child-federated              |                   0.32 |                  157.75 |
| ranking-db   | child-scan                   |                   0.33 |                  157.92 |
| ranking-db   | child-snapshot               |                   0.32 |                  157.98 |
| ranking-db   | http-federated               |                   0.56 |                   65.36 |
| ranking-db   | http-scan                    |                   0.59 |                   65.36 |
| ranking-db   | native-js                    |                   1.67 |                  603.94 |
| ranking-db   | neon-federated               |                   0.31 |                  604.22 |
| ranking-db   | neon-scan                    |                   0.32 |                  603.94 |
| ranking-db   | relate-child-scan            |                 267.34 |                 1127.11 |
| ranking-db   | relate-child-scope-federated |                 213.82 |                 1045.47 |
| ranking-db   | relate-child-scope-scan      |                 216.44 |                 1099.21 |
| ranking-db   | relate-http-scan             |                 254.96 |                 1124.61 |
| ranking-db   | relate-http-scope-federated  |                 215.16 |                 1105.32 |
| ranking-db   | relate-http-scope-scan       |                 212.76 |                 1044.06 |
| ranking-db   | relate-neon-scan             |                 218.39 |                 1119.98 |
| ranking-db   | relate-neon-scope-federated  |                 214.22 |                 1121.73 |
| ranking-db   | relate-neon-scope-scan       |                 252.69 |                 1127.99 |
| ranking-db   | relate-postgres              |                 255.82 |                 1104.27 |
| ranking-file | child-federated              |                   0.32 |                  175.32 |
| ranking-file | child-scan                   |                   0.32 |                  175.32 |
| ranking-file | child-snapshot               |                   0.32 |                  175.36 |
| ranking-file | http-federated               |                   0.53 |                   83.78 |
| ranking-file | http-scan                    |                   0.60 |                   83.78 |
| ranking-file | native-js                    |                   1.54 |                  587.35 |
| ranking-file | neon-federated               |                   0.31 |                  589.12 |
| ranking-file | neon-scan                    |                   0.30 |                  587.34 |
| selective    | child-federated              |                   0.30 |                  180.44 |
| selective    | child-scan                   |                   0.31 |                  180.44 |
| selective    | child-snapshot               |                   0.31 |                  180.44 |
| selective    | http-federated               |                   0.50 |                   86.41 |
| selective    | http-scan                    |                   0.51 |                   86.41 |
| selective    | native-js                    |                   0.02 |                  609.94 |
| selective    | neon-federated               |                   0.30 |                  611.36 |
| selective    | neon-scan                    |                   0.30 |                  612.06 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |    21.37 |
| child                             | engine            |    23.49 |
| http                              | engine            |    21.85 |
| relate-postgres                   | ranking-db        |   516.70 |
| relate-neon-scan                  | ranking-db        |   372.06 |
| relate-child-scan                 | ranking-db        |   352.72 |
| relate-http-scan                  | ranking-db        |   343.12 |
| relate-neon-scope-scan            | ranking-db        |   334.94 |
| relate-neon-scope-federated       | ranking-db        |   334.87 |
| relate-child-scope-scan           | ranking-db        |   343.78 |
| relate-child-scope-federated      | ranking-db        |   337.38 |
| relate-http-scope-scan            | ranking-db        |   334.82 |
| relate-http-scope-federated       | ranking-db        |   338.45 |
| relate-native                     | multi             |   509.16 |
| relate-neon-scan                  | multi             |   385.39 |
| relate-child-scan                 | multi             |   388.33 |
| relate-http-scan                  | multi             |   380.93 |
| relate-neon-scope-scan            | multi             |   381.47 |
| relate-neon-scope-federated       | multi             |   378.38 |
| relate-child-scope-scan           | multi             |   383.23 |
| relate-child-scope-federated      | multi             |   381.02 |
| relate-http-scope-scan            | multi             |   383.53 |
| relate-http-scope-federated       | multi             |   389.40 |
| Explicit four-table snapshot load | raw snapshot path |   303.26 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |        23.91 |         155.77 |      177.88 |
| neon-federated  |        40.51 |          80.47 |      128.06 |
| child-scan      |        18.03 |         157.04 |      217.76 |
| child-federated |        20.06 |         112.87 |      183.66 |
| http-scan       |        24.83 |         139.68 |      162.38 |
| http-federated  |        40.84 |          78.80 |      155.94 |

## Provenance

| Archive                          | Commit                                     | Decompressed JSON SHA-256                                          |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| [small.json.gz](small.json.gz)   | `85137b70577876d7be488bea379cbdc8a6c808d2` | `5f4d76b2003d0e09b23a5e19b332db0961a2a9d3951dfb80dffb129002e48a95` |
| [medium.json.gz](medium.json.gz) | `85137b70577876d7be488bea379cbdc8a6c808d2` | `0896136b4eddc21de347ac3c048925ca0934aa47bfcf2f816379afea31d2de01` |
| [large.json.gz](large.json.gz)   | `85137b70577876d7be488bea379cbdc8a6c808d2` | `e09f55dc867ba91ecba04fd814baeea694e9639650d67f2b81f7e6d849a99fc2` |
