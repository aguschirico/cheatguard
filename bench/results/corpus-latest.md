# Benchmark A — labeled corpus

Generated 2026-10-20.

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

False blocking flags per 1,000 changed lines: 0.00 · latency p50 0.5 ms, p95 1.4 ms

## agent (154 cases, 20313 changed lines)

| rule | TP | FP | FN | precision | recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| test-weakened | 0 | 19 | 0 | 0.00 | — | — |
| type-suppression | 32 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| config-tampering | 2 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| stub-left | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| phantom-import | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| swallowed-error | 12 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **all** | 48 | 19 | 0 | 0.72 | 1.00 | 0.83 |

False blocking flags per 1,000 changed lines: 0.44 · latency p50 13.7 ms, p95 163.6 ms

## human (122 cases, 8700 changed lines)

| rule | TP | FP | FN | precision | recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| test-weakened | 0 | 14 | 0 | 0.00 | — | — |
| type-suppression | 38 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| config-tampering | 1 | 1 | 0 | 0.50 | 1.00 | 0.67 |
| stub-left | 5 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| phantom-import | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| swallowed-error | 1 | 0 | 0 | 1.00 | 1.00 | 1.00 |
| **all** | 46 | 15 | 0 | 0.75 | 1.00 | 0.86 |

False blocking flags per 1,000 changed lines: 0.57 · latency p50 10.2 ms, p95 95.4 ms

