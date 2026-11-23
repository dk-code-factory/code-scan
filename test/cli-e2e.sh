#!/usr/bin/env bash
# CLI regression: exercises every code-scan.js command against a throwaway repo, with a fake `gh`.
# No LLM involved: reviewer submissions are simulated. Usage: test/cli-e2e.sh [workdir]
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=${1:-$(mktemp -d)}
rm -rf "$W"; mkdir -p "$W/repo" "$W/bin"
export CODESCAN_HOME=$W/state PATH=$W/bin:$PATH FAKEGH_LOG=$W/gh.log FAKEGH_ISSUES=$W/issues.json
B() { node "$HERE/bin/code-scan.js" "$@"; }
FAILS=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1"; FAILS=$((FAILS+1)); }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
has()  { grep -q -- "$2" <<<"$1"; }

cat > "$W/bin/gh" <<'EOF'
#!/bin/bash
echo "gh $*" >> "$FAKEGH_LOG"
if [ "$1 $2" = "issue create" ]; then n=$(( $(cat "$FAKEGH_LOG.n" 2>/dev/null || echo 100) + 1 )); echo $n > "$FAKEGH_LOG.n"; echo "https://github.com/acme/toy/issues/$n"; exit 0; fi
if [ "$1 $2" = "issue list" ]; then cat "$FAKEGH_ISSUES" 2>/dev/null || echo '[]'; exit 0; fi
exit 1
EOF
chmod +x "$W/bin/gh"

cd "$W/repo" && git init -q -b main && git remote add origin https://github.com/acme/toy.git
mkdir -p src/net src/store vendor tests docs tools/gen
printf 'void f(char*b){ free(b); b[0]=1; }\n' > src/net/buf.c
printf 'struct buf;\n' > src/net/buf.h
printf 'def q(c,n):\n    return c.execute("select %%s" %% n)\n' > src/store/db.py
printf 'package s\nfunc G(m map[string]*int,k string) int { return *m[k] }\n' > src/store/kv.go
echo 'int v;' > vendor/v.c; echo 'def test(): pass' > tests/test_x.py; echo '# d' > docs/a.md
echo 'int g;' > tools/gen/out.c
python3 -c "print('\n'.join('int h%d(int a){return a+%d;}'%(i,i) for i in range(1500)))" > src/store/big.c
echo junk > src/untracked.c
git add -A ':!src/untracked.c' && git commit -qm init

# --- inventory / start
o=$(B start --chunk-kb 8)
has "$o" 'NEXT {' && ok start || bad start
st=$(B files)
has "$st" 'excluded	vendor/v.c' && has "$st" 'excluded	tests/test_x.py' && ! has "$st" untracked && ok classification || bad classification
big=$(B sql "select count(*) || ' ' || max(json_array_length(items_json)) from chunks where scan_id=1 and state='pending' and items_json like '%src/store/big.c%'" | tail -1)
[ "$big" = "1 1" ] && ! has "$(B sql "select items_json from chunks where scan_id=1" )" '"slice"' && ok whole-file-own-chunk || bad "whole-file-own-chunk: $big"
check "start refuses when open" bash -c "! node '$HERE/bin/code-scan.js' start"

# --- planner apply
echo '{"exclude":[{"glob":"tools/gen/","reason":"generated"}],"units":[{"name":"net","globs":["src/net/"],"priority":9,"hint":"bounds"}]}' > "$W/plan.json"
has "$(B apply-plan 1 --file "$W/plan.json")" 'chunks=' && ok apply-plan || bad apply-plan
echo '{"exclude":[{"glob":"nope/"}]}' > "$W/bad.json"
check "apply-plan rejects bad glob" bash -c "! node '$HERE/bin/code-scan.js' apply-plan 1 --file '$W/bad.json'"
has "$(B files --path tools/gen/)" 'plan: generated' && ok plan-exclude || bad plan-exclude
has "$(B claim 1)" 'SUBSYSTEM FOCUS' && ok claim-priority-unit || bad claim-priority-unit

