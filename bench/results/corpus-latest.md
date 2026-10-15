# Benchmark A — labeled corpus

Generated 2026-10-14.

## synthetic (347 cases, 1526 changed lines)

| rule | TP | FP | FN | precision | recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| test-weakened | 84 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| type-suppression | 54 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| config-tampering | 20 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| stub-left | 23 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| phantom-import | 18 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| swallowed-error | 24 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| duplicate-export | 4 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **all** | 227 | 0 | 0 | 1.00 | 1.00 | 1.00 |

False blocking flags per 1,000 changed lines: 0.00 · latency p50 0.5 ms, p95 1.7 ms

## agent (64 cases, 8645 changed lines)

| rule | TP | FP | FN | precision | recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| test-weakened | 0 | 3 | 0 | 0.00 | — | — |
| type-suppression | 11 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| config-tampering | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| phantom-import | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| swallowed-error | 7 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **all** | 20 | 3 | 0 | 0.87 | 1.00 | 0.93 |

False blocking flags per 1,000 changed lines: 0.12 · latency p50 18.4 ms, p95 129.5 ms

## human (47 cases, 3418 changed lines)

| rule | TP | FP | FN | precision | recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| test-weakened | 0 | 8 | 0 | 0.00 | — | — |
| type-suppression | 15 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| stub-left | 2 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **all** | 17 | 8 | 0 | 0.68 | 1.00 | 0.81 |

False blocking flags per 1,000 changed lines: 0.88 · latency p50 13.6 ms, p95 160.6 ms

