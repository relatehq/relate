# Complete follow-up comparisons

Durations are milliseconds. Warm samples only; p95 uses nearest rank. First
observations and two warmups remain in the archives. No values are copied from
the earlier spike.

## small: 100 customers / 1,000 events

| Scenario     | Path                         |   n |  Median |     p95 |
| ------------ | ---------------------------- | --: | ------: | ------: |
| bulk         | child-federated              |  24 |  3.7552 |  5.0840 |
| bulk         | child-scan                   |  24 |  4.4131 |  4.7520 |
| bulk         | child-snapshot               |  24 |  2.3394 |  2.6240 |
| bulk         | http-federated               |  24 |  4.5729 |  5.8806 |
| bulk         | http-scan                    |  24 |  4.5799 |  5.4285 |
| bulk         | native-js                    |  24 |  1.7549 |  2.0714 |
| bulk         | neon-federated               |  24 |  4.2882 |  5.4388 |
| bulk         | neon-scan                    |  24 |  4.5099 |  5.2468 |
| control      | child-federated              |  24 |  0.1851 |  0.2447 |
| control      | child-scan                   |  24 |  0.2036 |  0.3211 |
| control      | child-snapshot               |  24 |  0.2064 |  0.4130 |
| control      | http-federated               |  24 |  0.6091 |  0.8669 |
| control      | http-scan                    |  24 |  0.6023 |  1.0319 |
| control      | native-js                    |  24 |  0.0041 |  0.0072 |
| control      | neon-federated               |  24 |  0.2264 |  0.4000 |
| control      | neon-scan                    |  24 |  0.2379 |  0.3967 |
| multi        | child-federated              |  24 |  4.9309 |  6.6726 |
| multi        | child-scan                   |  24 |  5.0816 |  6.4149 |
| multi        | child-snapshot               |  24 |  3.4402 |  3.7879 |
| multi        | http-federated               |  24 |  5.4656 |  6.5384 |
| multi        | http-scan                    |  24 |  5.5604 |  6.4080 |
| multi        | native-js                    |  24 |  1.3090 |  1.5896 |
| multi        | neon-federated               |  24 |  5.1761 |  6.4438 |
| multi        | neon-scan                    |  24 |  5.4093 |  6.3075 |
| multi        | relate-child-scan            |  24 | 20.6585 | 22.8200 |
| multi        | relate-child-scope-federated |  24 | 12.2986 | 13.1899 |
| multi        | relate-child-scope-scan      |  24 | 12.3061 | 13.9238 |
| multi        | relate-http-scan             |  24 | 20.6255 | 22.0245 |
| multi        | relate-http-scope-federated  |  24 | 12.7391 | 14.3231 |
| multi        | relate-http-scope-scan       |  24 | 12.6316 | 13.4348 |
| multi        | relate-native                |  24 | 18.6677 | 21.7257 |
| multi        | relate-neon-scan             |  24 | 14.2044 | 15.0627 |
| multi        | relate-neon-scope-federated  |  24 | 12.6267 | 14.0032 |
| multi        | relate-neon-scope-scan       |  24 | 12.6296 | 13.7846 |
| ranking-db   | child-federated              |  24 |  3.6525 |  4.6268 |
| ranking-db   | child-scan                   |  24 |  3.7924 |  4.8048 |
| ranking-db   | child-snapshot               |  24 |  2.3451 |  2.8225 |
| ranking-db   | http-federated               |  24 |  4.1572 |  5.1327 |
| ranking-db   | http-scan                    |  24 |  4.2543 |  4.9600 |
| ranking-db   | native-js                    |  24 |  1.6305 |  2.0606 |
| ranking-db   | neon-federated               |  24 |  4.2524 |  5.3755 |
| ranking-db   | neon-scan                    |  24 |  3.9379 |  5.0148 |
| ranking-db   | relate-child-scan            |  24 | 14.7612 | 16.0588 |
| ranking-db   | relate-child-scope-federated |  24 |  9.7939 | 10.7254 |
| ranking-db   | relate-child-scope-scan      |  24 | 10.1270 | 11.5142 |
| ranking-db   | relate-http-scan             |  24 | 15.6846 | 17.4643 |
| ranking-db   | relate-http-scope-federated  |  24 | 10.1797 | 11.0695 |
| ranking-db   | relate-http-scope-scan       |  24 | 10.3162 | 12.4028 |
| ranking-db   | relate-neon-scan             |  24 | 15.0389 | 18.8878 |
| ranking-db   | relate-neon-scope-federated  |  24 |  9.7927 | 11.3614 |
| ranking-db   | relate-neon-scope-scan       |  24 | 10.2722 | 11.4733 |
| ranking-db   | relate-postgres              |  24 | 16.8988 | 23.4513 |
| ranking-file | child-federated              |  24 |  2.6792 |  3.0992 |
| ranking-file | child-scan                   |  24 |  2.9008 |  3.5053 |
| ranking-file | child-snapshot               |  24 |  2.2712 |  2.8724 |
| ranking-file | http-federated               |  24 |  3.0989 |  3.7453 |
| ranking-file | http-scan                    |  24 |  3.1755 |  3.5924 |
| ranking-file | native-js                    |  24 |  1.2081 |  1.4685 |
| ranking-file | neon-federated               |  24 |  3.2506 |  3.6230 |
| ranking-file | neon-scan                    |  24 |  3.0595 |  3.4593 |
| selective    | child-federated              |  24 |  5.4134 |  5.9787 |
| selective    | child-scan                   |  24 |  5.4303 |  7.0663 |
| selective    | child-snapshot               |  24 |  3.6047 |  4.2451 |
| selective    | http-federated               |  24 |  5.9959 |  7.6558 |
| selective    | http-scan                    |  24 |  5.8681 |  6.7643 |
| selective    | native-js                    |  24 |  1.1687 |  1.9307 |
| selective    | neon-federated               |  24 |  5.8004 |  6.6910 |
| selective    | neon-scan                    |  24 |  5.7638 |  6.2530 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.566 |                -7.29 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.664 |                -5.08 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        0.977 |                -0.24 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.559 |                -7.15 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.654 |                -5.13 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.967 |                -0.31 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.596 |                -6.78 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.651 |                -5.46 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.987 |                -0.14 |
| multi      | relate-neon-scope-federated / relate-native            |        0.707 |                -5.39 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.882 |                -1.68 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        0.994 |                -0.08 |
| multi      | relate-child-scope-federated / relate-native           |        0.658 |                -6.41 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.588 |                -8.61 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        0.976 |                -0.30 |
| multi      | relate-http-scope-federated / relate-native            |        0.697 |                -5.83 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.624 |                -7.72 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        1.023 |                 0.29 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |               0.54 |           5.82 |         0.13 |          5.74 |            2.74 |           2.78 |
| multi      | relate-child-scope-scan      |               0.54 |           5.87 |         0.14 |          5.86 |            2.98 |           2.57 |
| multi      | relate-http-scope-federated  |               0.54 |           6.40 |         0.14 |          5.75 |            2.93 |           2.29 |
| multi      | relate-http-scope-scan       |               0.53 |           6.23 |         0.13 |          5.70 |            2.93 |           2.32 |
| multi      | relate-neon-scope-federated  |               0.53 |           6.06 |         0.13 |          5.85 |            3.13 |           2.72 |
| multi      | relate-neon-scope-scan       |               0.53 |           6.11 |         0.13 |          5.76 |            3.24 |           2.66 |
| ranking-db | relate-child-scope-federated |               0.36 |           4.07 |         0.24 |          5.19 |            1.46 |           2.35 |
| ranking-db | relate-child-scope-scan      |               0.36 |           4.37 |         0.24 |          5.27 |            1.87 |           2.07 |
| ranking-db | relate-http-scope-federated  |               0.35 |           4.28 |         0.24 |          5.22 |            1.50 |           1.64 |
| ranking-db | relate-http-scope-scan       |               0.37 |           4.36 |         0.25 |          5.33 |            1.79 |           1.92 |
| ranking-db | relate-neon-scope-federated  |               0.36 |           3.91 |         0.25 |          5.23 |            1.65 |           2.04 |
| ranking-db | relate-neon-scope-scan       |               0.36 |           3.94 |         0.24 |          5.29 |            1.91 |           1.68 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.28 |                   60.42 |
| bulk         | child-scan                   |                   0.29 |                   60.43 |
| bulk         | child-snapshot               |                   0.29 |                   60.43 |
| bulk         | http-federated               |                   0.45 |                   59.47 |
| bulk         | http-scan                    |                   0.44 |                   59.47 |
| bulk         | native-js                    |                   0.00 |                  415.06 |
| bulk         | neon-federated               |                   0.28 |                  413.78 |
| bulk         | neon-scan                    |                   0.29 |                  414.05 |
| control      | child-federated              |                      — |                   37.61 |
| control      | child-scan                   |                      — |                   37.61 |
| control      | child-snapshot               |                      — |                   37.61 |
| control      | http-federated               |                      — |                   33.05 |
| control      | http-scan                    |                      — |                   33.05 |
| control      | native-js                    |                      — |                  322.77 |
| control      | neon-federated               |                      — |                  321.91 |
| control      | neon-scan                    |                      — |                  322.67 |
| multi        | child-federated              |                   0.29 |                   58.90 |
| multi        | child-scan                   |                   0.30 |                   58.98 |
| multi        | child-snapshot               |                   0.29 |                   58.98 |
| multi        | http-federated               |                   0.46 |                   58.05 |
| multi        | http-scan                    |                   0.42 |                   58.06 |
| multi        | native-js                    |                      — |                  404.36 |
| multi        | neon-federated               |                   0.29 |                  404.68 |
| multi        | neon-scan                    |                   0.29 |                  404.12 |
| multi        | relate-child-scan            |                   1.33 |                  506.85 |
| multi        | relate-child-scope-federated |                   1.07 |                  506.46 |
| multi        | relate-child-scope-scan      |                   1.19 |                  506.38 |
| multi        | relate-http-scan             |                   1.68 |                  506.48 |
| multi        | relate-http-scope-federated  |                   1.42 |                  506.44 |
| multi        | relate-http-scope-scan       |                   1.36 |                  506.38 |
| multi        | relate-native                |                   1.45 |                  506.25 |
| multi        | relate-neon-scan             |                   1.28 |                  507.52 |
| multi        | relate-neon-scope-federated  |                   1.20 |                  506.36 |
| multi        | relate-neon-scope-scan       |                   1.22 |                  506.48 |
| ranking-db   | child-federated              |                   0.28 |                   51.53 |
| ranking-db   | child-scan                   |                   0.29 |                   51.53 |
| ranking-db   | child-snapshot               |                   0.29 |                   51.53 |
| ranking-db   | http-federated               |                   0.41 |                   49.23 |
| ranking-db   | http-scan                    |                   0.41 |                   49.24 |
| ranking-db   | native-js                    |                   0.00 |                  353.29 |
| ranking-db   | neon-federated               |                   0.28 |                  352.96 |
| ranking-db   | neon-scan                    |                   0.28 |                  353.13 |
| ranking-db   | relate-child-scan            |                   0.87 |                  498.61 |
| ranking-db   | relate-child-scope-federated |                   0.80 |                  498.20 |
| ranking-db   | relate-child-scope-scan      |                   0.86 |                  496.82 |
| ranking-db   | relate-http-scan             |                   1.18 |                  498.29 |
| ranking-db   | relate-http-scope-federated  |                   1.03 |                  499.41 |
| ranking-db   | relate-http-scope-scan       |                   1.09 |                  498.99 |
| ranking-db   | relate-neon-scan             |                   1.05 |                  497.92 |
| ranking-db   | relate-neon-scope-federated  |                   0.83 |                  498.12 |
| ranking-db   | relate-neon-scope-scan       |                   0.86 |                  498.07 |
| ranking-db   | relate-postgres              |                   1.17 |                  498.38 |
| ranking-file | child-federated              |                   0.29 |                   55.86 |
| ranking-file | child-scan                   |                   0.29 |                   55.88 |
| ranking-file | child-snapshot               |                   0.30 |                   55.88 |
| ranking-file | http-federated               |                   0.47 |                   55.01 |
| ranking-file | http-scan                    |                   0.45 |                   55.02 |
| ranking-file | native-js                    |                      — |                  395.64 |
| ranking-file | neon-federated               |                   0.28 |                  393.59 |
| ranking-file | neon-scan                    |                   0.28 |                  396.17 |
| selective    | child-federated              |                   0.29 |                   59.97 |
| selective    | child-scan                   |                   0.29 |                   59.97 |
| selective    | child-snapshot               |                   0.29 |                   59.97 |
| selective    | http-federated               |                   0.46 |                   59.20 |
| selective    | http-scan                    |                   0.27 |                   59.20 |
| selective    | native-js                    |                   0.09 |                  409.70 |
| selective    | neon-federated               |                   0.29 |                  408.26 |
| selective    | neon-scan                    |                   0.28 |                  411.32 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |    25.07 |
| child                             | engine            |    24.29 |
| http                              | engine            |    22.28 |
| relate-postgres                   | ranking-db        |    49.03 |
| relate-neon-scan                  | ranking-db        |    14.47 |
| relate-child-scan                 | ranking-db        |    13.32 |
| relate-http-scan                  | ranking-db        |    12.09 |
| relate-neon-scope-scan            | ranking-db        |    11.35 |
| relate-neon-scope-federated       | ranking-db        |    11.67 |
| relate-child-scope-scan           | ranking-db        |    14.91 |
| relate-child-scope-federated      | ranking-db        |    12.99 |
| relate-http-scope-scan            | ranking-db        |    12.04 |
| relate-http-scope-federated       | ranking-db        |    12.34 |
| relate-native                     | multi             |    18.78 |
| relate-neon-scan                  | multi             |    12.53 |
| relate-child-scan                 | multi             |    12.20 |
| relate-http-scan                  | multi             |    11.93 |
| relate-neon-scope-scan            | multi             |    11.01 |
| relate-neon-scope-federated       | multi             |    11.72 |
| relate-child-scope-scan           | multi             |    12.20 |
| relate-child-scope-federated      | multi             |    11.12 |
| relate-http-scope-scan            | multi             |    11.32 |
| relate-http-scope-federated       | multi             |    11.29 |
| Explicit four-table snapshot load | raw snapshot path |     3.90 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |       578.88 |           5.97 |        9.07 |
| neon-federated  |       709.39 |           5.38 |        5.92 |
| child-scan      |       230.43 |          10.76 |       17.90 |
| child-federated |       229.51 |          10.26 |       17.63 |
| http-scan       |       427.02 |           7.21 |       14.45 |
| http-federated  |       531.68 |           6.87 |        8.16 |

