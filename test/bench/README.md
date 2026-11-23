# Model benchmark

`gocql-serialization-truth.json` lists 7 verified bugs (filed as scylladb/gocql #1225–#1231) in
`serialization/{duration,decimal,varint}` of gocql at commit bf2fcd6 (109KB of non-test Go code).
For each model, calibrate on exactly that code and score every round against the known bugs:

```sh
code-scan.js calibrate start --model claude-sonnet-5-5 --only serialization/duration/ --only serialization/decimal/ --only serialization/varint/
# run workflows/calibrate.js with the printed NEXT args (+ scanScript), then:
code-scan.js calibrate report --truth test/bench/gocql-serialization-truth.json
```