# --- simulated dead worker then continue
B stop --now >/dev/null
[ "$(B claim 1)" = NONE ] && ok stop-blocks-claims || bad stop-blocks-claims
has "$(B continue)" '"workers":' && ok continue || bad continue

# --- drain with workers in parallel; planted findings for buf.c, db.py, kv.go
worker() {
  while true; do
    o=$(node "$HERE/bin/code-scan.js" claim 1); [ "$o" = NONE ] && break
    c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
    sed -n 's/^- \(src[^ ]*\)\( lines.*slice \([0-9]*\).*\)\{0,1\}$/\1 \3/p' <<<"$o" | while read -r p k; do
      case $p in
        src/net/buf.c) f='[{"line":1,"severity":"critical","category":"memory-safety","title":"use after free of b in f","confidence":0.9}]';;
        src/store/db.py) f='[{"line":2,"severity":"critical","category":"vulnerability","title":"SQL injection in q via n"},{"line":2,"severity":"high","category":"vulnerability","title":"SQL injection in q through n"}]';;
        src/store/kv.go) f='[{"line":2,"severity":"high","category":"panic","title":"nil pointer dereference in G for missing key"}]';;
        *) f='[]';;
      esac
      if [ -n "$k" ]; then node "$HERE/bin/code-scan.js" submit 1 "$c" --file "$p" --slice "$k" <<<"$f" >/dev/null || echo "SUBMITFAIL $p"
      else node "$HERE/bin/code-scan.js" submit 1 "$c" --file "$p" <<<"$f" >/dev/null || echo "SUBMITFAIL $p"; fi
    done
  done
}
res=$(for i in 1 2 3 4 5 6; do worker & done; wait)
has "$res" SUBMITFAIL && bad "parallel submit ($res)" || ok "parallel submit"
s=$(B status)
has "$s" '\[done\]' && has "$s" 'critical 2' && ok scan-done || bad "scan-done: $s"
has "$(B files --path src/store/big.c)" 'reviewed' && ok big-file-reviewed || bad big-file-reviewed
bc=$(B sql "select id from chunks where scan_id=1 and state='done' and items_json like '%src/net/buf.c%'" | tail -1)
v=$(B submit 1 "$bc" --file src/net/buf.c <<<'[{"severity":"bad"}]' 2>&1); rc=$?
[ $rc -ne 0 ] && has "$v" 'severity must be' && has "$v" 'title required' && ok "submit validation" || bad "submit validation: $v"