## medium: 1,000 customers / 100,000 events

| Scenario     | Path                         |   n |   Median |      p95 |
| ------------ | ---------------------------- | --: | -------: | -------: |
| bulk         | child-federated              |  24 |  16.9682 |  17.2373 |
| bulk         | child-scan                   |  24 |  21.8155 |  22.2053 |
| bulk         | child-snapshot               |  24 |   4.2303 |   4.5809 |
| bulk         | http-federated               |  24 |  17.3110 |  18.3238 |
| bulk         | http-scan                    |  24 |  22.1614 |  22.8710 |
| bulk         | native-js                    |  24 |  11.4756 |  12.5827 |
| bulk         | neon-federated               |  24 |  16.8874 |  17.7002 |
| bulk         | neon-scan                    |  24 |  21.6251 |  22.4455 |
| control      | child-federated              |  24 |   0.1773 |   0.2407 |
| control      | child-scan                   |  24 |   0.1995 |   0.2416 |
| control      | child-snapshot               |  24 |   0.1984 |   0.2480 |
| control      | http-federated               |  24 |   0.5405 |   0.7600 |
| control      | http-scan                    |  24 |   0.5680 |   0.7752 |
| control      | native-js                    |  24 |   0.0035 |   0.0047 |
| control      | neon-federated               |  24 |   0.1946 |   0.3110 |
| control      | neon-scan                    |  24 |   0.2013 |   0.3065 |
| multi        | child-federated              |  24 |   7.8577 |   8.2756 |
| multi        | child-scan                   |  24 |   9.1731 |   9.8485 |
| multi        | child-snapshot               |  24 |   4.3768 |   4.6459 |
| multi        | http-federated               |  24 |   8.3600 |   8.8315 |
| multi        | http-scan                    |  24 |   9.6078 |  10.1634 |
| multi        | native-js                    |  24 |   4.9227 |   5.3191 |
| multi        | neon-federated               |  24 |   8.2092 |   8.7223 |
| multi        | neon-scan                    |  24 |   9.4270 |  10.1845 |
| multi        | relate-child-scan            |  24 | 159.1529 | 163.4194 |
| multi        | relate-child-scope-federated |  24 |  78.4164 |  83.1140 |
| multi        | relate-child-scope-scan      |  24 |  79.4172 |  84.7939 |
| multi        | relate-http-scan             |  24 | 158.2616 | 185.7089 |
| multi        | relate-http-scope-federated  |  24 |  78.5666 |  81.8066 |
| multi        | relate-http-scope-scan       |  24 |  80.1781 |  85.6510 |
| multi        | relate-native                |  24 |  88.6783 |  93.0467 |
| multi        | relate-neon-scan             |  24 | 114.8367 | 117.7646 |
| multi        | relate-neon-scope-federated  |  24 |  77.5286 |  81.3882 |
| multi        | relate-neon-scope-scan       |  24 |  79.6233 |  82.4163 |
| ranking-db   | child-federated              |  24 |  15.7588 |  16.3786 |
| ranking-db   | child-scan                   |  24 |  20.6108 |  21.8765 |
| ranking-db   | child-snapshot               |  24 |   3.1301 |   3.4476 |
| ranking-db   | http-federated               |  24 |  15.8913 |  16.4520 |
| ranking-db   | http-scan                    |  24 |  21.0360 |  21.5975 |
| ranking-db   | native-js                    |  24 |  11.4664 |  12.1713 |
| ranking-db   | neon-federated               |  24 |  16.0820 |  16.6905 |
| ranking-db   | neon-scan                    |  24 |  20.6807 |  21.3536 |
| ranking-db   | relate-child-scan            |  24 | 135.1099 | 138.3575 |
| ranking-db   | relate-child-scope-federated |  24 |  78.9603 |  82.1540 |
| ranking-db   | relate-child-scope-scan      |  24 |  83.3927 |  85.8870 |
| ranking-db   | relate-http-scan             |  24 | 136.5123 | 138.6223 |
| ranking-db   | relate-http-scope-federated  |  24 |  79.1425 |  81.1374 |
| ranking-db   | relate-http-scope-scan       |  24 |  84.3612 |  87.2586 |
| ranking-db   | relate-neon-scan             |  24 | 135.4518 | 138.1550 |
| ranking-db   | relate-neon-scope-federated  |  24 |  78.8794 |  81.0680 |
| ranking-db   | relate-neon-scope-scan       |  24 |  83.2585 |  84.4022 |
| ranking-db   | relate-postgres              |  24 | 104.7050 | 107.9845 |
| ranking-file | child-federated              |  24 |   3.7929 |   4.2247 |
| ranking-file | child-scan                   |  24 |   4.0137 |   4.6649 |
| ranking-file | child-snapshot               |  24 |   3.0743 |   3.5256 |
| ranking-file | http-federated               |  24 |   4.4500 |   4.9911 |
| ranking-file | http-scan                    |  24 |   4.3081 |   4.9996 |
| ranking-file | native-js                    |  24 |   4.2571 |   4.9457 |
| ranking-file | neon-federated               |  24 |   4.3126 |   5.1246 |
| ranking-file | neon-scan                    |  24 |   4.2218 |   4.9464 |
| selective    | child-federated              |  24 |   5.8317 |   7.1666 |
| selective    | child-scan                   |  24 |   5.9571 |   6.9919 |
| selective    | child-snapshot               |  24 |   4.0768 |   4.5671 |
| selective    | http-federated               |  24 |   6.6094 |   7.4835 |
| selective    | http-scan                    |  24 |   6.3051 |   7.4208 |
| selective    | native-js                    |  24 |   1.4820 |   1.5755 |
| selective    | neon-federated               |  24 |   6.1870 |   7.1390 |
| selective    | neon-scan                    |  24 |   6.1513 |   7.1038 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.763 |               -24.73 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.583 |               -56.26 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        0.949 |                -4.21 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.764 |               -24.82 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.586 |               -55.70 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.948 |                -4.31 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.763 |               -24.94 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.582 |               -56.92 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.941 |                -4.93 |
| multi      | relate-neon-scope-federated / relate-native            |        0.877 |               -11.05 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.680 |               -36.66 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        0.979 |                -1.67 |
| multi      | relate-child-scope-federated / relate-native           |        0.881 |               -10.87 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.495 |               -80.23 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        0.984 |                -1.22 |
| multi      | relate-http-scope-federated / relate-native            |        0.882 |               -10.54 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.501 |               -78.69 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        0.983 |                -1.41 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |               4.41 |          14.99 |         1.18 |         58.19 |            3.21 |           9.47 |
| multi      | relate-child-scope-scan      |               4.53 |          16.69 |         1.25 |         58.42 |            3.21 |          10.89 |
| multi      | relate-http-scope-federated  |               4.33 |          15.41 |         1.22 |         58.92 |            3.27 |           9.43 |
| multi      | relate-http-scope-scan       |               4.45 |          16.60 |         1.10 |         58.32 |            3.32 |          10.41 |
| multi      | relate-neon-scope-federated  |               4.33 |          14.58 |         1.28 |         58.26 |            3.34 |           9.22 |
| multi      | relate-neon-scope-scan       |               4.45 |          16.03 |         1.23 |         58.53 |            3.36 |          10.64 |
| ranking-db | relate-child-scope-federated |               3.00 |          17.49 |         2.26 |         56.23 |            1.76 |          13.77 |
| ranking-db | relate-child-scope-scan      |               2.97 |          21.90 |         2.28 |         56.19 |            1.94 |          18.18 |
| ranking-db | relate-http-scope-federated  |               2.98 |          17.91 |         2.25 |         56.08 |            1.77 |          13.85 |
| ranking-db | relate-http-scope-scan       |               2.99 |          22.48 |         2.35 |         56.52 |            2.01 |          18.18 |
| ranking-db | relate-neon-scope-federated  |               3.22 |          17.05 |         2.27 |         56.35 |            1.82 |          13.84 |
| ranking-db | relate-neon-scope-scan       |               3.02 |          21.75 |         2.31 |         56.09 |            2.06 |          18.32 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.28 |                   80.84 |
| bulk         | child-scan                   |                   0.30 |                   80.84 |
| bulk         | child-snapshot               |                   0.31 |                   80.84 |
| bulk         | http-federated               |                   0.34 |                   69.98 |
| bulk         | http-scan                    |                   0.38 |                   69.98 |
| bulk         | native-js                    |                   0.66 |                  491.41 |
| bulk         | neon-federated               |                   0.28 |                  492.81 |
| bulk         | neon-scan                    |                   0.29 |                  494.34 |
| control      | child-federated              |                      — |                   47.45 |
| control      | child-scan                   |                      — |                   47.45 |
| control      | child-snapshot               |                      — |                   47.45 |
| control      | http-federated               |                      — |                   33.27 |
| control      | http-scan                    |                      — |                   33.27 |
| control      | native-js                    |                      — |                  409.19 |
| control      | neon-federated               |                      — |                  409.19 |
| control      | neon-scan                    |                      — |                  409.19 |
| multi        | child-federated              |                   0.30 |                   77.70 |
| multi        | child-scan                   |                   0.30 |                   77.70 |
| multi        | child-snapshot               |                   0.29 |                   77.71 |
| multi        | http-federated               |                   0.47 |                   66.39 |
| multi        | http-scan                    |                   0.46 |                   66.39 |
| multi        | native-js                    |                   0.22 |                  507.10 |
| multi        | neon-federated               |                   0.29 |                  506.50 |
| multi        | neon-scan                    |                   0.29 |                  506.58 |
| multi        | relate-child-scan            |                  36.30 |                  579.30 |
| multi        | relate-child-scope-federated |                  35.38 |                  576.55 |
| multi        | relate-child-scope-scan      |                  35.36 |                  576.55 |
| multi        | relate-http-scan             |                  37.83 |                  578.74 |
| multi        | relate-http-scope-federated  |                  35.99 |                  576.53 |
| multi        | relate-http-scope-scan       |                  36.27 |                  576.54 |
| multi        | relate-native                |                  36.12 |                  576.53 |
| multi        | relate-neon-scan             |                  36.24 |                  576.52 |
| multi        | relate-neon-scope-federated  |                  35.37 |                  577.12 |
| multi        | relate-neon-scope-scan       |                  35.60 |                  577.67 |
| ranking-db   | child-federated              |                   0.28 |                   69.03 |
| ranking-db   | child-scan                   |                   0.29 |                   69.03 |
| ranking-db   | child-snapshot               |                   0.30 |                   69.06 |
| ranking-db   | http-federated               |                   0.34 |                   56.48 |
| ranking-db   | http-scan                    |                   0.39 |                   56.48 |
| ranking-db   | native-js                    |                   0.67 |                  454.80 |
| ranking-db   | neon-federated               |                   0.30 |                  453.82 |
| ranking-db   | neon-scan                    |                   0.29 |                  454.56 |
| ranking-db   | relate-child-scan            |                  34.40 |                  528.59 |
| ranking-db   | relate-child-scope-federated |                  34.30 |                  525.77 |
| ranking-db   | relate-child-scope-scan      |                  33.94 |                  525.77 |
| ranking-db   | relate-http-scan             |                  34.97 |                  526.43 |
| ranking-db   | relate-http-scope-federated  |                  34.38 |                  532.25 |
| ranking-db   | relate-http-scope-scan       |                  34.53 |                  532.16 |
| ranking-db   | relate-neon-scan             |                  34.63 |                  530.43 |
| ranking-db   | relate-neon-scope-federated  |                  34.49 |                  529.41 |
| ranking-db   | relate-neon-scope-scan       |                  34.04 |                  529.40 |
| ranking-db   | relate-postgres              |                  34.71 |                  532.25 |
| ranking-file | child-federated              |                   0.29 |                   76.34 |
| ranking-file | child-scan                   |                   0.29 |                   76.34 |
| ranking-file | child-snapshot               |                   0.30 |                   76.36 |
| ranking-file | http-federated               |                   0.46 |                   65.17 |
| ranking-file | http-scan                    |                   0.42 |                   65.17 |
| ranking-file | native-js                    |                   0.49 |                  500.81 |
| ranking-file | neon-federated               |                   0.28 |                  501.80 |
| ranking-file | neon-scan                    |                   0.28 |                  500.92 |
| selective    | child-federated              |                   0.30 |                   78.90 |
| selective    | child-scan                   |                   0.30 |                   78.90 |
| selective    | child-snapshot               |                   0.30 |                   78.91 |
| selective    | http-federated               |                   0.46 |                   68.38 |
| selective    | http-scan                    |                   0.46 |                   68.38 |
| selective    | native-js                    |                   0.00 |                  505.48 |
| selective    | neon-federated               |                   0.29 |                  505.55 |
| selective    | neon-scan                    |                   0.29 |                  506.35 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |    23.25 |
| child                             | engine            |    26.77 |
| http                              | engine            |    23.61 |
| relate-postgres                   | ranking-db        |    90.83 |
| relate-neon-scan                  | ranking-db        |    43.23 |
| relate-child-scan                 | ranking-db        |    41.18 |
| relate-http-scan                  | ranking-db        |    40.28 |
| relate-neon-scope-scan            | ranking-db        |    39.96 |
| relate-neon-scope-federated       | ranking-db        |    38.45 |
| relate-child-scope-scan           | ranking-db        |    39.65 |
| relate-child-scope-federated      | ranking-db        |    41.53 |
| relate-http-scope-scan            | ranking-db        |    38.19 |
| relate-http-scope-federated       | ranking-db        |    36.53 |
| relate-native                     | multi             |    53.60 |
| relate-neon-scan                  | multi             |    44.44 |
| relate-child-scan                 | multi             |    42.72 |
| relate-http-scan                  | multi             |    40.47 |
| relate-neon-scope-scan            | multi             |    43.23 |
| relate-neon-scope-federated       | multi             |    40.68 |
| relate-child-scope-scan           | multi             |    42.78 |
| relate-child-scope-federated      | multi             |    41.19 |
| relate-http-scope-scan            | multi             |    41.50 |
| relate-http-scope-federated       | multi             |    40.37 |
| Explicit four-table snapshot load | raw snapshot path |    35.29 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |       189.00 |          19.46 |       24.37 |
| neon-federated  |       351.15 |          11.11 |       11.58 |
| child-scan      |       110.20 |          22.93 |       36.68 |
| child-federated |       132.74 |          18.60 |       30.52 |
| http-scan       |       178.07 |          19.56 |       24.01 |
| http-federated  |       309.90 |          12.38 |       13.47 |

