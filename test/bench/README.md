# Model benchmark

`gocql-serialization-truth.json` lists 7 verified bugs (filed as scylladb/gocql #1225–#1231) in
`serialization/{duration,decimal,varint}` of gocql at commit bf2fcd6 (109KB of non-test Go code).
For each model, calibrate on exactly that code and score every round against the known bugs:

```sh
code-scan.js calibrate start --model claude-sonnet-5-5 --only serialization/duration/ --only serialization/decimal/ --only serialization/varint/
# run workflows/calibrate.js with the printed NEXT args (+ scanScript), then:
code-scan.js calibrate report --truth test/bench/gocql-serialization-truth.json
```

## Results (2026-11-23, gocql bf2fcd6, 107KB / 4,630 lines, default profile)

Each model calibrated on the same sample; numbers are at the chunk size its calibration chose.
Price is all-in list price: every token of every reviewer agent (preamble, claim/submit turns,
re-reads, idle lanes), excluding the calibration-only decide steps.

| model | chunk | known bugs found | quality (share of 20 distinct issues) | $/100KB | $/1k lines | calibration cost |
|---|---|---|---|---|---|---|
| Opus 5.5 | 20KB | 7/7 | 0.50 | $1.19 | $0.27 | $3.55 |
| Fable 5.2 | 90KB | 6/7 (7/7 at 20KB, $2.31/100KB) | 0.44 | $1.60 | $0.37 | $7.51 |
| Sonnet 5.5 | 20KB | 4/7 | 0.42 | $0.41 | $0.095 | $1.38 |
| Haiku 5.5 | 40KB | 2/7 | 0.22 | $0.04 | $0.009 | $0.14 (rounds failed: reviewers left files unsubmitted) |

One sample per size, so differences under ~0.15 in quality are within noise.