# --- query / show / sql / triage
[ "$(B query --format json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = 4 ] && ok query-json || bad query-json
has "$(B query --severity high+ --path src/store/ --sort -severity,path)" 'db.py' && ok query-filters || bad query-filters
B query --format csv --out "$W/f.csv" >/dev/null && [ "$(wc -l < "$W/f.csv")" -ge 5 ] && ok csv || bad csv
has "$(B show 1)" 'line: ' && ok show || bad show
check "sql read-only" bash -c "! node '$HERE/bin/code-scan.js' sql 'delete from findings'"
has "$(B sql 'select count(*) n from findings')" 4 && ok sql || bad sql
ids=$(B query --format json | python3 -c 'import json,sys; print(",".join(str(r["id"]) for r in json.load(sys.stdin) if r["path"]!="src/store/kv.go"))')
has "$(B triage "$ids" --set confirmed --note checked)" confirmed && ok triage || bad triage

# --- dupes
has "$(B dupes)" '1 duplicate group' && ok dupes || bad "dupes: $(B dupes)"
[ "$(B query --primary-only --triage all | head -1)" = '3 finding(s)' ] && ok primary-only || bad primary-only

# --- trackers: marker autolink, match, link, jira import
kv=$(B query --path src/store/kv.go --format json | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]; print(r["id"])')
cat > "$FAKEGH_ISSUES" <<'EOF'
[{"number":8,"title":"G panics with nil pointer dereference on missing key","state":"OPEN","url":"https://github.com/acme/toy/issues/8","body":"src/store/kv.go:2"}]
EOF
B report-config set target gh:acme/toy >/dev/null
has "$(B tracker-sync gh)" 'synced 1' && ok tracker-sync || bad tracker-sync
has "$(B match)" '1 strong' && ok match || bad match
B match export --out "$W/m.json" >/dev/null && grep -q '"key": "8"' "$W/m.json" && ok match-export || bad match-export
B link "$kv" gh:acme/toy 8 >/dev/null; has "$(B query --reported --triage all)" 'kv.go' && ok link || bad link
echo '[{"key":"PROJ-1","fields":{"summary":"x","status":{"name":"Open"},"description":"src/net/buf.c"}}]' | B tracker-import jira >/dev/null && \
  has "$(B sql "select key from tracker_issues where tracker='jira:PROJ'")" PROJ-1 && ok jira-import || bad jira-import

# --- report: render, file, idempotence, marker roundtrip
B report-config set labels code-scan >/dev/null
r=$(B render)
has "$r" '2 draft(s)' && ok render || bad "render: $r"
body=$(B drafts | sed -n 2p | cut -f5); grep -q 'github.com/acme/toy/blob/' "$body" && grep -q 'code-scan:fp=' "$body" && ok permalinks-marker || bad permalinks-marker
python3 - "$body" <<'PY' && ok permalink-own-paragraph || bad permalink-own-paragraph
import sys, re
lines = open(sys.argv[1]).read().split('\n')
idx = [i for i, l in enumerate(lines) if 'github.com/acme/toy/blob/' in l]
assert idx and all(lines[i].startswith('https://') and lines[i-1] == '' and lines[i+1] == '' for i in idx), lines
PY
has "$(B file-gh)" 'filed 2' && ok file-gh || bad file-gh
grep -q -- '--label code-scan' "$FAKEGH_LOG" && ok labels || bad labels
has "$(B render)" '0 draft' && ok no-refile || bad no-refile
[ "$(B query --unreported | head -1)" = 'no findings match' ] && ok all-reported || bad all-reported

# --- restart: only changed files, stale, plan reuse, fixed->reopen
B triage "$kv" --set fixed >/dev/null
echo '// c' >> src/store/kv.go && git commit -qam c
has "$(B query --stale --triage all)" kv.go && ok stale || bad stale
o=$(B restart --no-plan)
has "$o" 'to review: 1 files' && has "$o" 'reused plan' && ok restart-incremental || bad "restart-incremental: $o"
c=$(B claim 2 | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
B submit 2 "$c" --file src/store/kv.go <<<'[{"line":2,"severity":"high","category":"panic","title":"nil pointer dereference in G for missing key"}]' >/dev/null
has "$(B show "$kv")" 'triage=open' && ok reopen || bad reopen
has "$(B restart)" '"workers":0' && ok restart-noop || bad restart-noop
has "$(B status)" '\[done\]' && ok noop-done || bad noop-done
has "$(B restart --force --no-plan)" 'to review: 5 files' && ok force || bad force

# --- cross-scan dedup with reworded title + shifted line; gone marking
uaf=$(B query --path src/net/buf.c --format json --triage all | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
nsql=$(B query --path src/store/db.py --triage all | head -1)
printf '// header\n' | cat - src/net/buf.c > t && mv t src/net/buf.c; echo '# c' >> src/store/db.py; git commit -qam shift
B stop >/dev/null; B restart --no-plan >/dev/null
sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
while o=$(B claim "$sid"); [ "$o" != NONE ]; do
  c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
  for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$o"); do
    if [ "$p" = src/net/buf.c ]; then f='[{"line":2,"severity":"critical","category":"memory-safety","title":"f writes into b after free(b): use-after-free"}]'; else f='[]'; fi
    B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo "SUBMITFAIL $p"
  done
done
[ "$(B query --path src/net/buf.c --format json --triage all | python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r), r[0]["id"], r[0]["line"])')" = "1 $uaf 2" ] && ok dedup-reworded || bad "dedup-reworded: $(B query --path src/net/buf.c --triage all)"
[ "$(B query --path src/store/db.py --triage all | head -1)" = 'no findings match' ] && has "$(B query --path src/store/db.py --gone --triage all)" gone && ok gone || bad "gone: $(B query --path src/store/db.py --include-gone --triage all)"

# --- profiles
echo 'Only SQL injection.' > "$W/p.md"
B profile add sqli --file "$W/p.md" >/dev/null && has "$(B profile list)" sqli && ok profile-add || bad profile-add
B stop >/dev/null; has "$(B restart --profile sqli --no-plan)" 'profile=sqli' && ok profile-scan || bad profile-scan

# --- a stopped scan whose in-flight work completes becomes done
echo '// s' >> src/net/buf.h && git commit -qam s
B stop >/dev/null 2>&1; B restart --no-plan >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
claims=(); while o=$(B claim "$sid"); [ "$o" != NONE ]; do claims+=("$o"); done
B stop >/dev/null
for o in "${claims[@]}"; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
  sed -n 's/^- \(src[^ ]*\)\( lines.*slice \([0-9]*\).*\)\{0,1\}$/\1 \3/p' <<<"$o" | while read -r p k; do
    B submit "$sid" "$c" --file "$p" ${k:+--slice "$k"} <<<'[]' >/dev/null || echo "SUBMITFAIL $p"; done; done
has "$(B status --scan "$sid")" '\[done\]' && ok stopped-then-done || bad "stopped-then-done: $(B status --scan "$sid" | head -3)"

# --- repeated pattern across files, titles differ by symbol names -> one auto group
mkdir -p src/pat; for n in a b c; do printf 'int *mk_%s(int n){ int *p = malloc(n); for (int i = 0; i <= n; i++) p[i] = i; return p; }\n' $n > src/pat/$n.c; done
git add -A && git commit -qm pat; B stop >/dev/null 2>&1; B restart --no-plan >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
while o=$(B claim "$sid"); [ "$o" != NONE ]; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
  for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$o"); do n=$(basename "$p" .c)
    if [[ $p == src/pat/* ]]; then f="[{\"line\":1,\"severity\":\"high\",\"category\":\"memory-safety\",\"title\":\"Off-by-one heap overflow in mk_$n loop (i <= n)\"}]"; else f='[]'; fi
    B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo "SUBMITFAIL $p"; done; done
B dupes >/dev/null; has "$(B query --path src/pat/ --primary-only | head -1)" '1 finding' && ok dupes-pattern || bad "dupes-pattern: $(B dupes list)"

# --- calibration: simulated reviewers whose recall depends on chunk size
calrun() {  # $1=model, $2=awk-free capacity rule as bash arithmetic on $size
  local model=$1 rule=$2 o sid size i
  o=$(B calibrate start --model "$model" --sample-kb 40 --medium 16)
  for i in 1 2 3 4 5 6 7; do
    sid=$(sed -n 's/^NEXT .*"scanId":\([0-9]*\).*/\1/p' <<<"$o" | tail -1); [ -z "$sid" ] && break
    size=$(B sql "select options_json from scans where id=$sid" | tail -1 | python3 -c 'import json,sys;print(json.load(sys.stdin)["chunkKb"])')
    while c_o=$(B claim "$sid"); [ "$c_o" != NONE ]; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$c_o"); n=0
      for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$c_o"); do n=$((n+1)); cap=$(( rule ))
        if [ $n -le $cap ]; then f="[{\"line\":1,\"severity\":\"high\",\"category\":\"x\",\"title\":\"bug in $p\"}]"; else f='[]'; fi
        B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo SUBMITFAIL; done; done
    o=$(B calibrate next)
  done
  echo "$o" | tail -1
}
mkdir -p src/cal; for i in $(seq 1 24); do python3 -c "print('\n'.join('int c%d_$i(int a){return a+%d;}'%(k,k) for k in range(60)))" > src/cal/c$i.c; done
git add -A && git commit -qm cal
r=$(calrun grows 'size <= 24 ? 100 : 1'); has "$r" 'DONE chunk_kb=24' && ok calibrate-degrade || bad "calibrate-degrade: $r"
r=$(calrun shrinks 'size <= 8 ? 100 : 2'); has "$r" 'DONE chunk_kb=8' && ok calibrate-smaller || bad "calibrate-smaller: $r"
r=$(calrun flat '100'); has "$r" 'DONE chunk_kb=36' && ok calibrate-flat || bad "calibrate-flat: $r"
has "$(B status --all)" 'cal' && bad calibrate-hidden || ok calibrate-hidden
B stop >/dev/null 2>&1
has "$(B restart --model grows --no-plan)" 'chunk size: 24KB (calibrated for grows)' && ok calibrated-chunk || bad calibrated-chunk
has "$(B restart --model unknown-model --no-plan)" 'CALIBRATE' && ok calibrate-hint || bad calibrate-hint

# --- continue --model re-chunks a pending scan with a calibration finished after it was created
B stop >/dev/null 2>&1; o=$(B restart --model late-model --no-plan --force)
has "$o" 'CALIBRATE' && ok late-hint || bad late-hint
B calibrate set late-model 12 >/dev/null
o=$(B continue --model late-model); has "$o" 'chunk size: 12KB (calibrated for late-model)' && ok continue-rechunk || bad "continue-rechunk: $o"
sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
[ "$(B sql "select count(*) from chunks where scan_id=$sid and state='pending' and bytes > 12*1024 and json_array_length(items_json) > 1" | tail -1)" = 0 ] && ok rechunk-sizes || bad rechunk-sizes

has "$(B calibrate start --model tiny --sample-kb 40 --medium 64)" 'too small to calibrate' && ok calibrate-tiny || bad calibrate-tiny

B stop >/dev/null 2>&1; o=$(B restart --no-plan --force --only src/net/ --only src/pat/)
has "$o" 'to review: 5 files' && has "$(B files --path src/store/db.py)" 'out-of-scope' && ok only-scope || bad "only-scope: $o"
B apply-plan "$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')" --file <(echo '{"include":[{"glob":"src/store/","reason":"x"}]}') >/dev/null
has "$(B files --path src/store/db.py)" 'out-of-scope' && ok only-vs-planner || bad only-vs-planner

B stop >/dev/null 2>&1; B restart --no-plan --exclude src/net/ >/dev/null; B stop >/dev/null 2>&1
o=$(B restart --no-plan --force --only src/net/); has "$o" 'to review: 2 files' && ok restart-scope-replaces || bad "restart-scope-replaces: $o"
B stop >/dev/null 2>&1; o=$(B restart --no-plan --force --reset-scope); ! has "$o" 'out-of-scope' && ! has "$o" 'user-exclude' && ok reset-scope || bad "reset-scope: $o"

# --- inline claim + one batch submit for the whole chunk
B stop >/dev/null 2>&1; B restart --no-plan --force --only src/net/ --chunk-kb 40 >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
o=$(B claim --inline "$sid"); c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
has "$o" '=== src/net/buf.c' && grep -qP '^\s+1\t' <<<"$o" && ok claim-inline || bad "claim-inline: $o"
B stop >/dev/null 2>&1; B restart --no-plan --force --only src/store/big.c --chunk-kb 40 >/dev/null; sid2=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
o2=$(B claim --inline "$sid2"); has "$o2" 'in ONE turn' && has "$o2" "Read $W/repo/src/store/big.c offset=1001 limit=1000" && ok claim-large-lists-files || bad "claim-large-lists-files: $(head -c 400 <<<"$o2")"
B stop >/dev/null 2>&1; B restart --no-plan --force --only src/net/ --chunk-kb 40 >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
o=$(B claim --inline "$sid"); c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
v=$(B submit "$sid" "$c" <<<'{"src/nope.c": []}' 2>&1); has "$v" 'not in chunk' && ok batch-rejects-unknown || bad "batch-rejects-unknown: $v"
v=$(B submit "$sid" "$c" <<<'{"src/net/buf.c": [{"line":1,"severity":"high","category":"memory-safety","title":"batch finding"}], "src/net/buf.h": []}')
has "$(B status --scan "$sid")" '\[done\]' && has "$(B query --text 'batch finding' --triage all)" 'buf.c' && ok batch-submit || bad "batch-submit: $v"

# --- re-found bug with shifted range / different cited spot matches the existing finding
B stop >/dev/null 2>&1; B restart --no-plan --force --only src/net/ >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
c=$(B claim "$sid" | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
before=$(B sql "select count(*) from findings" | tail -1)
B submit "$sid" "$c" <<<'{"src/net/buf.c": [{"line":1,"end_line":3,"severity":"high","category":"memory-safety","title":"batch finding: buffer reused"}], "src/net/buf.h": []}' >/dev/null
after=$(B sql "select count(*) from findings" | tail -1)
[ "$before" = "$after" ] && ok refound-range-shift || bad "refound-range-shift: $before -> $after"

# --- limits: dollar cap from the scan's own agent transcripts, 5-hour cap from the status-line snapshot
export CLAUDE_CONFIG_DIR=$W/claude XDG_CACHE_HOME=$W/xdg
B stop >/dev/null 2>&1; B restart --no-plan --force --only src/pat/ --chunk-kb 1 --max-usd 1 >/dev/null; sid=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
has "$(B claim --inline "$sid")" '^CHUNK' && ok usd-under-limit || bad usd-under-limit
mkdir -p "$W/claude/projects/p/s/subagents/workflows/wf_x"
{ printf '{"type":"user","message":{"role":"user","content":"Run: CODESCAN_HOME=%s node x -C %s claim --inline %s"}}\n' "$CODESCAN_HOME" "$W/repo" "$sid"
  printf '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":60000}}}\n'
  printf '{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":60000}}}\n'
} > "$W/claude/projects/p/s/subagents/workflows/wf_x/agent-a.jsonl"
# another scan's agent must not count
printf '{"type":"user","message":{"content":"node x -C %s claim --inline 999"}}\n{"type":"assistant","message":{"id":"z","model":"claude-opus-5-5","usage":{"output_tokens":9000000}}}\n' "$W/repo" > "$W/claude/projects/p/s/subagents/workflows/wf_x/agent-b.jsonl"
has "$(B limits)" 'spend: \$1.20 of \$1 limit' && ok usd-from-transcripts || bad "usd-from-transcripts: $(B limits)"
o=$(B claim --inline "$sid"); has "$o" 'NONE (spend \$1.20 reached the \$1 limit)' && has "$(B status)" '\[stopped\]' && has "$(B status)" 'stopped by limit' && ok usd-stops || bad "usd-stops: $o"
B limits --max-usd 0 >/dev/null; has "$(B continue)" '"workers"' && has "$(B claim --inline "$sid")" '^CHUNK' && ok usd-limit-lifted || bad usd-limit-lifted
B limits --max-5h-pct 80 >/dev/null
o=$(B claim --inline "$sid"); has "$o" 'NONE (5-hour usage is unknown' && ok pct-unknown-stops || bad "pct-unknown-stops: $o"
RL=$(B statusline-path); mkdir -p "$(dirname "$RL")"; now=$(date +%s%3N)
echo "{\"ts\":$now,\"rate_limits\":{\"five_hour\":{\"used_percentage\":50,\"resets_at\":9999999999}}}" > "$RL"
B continue >/dev/null; has "$(B claim --inline "$sid")" '^CHUNK' && ok pct-under-limit || bad pct-under-limit
echo "{\"ts\":$now,\"rate_limits\":{\"five_hour\":{\"used_percentage\":85,\"resets_at\":9999999999}}}" > "$RL"
o=$(B claim --inline "$sid"); has "$o" 'NONE (5-hour subscription usage 85% reached the 80% limit' && ok pct-stops || bad "pct-stops: $o"
echo "{\"ts\":$((now-3600000)),\"rate_limits\":{\"five_hour\":{\"used_percentage\":10,\"resets_at\":9999999999}}}" > "$RL"
o=$(B continue 2>&1); has "$o" 'not resuming' && has "$o" 'unknown' && ok pct-stale-stops || bad "pct-stale-stops: $o"
echo "{\"ts\":$now,\"rate_limits\":{\"five_hour\":{\"used_percentage\":95,\"resets_at\":1000}}}" > "$RL"
B continue >/dev/null 2>&1; has "$(B claim --inline "$sid")" '^CHUNK' && ok pct-window-reset || bad pct-window-reset
o=$(echo '{"model":{"display_name":"M"},"rate_limits":{"five_hour":{"used_percentage":40,"resets_at":5},"seven_day":{"used_percentage":2}}}' | B statusline)
has "$o" '5h 40%' && has "$(cat "$RL")" '"used_percentage":40' && ok statusline-snapshot || bad "statusline-snapshot: $o"
has "$(echo '{}' | B statusline -- echo wrapped)" 'wrapped' && ok statusline-wraps || bad statusline-wraps
# review fixes: no crash without resets_at, bad values rejected, continue while crossed launches nothing
echo "{\"ts\":$(date +%s%3N),\"rate_limits\":{\"five_hour\":{\"used_percentage\":90}}}" > "$RL"
o=$(B continue 2>&1); has "$o" '5-hour subscription usage 90% reached the 80% limit' && ! has "$o" 'Invalid time' && ok pct-no-resets-at || bad "pct-no-resets-at: $o"
B limits --max-5h-pct 95 >/dev/null; B continue >/dev/null 2>&1; echo "{\"ts\":$(date +%s%3N),\"rate_limits\":{\"five_hour\":{\"used_percentage\":96}}}" > "$RL"
o=$(B claim --inline "$sid" 2>&1); has "$o" 'NONE (5-hour subscription usage 96% reached the 95% limit)' && ok claim-no-resets-at || bad "claim-no-resets-at: $o"
B limits --max-5h-pct 80 >/dev/null; echo "{\"ts\":$(date +%s%3N),\"rate_limits\":{\"five_hour\":{\"used_percentage\":90}}}" > "$RL"
o=$(B continue 2>&1); has "$o" 'not resuming' && has "$o" '"workers":0' && has "$(B status)" '\[stopped\]' && ok continue-while-crossed || bad "continue-while-crossed: $o"
o=$(B limits --max-usd abc 2>&1); has "$o" 'needs a number' && ok bad-limit-rejected || bad "bad-limit-rejected: $o"
o=$(B limits --max-usd '' 2>&1); has "$o" 'needs a number' && ok empty-limit-rejected || bad "empty-limit-rejected: $o"
has "$(echo '{"cost":{"total_cost_usd":null},"rate_limits":{"five_hour":{"used_percentage":1}}}' | B statusline)" '5h 1%' && ok statusline-null-cost || bad statusline-null-cost
# pricing: older models priced by id, fast mode from usage, transcript mentioning CODESCAN_HOME in code still counts
B limits --max-5h-pct 0 >/dev/null; B limits --max-usd 1000 >/dev/null
{ printf '{"type":"user","message":{"role":"user","content":"Run: CODESCAN_HOME=%s node x -C %s claim --inline %s"}}\n' "$CODESCAN_HOME" "$W/repo" "$sid"
  printf '{"type":"user","message":{"content":"code mentions CODESCAN_HOME=/elsewhere here"}}\n'
  printf '{"type":"assistant","message":{"id":"h1","model":"claude-haiku-4-5","usage":{"output_tokens":1000000}}}\n'
  printf '{"type":"assistant","message":{"id":"f1","model":"claude-opus-5-5","usage":{"output_tokens":100000,"speed":"fast"}}}\n'
  printf '{"type":"assistant","message":{"id":"u1","model":"claude-mythos-1","usage":{"output_tokens":100000}}}\n'
} > "$W/claude/projects/p/s/subagents/workflows/wf_x/agent-c.jsonl"
# 1.20 (agent-a) + haiku-4-5 1M out $5 + opus 5.5 fast 100k out $4 + unknown model at max row 100k out $5 = 15.20
has "$(B limits)" 'spend: \$15.20 of \$1000 limit' && ok pricing-by-id || bad "pricing-by-id: $(B limits)"
printf '{"type":"assistant","message":{"id":"h2","model":"claude-haiku-4-5","usage":{"output_tokens":200000}}}\n' >> "$W/claude/projects/p/s/subagents/workflows/wf_x/agent-c.jsonl"
has "$(B limits)" 'spend: \$16.20 of' && ok spend-incremental || bad "spend-incremental: $(B limits)"
# spend of one scan's agents is still counted after another scan looked at the same transcripts first
o_sid=$sid; B stop >/dev/null 2>&1; B restart --no-plan --force --only src/pat/ --chunk-kb 1 --max-usd 1000 >/dev/null; sid2=$(B status | sed -n 's/^scan \([0-9]*\).*/\1/p')
B limits --scan "$sid2" >/dev/null   # the new scan scans the transcripts first: none are its own
{ printf '{"type":"user","message":{"role":"user","content":"Run: CODESCAN_HOME=%s node x -C %s claim --inline %s"}}\n' "$CODESCAN_HOME" "$W/repo" "$sid2"
  printf '{"type":"assistant","message":{"id":"n1","model":"claude-opus-5-5","usage":{"output_tokens":50000}}}\n'
} > "$W/claude/projects/p/s/subagents/workflows/wf_x/agent-d.jsonl"
first=$(B limits --scan "$o_sid"); has "$first" 'spend: \$16.20 of' && has "$(B limits --scan "$sid2")" 'spend: \$1.00 of' && ok spend-owner-per-scan || bad "spend-owner-per-scan: $(B limits --scan "$sid2") / $(B limits --scan "$o_sid")"
unset CLAUDE_CONFIG_DIR XDG_CACHE_HOME

# --- calibration whose reviewers never run stops instead of looping
B calibrate start --model ghost --sample-kb 40 --medium 16 >/dev/null
r=""; for i in 1 2 3 4 5 6; do r=$(B calibrate next | tail -1); has "$r" '^DONE' && break; done
has "$r" 'calibration failed' && has "$(B calibrate status)" 'ghost \[failed\]' && ok calibrate-gives-up || bad "calibrate-gives-up: $r"

# --- init: two simulated models of different quality on one sample; user picks; scans use it
o=$(B init start --models good-model,weak-model --sample-kb 40 --medium 16)
has "$o" 'init 1: 2 model(s)' && ok init-start || bad "init-start: $o"
for cal in $(B sql "select id from calibrations where init_id=1 order by id" | tail -n +2); do
  model=$(B sql "select model from calibrations where id=$cal" | tail -1)
  for i in 1 2 3 4 5 6 7; do
    sid=$(B sql "select max(id) from scans where kind='cal' and cal_id=$cal and status='active'" | tail -1); [ -z "$sid" ] && break
    while c_o=$(B claim "$sid"); [ "$c_o" != NONE ]; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$c_o"); n=0
      for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$c_o"); do n=$((n+1))
        cap=$([ "$model" = good-model ] && echo 100 || echo 1)
        if [ $n -le $cap ]; then f="[{\"line\":1,\"severity\":\"high\",\"category\":\"x\",\"title\":\"bug in $p\"}]"; else f='[]'; fi
        B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo SUBMITFAIL; done; done
    r=$(B calibrate next "$cal" | tail -1); has "$r" '^DONE' && break
  done
done
r=$(B init report)
has "$r" 'good-model' && has "$r" '\$/1kLOC' && [ "$(sed -n 3p <<<"$r" | cut -f1)" = good-model ] && ok init-report || bad "init-report: $r"
has "$(B init pick good-model)" 'default reviewer model: good-model' && ok init-pick || bad init-pick
o=$(B start --new --no-plan --force)
has "$o" 'calibrated for good-model' && ! has "$o" '^INIT' && ok init-default-used || bad "init-default-used: $o"
B sql "delete from config where key='default_model'" >/dev/null 2>&1 || node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.CODESCAN_HOME+'/codescan.db').exec(\"delete from config where key='default_model'\")"
has "$(B start --new --no-plan --force)" '^INIT' && ok init-hint || bad init-hint

echo "---"; [ $FAILS = 0 ] && echo "ALL PASS" || echo "$FAILS FAILED"; exit $FAILS