## large: 12,500 customers / 1,000,000 events

| Scenario     | Path                         |   n |    Median |       p95 |
| ------------ | ---------------------------- | --: | --------: | --------: |
| bulk         | child-federated              |  24 |   77.8841 |   85.9595 |
| bulk         | child-scan                   |  24 |  194.9280 |  242.4965 |
| bulk         | child-snapshot               |  24 |   23.2780 |   23.9995 |
| bulk         | http-federated               |  24 |   78.9812 |   81.4186 |
| bulk         | http-scan                    |  24 |  194.0167 |  244.4181 |
| bulk         | native-js                    |  24 |   72.1038 |   73.5713 |
| bulk         | neon-federated               |  24 |   75.1039 |   76.7696 |
| bulk         | neon-scan                    |  24 |  190.8967 |  192.5963 |
| control      | child-federated              |  24 |    0.2085 |    0.3130 |
| control      | child-scan                   |  24 |    0.2561 |    0.4308 |
| control      | child-snapshot               |  24 |    0.2220 |    0.3905 |
| control      | http-federated               |  24 |    0.6900 |    0.8989 |
| control      | http-scan                    |  24 |    0.6593 |    0.8848 |
| control      | native-js                    |  24 |    0.0043 |    0.0072 |
| control      | neon-federated               |  24 |    0.2420 |    0.3908 |
| control      | neon-scan                    |  24 |    0.2599 |    0.4169 |
| multi        | child-federated              |  24 |   46.7183 |   47.5436 |
| multi        | child-scan                   |  24 |   52.1217 |   53.0159 |
| multi        | child-snapshot               |  24 |   12.9339 |   13.3056 |
| multi        | http-federated               |  24 |   46.8617 |   48.6590 |
| multi        | http-scan                    |  24 |   52.3254 |   53.7785 |
| multi        | native-js                    |  24 |   43.1897 |   47.2248 |
| multi        | neon-federated               |  24 |   46.7289 |   47.9252 |
| multi        | neon-scan                    |  24 |   52.6001 |   55.1184 |
| multi        | relate-child-scan            |  24 | 5095.0253 | 5231.1877 |
| multi        | relate-child-scope-federated |  24 | 3578.3224 | 3642.7178 |
| multi        | relate-child-scope-scan      |  24 | 3570.6823 | 3632.0595 |
| multi        | relate-http-scan             |  24 | 4230.0996 | 4292.9595 |
| multi        | relate-http-scope-federated  |  24 | 3564.6192 | 3597.4792 |
| multi        | relate-http-scope-scan       |  24 | 3564.3734 | 3649.0271 |
| multi        | relate-native                |  24 | 3801.7993 | 3834.3572 |
| multi        | relate-neon-scan             |  24 | 4338.6611 | 4418.1131 |
| multi        | relate-neon-scope-federated  |  24 | 3549.4256 | 3591.1166 |
| multi        | relate-neon-scope-scan       |  24 | 3558.7127 | 3620.5495 |
| ranking-db   | child-federated              |  24 |   62.2475 |   64.3952 |
| ranking-db   | child-scan                   |  24 |  180.8575 |  182.6158 |
| ranking-db   | child-snapshot               |  24 |    7.8371 |    7.9627 |
| ranking-db   | http-federated               |  24 |   62.7901 |   64.2893 |
| ranking-db   | http-scan                    |  24 |  181.2915 |  182.5409 |
| ranking-db   | native-js                    |  24 |   66.9846 |   69.3159 |
| ranking-db   | neon-federated               |  24 |   61.9035 |   63.6557 |
| ranking-db   | neon-scan                    |  24 |  180.6184 |  183.0837 |
| ranking-db   | relate-child-scan            |  24 | 6704.1849 | 7716.6752 |
| ranking-db   | relate-child-scope-federated |  24 | 3549.8523 | 3589.5629 |
| ranking-db   | relate-child-scope-scan      |  24 | 3682.5851 | 3750.7698 |
| ranking-db   | relate-http-scan             |  24 | 6008.1786 | 6098.0989 |
| ranking-db   | relate-http-scope-federated  |  24 | 3544.6224 | 3616.4743 |
| ranking-db   | relate-http-scope-scan       |  24 | 3661.7475 | 3749.0243 |
| ranking-db   | relate-neon-scan             |  24 | 6015.2381 | 6095.6850 |
| ranking-db   | relate-neon-scope-federated  |  24 | 3546.6495 | 3610.3767 |
| ranking-db   | relate-neon-scope-scan       |  24 | 3668.1834 | 3767.1895 |
| ranking-db   | relate-postgres              |  24 | 3611.4531 | 3646.5903 |
| ranking-file | child-federated              |  24 |   18.8986 |   19.4901 |
| ranking-file | child-scan                   |  24 |   18.7052 |   20.1991 |
| ranking-file | child-snapshot               |  24 |   10.3320 |   10.6969 |
| ranking-file | http-federated               |  24 |   19.0577 |   20.1701 |
| ranking-file | http-scan                    |  24 |   19.1227 |   20.5748 |
| ranking-file | native-js                    |  24 |   30.0689 |   33.0111 |
| ranking-file | neon-federated               |  24 |   18.8622 |   19.8341 |
| ranking-file | neon-scan                    |  24 |   18.6523 |   20.3966 |
| selective    | child-federated              |  24 |   15.6132 |   17.0458 |
| selective    | child-scan                   |  24 |   15.7650 |   16.7938 |
| selective    | child-snapshot               |  24 |    7.3046 |    7.7082 |
| selective    | http-federated               |  24 |   16.5006 |   17.7830 |
| selective    | http-scan                    |  24 |   16.1631 |   17.1979 |
| selective    | native-js                    |  24 |    3.2901 |    3.4746 |
| selective    | neon-federated               |  24 |   16.0058 |   17.0729 |
| selective    | neon-scan                    |  24 |   16.1024 |   17.4930 |

### Paired public-runtime comparisons

A ratio below 1 means the numerator is faster. Ratios and differences pair
observations from the same rotated block; these are descriptive, not isolated
causal effects.

| Query      | Numerator / denominator                                | Median ratio | Median difference ms |
| ---------- | ------------------------------------------------------ | -----------: | -------------------: |
| ranking-db | relate-neon-scope-federated / relate-postgres          |        0.983 |               -63.07 |
| ranking-db | relate-neon-scope-federated / relate-neon-scan         |        0.590 |             -2478.04 |
| ranking-db | relate-neon-scope-federated / relate-neon-scope-scan   |        0.965 |              -128.28 |
| ranking-db | relate-child-scope-federated / relate-postgres         |        0.983 |               -60.18 |
| ranking-db | relate-child-scope-federated / relate-child-scan       |        0.534 |             -3122.57 |
| ranking-db | relate-child-scope-federated / relate-child-scope-scan |        0.968 |              -117.58 |
| ranking-db | relate-http-scope-federated / relate-postgres          |        0.984 |               -58.07 |
| ranking-db | relate-http-scope-federated / relate-http-scan         |        0.590 |             -2468.93 |
| ranking-db | relate-http-scope-federated / relate-http-scope-scan   |        0.966 |              -124.54 |
| multi      | relate-neon-scope-federated / relate-native            |        0.936 |              -244.72 |
| multi      | relate-neon-scope-federated / relate-neon-scan         |        0.819 |              -786.78 |
| multi      | relate-neon-scope-federated / relate-neon-scope-scan   |        1.000 |                 0.42 |
| multi      | relate-child-scope-federated / relate-native           |        0.940 |              -227.49 |
| multi      | relate-child-scope-federated / relate-child-scan       |        0.702 |             -1515.81 |
| multi      | relate-child-scope-federated / relate-child-scope-scan |        0.997 |               -10.93 |
| multi      | relate-http-scope-federated / relate-native            |        0.936 |              -244.23 |
| multi      | relate-http-scope-federated / relate-http-scan         |        0.845 |              -652.70 |
| multi      | relate-http-scope-federated / relate-http-scope-scan   |        0.998 |                -6.91 |

### Scope execution breakdown

The engine span includes serialization, request-local Arrow registration,
planning, source reads, execution and JSON decoding. Plan/collect/encode are
nested in that span and must not be added again. Outside-scope time includes
ordinary authorization/dependency reads, materialization, revalidation, sorting
and projection.

| Query      | Path                         | Compiler and masks | Engine request | Result merge | Outside scope | Engine planning | Engine collect |
| ---------- | ---------------------------- | -----------------: | -------------: | -----------: | ------------: | --------------: | -------------: |
| multi      | relate-child-scope-federated |              63.65 |          74.74 |        12.77 |       3423.02 |            4.00 |          45.11 |
| multi      | relate-child-scope-scan      |              65.07 |          80.10 |        13.22 |       3413.96 |            4.03 |          51.77 |
| multi      | relate-http-scope-federated  |              64.69 |          74.63 |        13.15 |       3408.61 |            4.00 |          45.72 |
| multi      | relate-http-scope-scan       |              63.27 |          80.16 |        12.55 |       3410.91 |            4.08 |          51.24 |
| multi      | relate-neon-scope-federated  |              63.01 |          69.69 |        12.50 |       3403.14 |            4.08 |          44.84 |
| multi      | relate-neon-scope-scan       |              63.58 |          74.72 |        13.27 |       3406.45 |            4.11 |          50.60 |
| ranking-db | relate-child-scope-federated |              43.77 |          87.73 |        27.81 |       3383.67 |            2.18 |          66.88 |
| ranking-db | relate-child-scope-scan      |              45.68 |         199.44 |        27.40 |       3396.49 |            2.36 |         178.69 |
| ranking-db | relate-http-scope-federated  |              44.86 |          90.12 |        28.17 |       3382.16 |            2.19 |          68.31 |
| ranking-db | relate-http-scope-scan       |              42.73 |         197.70 |        27.58 |       3390.90 |            2.35 |         176.94 |
| ranking-db | relate-neon-scope-federated  |              44.98 |          84.26 |        27.61 |       3386.95 |            2.24 |          66.39 |
| ranking-db | relate-neon-scope-scan       |              46.51 |         194.48 |        28.65 |       3400.86 |            2.41 |         177.48 |

### Observed timer lag and RSS

Timer lag is the largest observed delayed 2 ms tick within each request; null
means no tick was observed, not zero blocking. RSS is after-request, not peak.
Public paths sample Node only; Neon includes its engine, child/HTTP exclude
their engine. Raw paths also differ in fixture/snapshot population. These
observations cannot rank memory efficiency.

| Query        | Path                         | Median observed lag ms | Median observed RSS MiB |
| ------------ | ---------------------------- | ---------------------: | ----------------------: |
| bulk         | child-federated              |                   0.31 |                  195.44 |
| bulk         | child-scan                   |                   0.31 |                  195.44 |
| bulk         | child-snapshot               |                   0.31 |                  195.44 |
| bulk         | http-federated               |                   0.56 |                  104.39 |
| bulk         | http-scan                    |                   0.59 |                  104.39 |
| bulk         | native-js                    |                   1.60 |                  673.49 |
| bulk         | neon-federated               |                   0.30 |                  673.14 |
| bulk         | neon-scan                    |                   0.30 |                  673.14 |
| control      | child-federated              |                      — |                  127.12 |
| control      | child-scan                   |                      — |                  127.12 |
| control      | child-snapshot               |                      — |                  127.12 |
| control      | http-federated               |                      — |                   34.16 |
| control      | http-scan                    |                      — |                   34.16 |
| control      | native-js                    |                      — |                  864.71 |
| control      | neon-federated               |                      — |                  864.71 |
| control      | neon-scan                    |                      — |                  864.71 |
| multi        | child-federated              |                   0.31 |                  177.98 |
| multi        | child-scan                   |                   0.32 |                  177.98 |
| multi        | child-snapshot               |                   0.32 |                  177.98 |
| multi        | http-federated               |                   0.56 |                   86.43 |
| multi        | http-scan                    |                   0.51 |                   86.43 |
| multi        | native-js                    |                   8.10 |                  619.34 |
| multi        | neon-federated               |                   0.30 |                  623.09 |
| multi        | neon-scan                    |                   0.31 |                  622.24 |
| multi        | relate-child-scan            |                2761.67 |                 1299.68 |
| multi        | relate-child-scope-federated |                2774.43 |                 1317.33 |
| multi        | relate-child-scope-scan      |                2764.72 |                 1292.94 |
| multi        | relate-http-scan             |                2773.08 |                 1301.40 |
| multi        | relate-http-scope-federated  |                2763.79 |                 1247.75 |
| multi        | relate-http-scope-scan       |                2758.21 |                 1302.12 |
| multi        | relate-native                |                2757.80 |                 1272.34 |
| multi        | relate-neon-scan             |                2770.92 |                 1311.88 |
| multi        | relate-neon-scope-federated  |                2757.84 |                 1280.15 |
| multi        | relate-neon-scope-scan       |                2756.25 |                 1265.95 |
| ranking-db   | child-federated              |                   0.31 |                  160.53 |
| ranking-db   | child-scan                   |                   0.32 |                  160.57 |
| ranking-db   | child-snapshot               |                   0.32 |                  160.59 |
| ranking-db   | http-federated               |                   0.39 |                   66.14 |
| ranking-db   | http-scan                    |                   0.30 |                   66.14 |
| ranking-db   | native-js                    |                   1.58 |                  573.05 |
| ranking-db   | neon-federated               |                   0.31 |                  573.49 |
| ranking-db   | neon-scan                    |                   0.31 |                  573.37 |
| ranking-db   | relate-child-scan            |                2748.91 |                  874.75 |
| ranking-db   | relate-child-scope-federated |                2746.65 |                 1011.04 |
| ranking-db   | relate-child-scope-scan      |                2752.52 |                  952.01 |
| ranking-db   | relate-http-scan             |                2753.45 |                  886.09 |
| ranking-db   | relate-http-scope-federated  |                2741.12 |                 1108.14 |
| ranking-db   | relate-http-scope-scan       |                2748.29 |                 1085.90 |
| ranking-db   | relate-neon-scan             |                2742.22 |                  924.04 |
| ranking-db   | relate-neon-scope-federated  |                2743.05 |                  932.84 |
| ranking-db   | relate-neon-scope-scan       |                2751.11 |                  918.14 |
| ranking-db   | relate-postgres              |                2755.46 |                  959.73 |
| ranking-file | child-federated              |                   0.31 |                  175.83 |
| ranking-file | child-scan                   |                   0.31 |                  175.83 |
| ranking-file | child-snapshot               |                   0.31 |                  175.83 |
| ranking-file | http-federated               |                   0.51 |                   84.08 |
| ranking-file | http-scan                    |                   0.47 |                   84.08 |
| ranking-file | native-js                    |                   1.52 |                  603.06 |
| ranking-file | neon-federated               |                   0.31 |                  602.39 |
| ranking-file | neon-scan                    |                   0.30 |                  602.85 |
| selective    | child-federated              |                   0.30 |                  178.89 |
| selective    | child-scan                   |                   0.30 |                  178.89 |
| selective    | child-snapshot               |                   0.30 |                  178.89 |
| selective    | http-federated               |                   0.50 |                   87.09 |
| selective    | http-scan                    |                   0.53 |                   87.09 |
| selective    | native-js                    |                   0.13 |                  626.78 |
| selective    | neon-federated               |                   0.30 |                  625.91 |
| selective    | neon-scan                    |                   0.30 |                  626.80 |

### Setup observations

| Component                         | Scenario          | Setup ms |
| --------------------------------- | ----------------- | -------: |
| neon                              | engine            |    21.47 |
| child                             | engine            |    23.89 |
| http                              | engine            |    23.10 |
| relate-postgres                   | ranking-db        |   502.32 |
| relate-neon-scan                  | ranking-db        |   353.18 |
| relate-child-scan                 | ranking-db        |   351.51 |
| relate-http-scan                  | ranking-db        |   332.68 |
| relate-neon-scope-scan            | ranking-db        |   325.88 |
| relate-neon-scope-federated       | ranking-db        |   322.05 |
| relate-child-scope-scan           | ranking-db        |   336.83 |
| relate-child-scope-federated      | ranking-db        |   328.25 |
| relate-http-scope-scan            | ranking-db        |   324.00 |
| relate-http-scope-federated       | ranking-db        |   333.13 |
| relate-native                     | multi             |   500.54 |
| relate-neon-scan                  | multi             |   422.48 |
| relate-child-scan                 | multi             |   403.73 |
| relate-http-scan                  | multi             |   361.95 |
| relate-neon-scope-scan            | multi             |   387.07 |
| relate-neon-scope-federated       | multi             |   377.28 |
| relate-child-scope-scan           | multi             |   376.41 |
| relate-child-scope-federated      | multi             |   373.50 |
| relate-http-scope-scan            | multi             |   371.13 |
| relate-http-scope-federated       | multi             |   360.21 |
| Explicit four-table snapshot load | raw snapshot path |   314.73 |

### Existing four-arrival raw SQL bursts, rerun

Five waves of four requests. Client assertions are included in wave throughput.
These bursts do not include the public Relate runtime or authorized scope
upload.

| Path            | Requests/sec | Request median | Request p95 |
| --------------- | -----------: | -------------: | ----------: |
| neon-scan       |        24.20 |         131.27 |      169.10 |
| neon-federated  |        49.71 |          74.55 |       81.46 |
| child-scan      |        18.52 |         145.84 |      211.15 |
| child-federated |        21.81 |         115.72 |      182.26 |
| http-scan       |        24.06 |         136.14 |      167.95 |
| http-federated  |        50.53 |          73.58 |       80.82 |

## Provenance

| Archive                          | Commit                                     | Decompressed JSON SHA-256                                          |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| [small.json.gz](small.json.gz)   | `25d09828df3bf7d5664101a1b7183b85e68d47fb` | `55797dadd79445acd7ddbb49edb6f086254eae8f1f5a14c3fd5620f01ea6c9b1` |
| [medium.json.gz](medium.json.gz) | `25d09828df3bf7d5664101a1b7183b85e68d47fb` | `2479e736ae68404e30f01f18a27d322a969b8eff83793b8ab5f6940fb36d6f0c` |
| [large.json.gz](large.json.gz)   | `25d09828df3bf7d5664101a1b7183b85e68d47fb` | `46fe9ba1daae0897b2da2aa324f615acdcae5b39999388c036b4b2446c4a0393` |
