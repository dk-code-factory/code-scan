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
# scans run registered review profiles; `fresh` closes every open scan before switching profiles
P()     { B profile register "$@" >/dev/null || echo "REGFAIL $*"; }
fresh() { B stop --all --close >/dev/null 2>&1; }
sidof() { B status | sed -n 's/^scan \([0-9]*\).*/\1/p'; }

cat > "$W/bin/gh" <<'EOF'
#!/bin/bash
echo "gh $*" >> "$FAKEGH_LOG"
if [ "$1" = api ]; then [ -f "$FAKEGH_LOG.noapi" ] && { echo "error connecting to api.github.com" >&2; exit 1; }; echo acme/toy; exit 0; fi
if [ "$1 $2" = "issue create" ]; then n=$(( $(cat "$FAKEGH_LOG.n" 2>/dev/null || echo 100) + 1 )); echo $n > "$FAKEGH_LOG.n"; echo "https://github.com/acme/toy/issues/$n"; exit 0; fi
if [ "$1 $2" = "issue list" ]; then cat "$FAKEGH_ISSUES" 2>/dev/null || echo '[]'; exit 0; fi
if [ "$1 $2" = "issue view" ] && [ -f "$FAKEGH_LOG.pr.$3" ]; then echo "GraphQL: Could not resolve to an issue" >&2; exit 1; fi
if [ "$1 $2" = "pr view" ]; then cat "$FAKEGH_LOG.pr.$3"; exit 0; fi
if [ "$1 $2" = "issue view" ]; then f="$FAKEGH_LOG.view.$3"; [ -f "$f" ] && cat "$f" || echo '{"state":"OPEN","stateReason":"","url":"u"}'; exit 0; fi
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

# --- inventory / start (a scan needs a registered review profile)
has "$(B start)" '^INIT' && ok start-needs-profile || bad start-needs-profile
has "$(B start --chunk-kb 8 2>&1)" 'part of a review profile' && ok start-rejects-spec-flags || bad start-rejects-spec-flags
P base --prompt default --model opus --chunk-kb 8
P np --prompt default --model opus --chunk-kb 8 --no-plan
o=$(B start)
has "$o" 'NEXT {' && has "$o" 'profile=base@1' && ok start || bad "start: $o"
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

# --- continue must not re-queue a chunk an in-flight reviewer still holds after a plain stop
B stop >/dev/null
o=$(B continue 2>&1); has "$o" 'still claimed by in-flight reviewers' && ok continue-waits-for-inflight || bad "continue-waits-for-inflight: $o"

# --- simulated dead worker then continue
B stop --now >/dev/null
[ "$(B claim 1)" = NONE ] && ok stop-blocks-claims || bad stop-blocks-claims
has "$(B continue)" '"workers":' && ok continue || bad continue

# --- drain with workers in parallel; planted findings for buf.c, db.py, kv.go
worker() {
  while true; do
    o=$(node "$HERE/bin/code-scan.js" claim 1); [ "$o" = NONE ] && break
    c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
    sed -n 's/^- \([^ ]*\)\( lines.*slice \([0-9]*\).*\)\{0,1\}$/\1 \3/p' <<<"$o" | while read -r p k; do
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
# --- confirmation (independent of triage)
[ "$(B query --confirmation unchecked | head -1)" = '4 finding(s)' ] && ok confirm-default || bad confirm-default
has "$(B confirm 1 --set confirmed --note repro)" 'confirmation confirmed' && ok confirm || bad confirm
B confirm 2 --set not_confirmed --note 'could not reproduce' >/dev/null
has "$(B show 1)" 'confirmation=confirmed' && has "$(B show 2)" 'could not reproduce' && ok confirm-show || bad confirm-show
[ "$(B query --confirmation confirmed --format json | python3 -c 'import json,sys; print([r["id"] for r in json.load(sys.stdin)])')" = '[1]' ] && ok confirm-filter || bad confirm-filter
[ "$(B query --confirmation not_confirmed,unchecked | head -1)" = '3 finding(s)' ] && ok confirm-filter-multi || bad confirm-filter-multi
check "confirm bad state" bash -c "! node '$HERE/bin/code-scan.js' confirm 1 --set maybe"
sev1=$(B query --ids 1 --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["severity"])')
has "$(B confirm 1 --set confirmed --set-severity low)" 'severity: #1' && has "$(B show 1)" '→ low' && ok confirm-severity || bad confirm-severity
check "confirm bad severity" bash -c "! node '$HERE/bin/code-scan.js' confirm 1 --set confirmed --set-severity huge"
B confirm 1 --set confirmed --set-severity "$sev1" >/dev/null
B confirm 2 --set unchecked >/dev/null; [ "$(B query --confirmation unchecked | head -1)" = '3 finding(s)' ] && ok confirm-reset || bad confirm-reset

# --- dupes
has "$(B dupes)" '1 duplicate group' && ok dupes || bad "dupes: $(B dupes)"
[ "$(B query --primary-only --triage all | head -1)" = '3 finding(s)' ] && ok primary-only || bad primary-only
# merging one member of a 2-member group away must not leave a 1-member group behind (on a copy of the store)
rm -rf "$W/state-dm"; cp -r "$W/state" "$W/state-dm"
DM() { CODESCAN_HOME=$W/state-dm B "$@"; }
gm=$(DM sql "select finding_id from dupe_groups order by finding_id limit 1" | tail -1)
nx=$(DM sql "select id from findings where id not in (select finding_id from dupe_groups) order by id limit 1" | tail -1)
DM dupes merge "$gm" "$nx" >/dev/null
[ "$(DM sql "select count(*) from (select group_id from dupe_groups group by group_id having count(*) < 2 or sum(is_primary) <> 1)" | tail -1)" = 0 ] \
  && ok dupes-merge-cleans-old-group || bad "dupes-merge-cleans-old-group: $(DM sql 'select * from dupe_groups')"
# triage --set duplicate --of: state, note, shared group; --of needs duplicate; not listed by default (on the copy)
DM triage "$nx" --set duplicate --of "$gm" --note "same root cause" >/dev/null
o=$(DM show "$nx"); has "$o" 'triage=duplicate' && has "$o" "duplicate of #$gm: same root cause" \
  && [ "$(DM sql "select count(distinct group_id) from dupe_groups where finding_id in ($gm,$nx)" | tail -1)" = 1 ] \
  && ! grep -q "^ *$nx\b" <<<"$(DM query --format csv | cut -d, -f1)" && ok triage-duplicate || bad "triage-duplicate: $o"
has "$(DM triage "$nx" --set wontfix --of "$gm" 2>&1)" '--of goes with --set duplicate' && has "$(DM triage "$nx" --set duplicate --of "$nx" 2>&1)" 'is one of the findings' \
  && ok triage-duplicate-usage || bad triage-duplicate-usage

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
git -C "$W/repo" remote set-url origin https://github.com/acme/toy.js.git   # dotted repo name
r=$(B render)
has "$r" 'HELD 3 finding(s): no successful duplicate search in gh:acme/toy' && has "$r" '0 draft' && ok render-holds-unsearched || bad "render-holds-unsearched: $r"
r=$(B render --allow-unsearched)
git -C "$W/repo" remote set-url origin https://github.com/acme/toy.git
has "$r" '2 draft(s)' && ok render || bad "render: $r"
body=$(B drafts | sed -n 2p | cut -f5); grep -q 'github.com/acme/toy.js/blob/' "$body" && grep -q 'code-scan:fp=' "$body" && ok permalinks-marker || bad permalinks-marker
python3 - "$body" <<'PY' && ok permalink-own-paragraph || bad permalink-own-paragraph
import sys, re
lines = open(sys.argv[1]).read().split('\n')
idx = [i for i, l in enumerate(lines) if 'github.com/acme/toy.js/blob/' in l]
assert idx and all(lines[i].startswith('https://') and lines[i-1] == '' and lines[i+1] == '' for i in idx), lines
PY
has "$(B file-gh)" 'filed 2' && ok file-gh || bad file-gh
grep -q -- '--label code-scan' "$FAKEGH_LOG" && ok labels || bad labels
has "$(B render --allow-unsearched)" '0 draft' && ok no-refile || bad no-refile
[ "$(B query --unreported | head -1)" = 'no findings match' ] && ok all-reported || bad all-reported

# --- restart: only changed files, stale, plan reuse, fixed->reopen
B triage "$kv" --set fixed >/dev/null
echo '// c' >> src/store/kv.go && git commit -qam c
has "$(B query --stale --triage all)" kv.go && ok stale || bad stale
o=$(B restart)
has "$o" 'to review: 1 files' && has "$o" 'reused plan' && ok restart-incremental || bad "restart-incremental: $o"
c=$(B claim 2 | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
B submit 2 "$c" --file src/store/kv.go <<<'[{"line":2,"severity":"high","category":"panic","title":"nil pointer dereference in G for missing key"}]' >/dev/null
has "$(B show "$kv")" 'triage=open' && ok reopen || bad reopen
has "$(B restart)" '"workers":0' && ok restart-noop || bad restart-noop
has "$(B status)" '\[done\]' && ok noop-done || bad noop-done
has "$(B restart --force)" 'to review: 5 files' && ok force || bad force

# --- cross-scan dedup with reworded title + shifted line; gone marking
uaf=$(B query --path src/net/buf.c --format json --triage all | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
nsql=$(B query --path src/store/db.py --triage all | head -1)
printf '// header\n' | cat - src/net/buf.c > t && mv t src/net/buf.c; echo '# c' >> src/store/db.py; git commit -qam shift
B stop >/dev/null; B restart >/dev/null
sid=$(sidof)
while o=$(B claim "$sid"); [ "$o" != NONE ]; do
  c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
  for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$o"); do
    if [ "$p" = src/net/buf.c ]; then f='[{"line":2,"severity":"critical","category":"memory-safety","title":"f writes into b after free(b): use-after-free"}]'; else f='[]'; fi
    B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo "SUBMITFAIL $p"
  done
done
[ "$(B query --path src/net/buf.c --format json --triage all | python3 -c 'import json,sys; r=json.load(sys.stdin); print(len(r), r[0]["id"], r[0]["line"])')" = "1 $uaf 2" ] && ok dedup-reworded || bad "dedup-reworded: $(B query --path src/net/buf.c --triage all)"
[ "$(B query --path src/store/db.py --triage all | head -1)" = 'no findings match' ] && has "$(B query --path src/store/db.py --gone --triage all)" gone && ok gone || bad "gone: $(B query --path src/store/db.py --include-gone --triage all)"

# --- prompts and profiles
echo 'Only SQL injection.' > "$W/p.md"
B prompt add sqli --file "$W/p.md" >/dev/null && has "$(B prompt list)" sqli && ok prompt-add || bad prompt-add
has "$(B profile add x --file "$W/p.md" 2>&1)" 'prompt add' && ok profile-add-moved || bad profile-add-moved
P sqli --prompt sqli --model opus --no-plan
fresh; has "$(B restart --profile sqli)" 'profile=sqli@1' && ok profile-scan || bad profile-scan

# --- a stopped scan whose in-flight work completes becomes done
echo '// s' >> src/net/buf.h && git commit -qam s
B stop >/dev/null 2>&1; B restart >/dev/null; sid=$(sidof)
claims=(); while o=$(B claim "$sid"); [ "$o" != NONE ]; do claims+=("$o"); done
B stop >/dev/null
for o in "${claims[@]}"; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
  sed -n 's/^- \([^ ]*\)\( lines.*slice \([0-9]*\).*\)\{0,1\}$/\1 \3/p' <<<"$o" | while read -r p k; do
    B submit "$sid" "$c" --file "$p" ${k:+--slice "$k"} <<<'[]' >/dev/null || echo "SUBMITFAIL $p"; done; done
has "$(B status --scan "$sid")" '\[done\]' && ok stopped-then-done || bad "stopped-then-done: $(B status --scan "$sid" | head -3)"

# --- repeated pattern across files, titles differ by symbol names -> one auto group
mkdir -p src/pat; for n in a b c; do printf 'int *mk_%s(int n){ int *p = malloc(n); for (int i = 0; i <= n; i++) p[i] = i; return p; }\n' $n > src/pat/$n.c; done
git add -A && git commit -qm pat; B stop >/dev/null 2>&1; B restart >/dev/null; sid=$(sidof)
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
has "$(B profile register grows --prompt default --model grows --no-plan)" 'chunk 24KB (calibrated)' && ok calibrated-chunk || bad calibrated-chunk
has "$(B profile register unk --prompt default --model unknown-model --no-plan)" 'no chunk-size calibration' && ok calibrate-hint || bad calibrate-hint

# --- a calibration finished later goes into a new profile version; scans of the old version keep theirs
has "$(B continue --model late-model 2>&1)" 'part of a review profile' && ok continue-rejects-model || bad continue-rejects-model
B calibrate set late-model 12 >/dev/null
o=$(B profile register late --prompt default --model late-model --no-plan); has "$o" 'chunk 12KB (calibrated)' && ok register-uses-calibration || bad "register-uses-calibration: $o"
fresh; o=$(B restart --profile late --force); has "$o" 'chunk size: 12KB' && ok restart-new-profile || bad "restart-new-profile: $o"
sid=$(sidof)
[ "$(B sql "select count(*) from chunks where scan_id=$sid and state='pending' and bytes > 12*1024 and json_array_length(items_json) > 1" | tail -1)" = 0 ] && ok rechunk-sizes || bad rechunk-sizes

B calibrate set late-model 20 >/dev/null
o=$(B profile register late --prompt default --model late-model --no-plan); has "$o" 'registered late@2' && has "$o" 'changed from late@1: chunk size' && ok profile-version-bump || bad "profile-version-bump: $o"
has "$(B scans show "$sid")" 'late@1' && ok old-scan-keeps-version || bad old-scan-keeps-version
has "$(B calibrate start --model tiny --sample-kb 40 --medium 64)" 'too small to calibrate' && ok calibrate-tiny || bad calibrate-tiny

P netpat --prompt default --model opus --no-plan --only src/net/ --only src/pat/
fresh; o=$(B restart --profile netpat --force)
has "$o" 'to review: 5 files' && has "$(B files --path src/store/db.py)" 'out-of-scope' && ok only-scope || bad "only-scope: $o"
B apply-plan "$(sidof)" --file <(echo '{"include":[{"glob":"src/store/","reason":"x"}]}') >/dev/null
has "$(B files --path src/store/db.py)" 'out-of-scope' && ok only-vs-planner || bad only-vs-planner

has "$(B restart --only src/net/ 2>&1)" 'part of a review profile' && ok restart-rejects-scope || bad restart-rejects-scope
P braces --prompt default --model opus --no-plan --only 'src/{net,pat}/**'
fresh; o=$(B restart --profile braces --force)
has "$o" 'to review: 5 files' && ok only-brace-glob || bad "only-brace-glob: $o"

# --- inline claim + one batch submit for the whole chunk
P net40 --prompt default --model opus --no-plan --only src/net/ --chunk-kb 40
P big40 --prompt default --model opus --no-plan --only src/store/big.c --chunk-kb 40
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
o=$(B claim --inline "$sid"); c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
has "$o" '=== src/net/buf.c' && grep -qP '^\s+1\t' <<<"$o" && ok claim-inline || bad "claim-inline: $o"
fresh; B restart --profile big40 --force >/dev/null; sid2=$(sidof)
o2=$(B claim --inline "$sid2"); has "$o2" 'in ONE turn' && has "$o2" "Read $W/repo/src/store/big.c offset=1001 limit=1000" && ok claim-large-lists-files || bad "claim-large-lists-files: $(head -c 400 <<<"$o2")"
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
o=$(B claim --inline "$sid"); c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
v=$(B submit "$sid" "$c" <<<'{"src/nope.c": []}' 2>&1); has "$v" 'not in chunk' && ok batch-rejects-unknown || bad "batch-rejects-unknown: $v"
# a later file rejected: nothing of the batch is recorded (all or nothing)
v=$(B submit "$sid" "$c" <<<'{"src/net/buf.c": [{"line":1,"severity":"high","type":"leak","category":"memory-safety","title":"atomic probe"}], "src/net/buf.h": [{"line":1,"severity":"bogus","category":"x","title":"y"}]}' 2>&1)
[ "$(B sql "select count(*) from findings where title='atomic probe'" | tail -1)" = 0 ] && [ "$(B sql "select state from files where scan_id=$sid and path='src/net/buf.c'" | tail -1)" != reviewed ] \
  && ok batch-submit-atomic || bad "batch-submit-atomic: $v"
v=$(B submit "$sid" "$c" <<<'{"src/net/buf.c": [{"line":1,"severity":"high","type":"leak","category":"memory-safety","title":"batch finding"}], "src/net/buf.h": []}')
has "$(B status --scan "$sid")" '\[done\]' && has "$(B query --text 'batch finding' --triage all)" 'buf.c' && ok batch-submit || bad "batch-submit: $v"
has "$(B query --type leak --triage all)" 'batch finding' && ok type-explicit || bad type-explicit
has "$o" 'type: exactly one of' && has "$o" '"type":"<type>"' && ok type-in-claim || bad type-in-claim

# --- re-found bug with shifted range / different cited spot matches the existing finding
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
c=$(B claim "$sid" | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
before=$(B sql "select count(*) from findings" | tail -1)
B submit "$sid" "$c" <<<'{"src/net/buf.c": [{"line":1,"end_line":3,"severity":"high","category":"memory-safety","title":"batch finding: buffer reused"}], "src/net/buf.h": []}' >/dev/null
after=$(B sql "select count(*) from findings" | tail -1)
[ "$before" = "$after" ] && ok refound-range-shift || bad "refound-range-shift: $before -> $after"

# --- limits: dollar cap from the scan's own agent transcripts, 5-hour cap from the status-line snapshot
export CLAUDE_CONFIG_DIR=$W/claude XDG_CACHE_HOME=$W/xdg
P pat1 --prompt default --model opus --no-plan --only src/pat/ --chunk-kb 1
fresh; B restart --profile pat1 --force --max-usd 1 >/dev/null; sid=$(sidof)
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
o_sid=$sid; B stop >/dev/null 2>&1; B restart --force --max-usd 1000 >/dev/null; sid2=$(sidof)
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

# --- init: simulated candidates (model + effort) on two batches; `init next` drives the staged search
# initsim <initId> <rule fn>: review every round `init next` asks for; the rule gets model effort size batch n (file # in chunk) → 1 reports the file's bug
initsim() {
  local id=$1 rule=$2 sids sid meta model effort size batch c_o c n p f i
  sids=$(B sql "select id from scans where kind='cal' and status='active' and cal_id in (select id from calibrations where init_id=$id)" | tail -n +2)
  for i in $(seq 1 14); do
    for sid in $sids; do
      meta=$(B sql "select c.model||' '||coalesce(c.effort,'-')||' '||json_extract(s.options_json,'$.chunkKb')||' '||json_extract(s.options_json,'$.batch') from scans s join calibrations c on c.id=s.cal_id where s.id=$sid" | tail -1)
      read -r model effort size batch <<<"$meta"
      while c_o=$(B claim "$sid"); [ "$c_o" != NONE ]; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$c_o"); n=0
        for p in $(sed -n 's/^- \(src[^ ]*\)$/\1/p' <<<"$c_o"); do n=$((n+1))
          if [ "$($rule "$model" "$effort" "$size" "$batch" "$n")" = 1 ]; then f="[{\"line\":1,\"severity\":\"high\",\"category\":\"x\",\"title\":\"bug in $p\"}]"; else f='[]'; fi
          B submit "$sid" "$c" --file "$p" <<<"$f" >/dev/null || echo SUBMITFAIL; done; done
    done
    INITOUT=$(B init next "$id"); has "$INITOUT" '^DONE' && return
    sids=$(tail -1 <<<"$INITOUT" | python3 -c 'import json,sys;l=sys.stdin.read();print(" ".join(str(r["scanId"]) for r in json.loads(l[5:])["rounds"]))')
  done
}
goodweak() { if [ "$1" = good-model ]; then echo 1; else [ "$5" -le 1 ] && echo 1 || echo 0; fi; }
o=$(B init start --models good-model,weak-model --efforts high --sample-kb 40 --medium 16)
has "$o" 'init 1: 2 model(s), 2 candidate(s)' && has "$o" 'sample: A 1 biggest file' && has "$o" 'small file(s) 40KB in src/cal' && ok init-start || bad "init-start: $o"
initsim 1 goodweak
has "$INITOUT" '^DONE init 1' && has "$INITOUT" 'weak-model high pruned' && ok init-prune || bad "init-prune: $INITOUT"
r=$(B init report)
has "$r" 'good-model' && has "$r" '\$/1kLOC' && has "$r" 'qA' && [ "$(sed -n 3p <<<"$r" | cut -f1,2)" = "good-model	high" ] && ok init-report || bad "init-report: $r"
o=$(B init pick good-model); has "$o" 'default reviewer model: good-model effort high' && has "$o" 'review profile default@1' && ok init-pick || bad "init-pick: $o"
fresh; o=$(B start --force)
has "$o" 'profile=default@1' && has "$o" 'model good-model' && ! has "$o" '^INIT' && ok init-default-used || bad "init-default-used: $o"
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.CODESCAN_HOME+'/codescan.db').exec(\"delete from config where key='default_profile'\")"
has "$(B start --new --force)" '^INIT' && ok init-hint || bad init-hint

# --- review fixes for init
has "$(B init report 99 2>&1)" 'no init 99' && ok init-report-bad-id || bad init-report-bad-id
B calibrate set sonnet 24 >/dev/null; has "$(B sql "select value from config where key='chunk_kb:claude-sonnet-5-5'")" 24 && ok calibrate-set-normalizes || bad calibrate-set-normalizes
B init pick good-model >/dev/null; B init pick weak-model >/dev/null; fresh; o=$(B restart --profile default --force)
has "$o" 'profile=default@2' && has "$o" 'model weak-model' && ok restart-honours-pick || bad "restart-honours-pick: $o"
has "$o" '"model":"weak-model"' && ok model-id-passthrough || bad "model-id-passthrough: $o"
P son --prompt default --model sonnet --no-plan
fresh; o=$(B start --profile son --force); has "$o" '"model":"sonnet"' && has "$o" 'chunk size: 24KB' && ok model-alias-current || bad "model-alias-current: $o"
sid=$(sidof); o=$(B claim --inline --rules "$sid"); has "$o" '== REVIEWER INSTRUCTIONS ==' && has "$o" 'Submit once' && ok claim-rules || bad "claim-rules: $(head -c 300 <<<"$o")"
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.CODESCAN_HOME+'/codescan.db').exec(\"update calibrations set status='failed', result_kb=null where model='weak-model'\")"
has "$(B init pick weak-model)" 'default reviewer model: weak-model' && ok pick-unfinished-calibration || bad pick-unfinished-calibration

o=$(B start --new --profile son --force --concurrency 4); has "$o" '"lanes":4' && ok concurrency-flag || bad "concurrency-flag: $o"
has "$(B start --new --profile son --force --concurrency 40 2>&1)" 'whole number 1-32' && has "$(B status)" '\[active\]' && ok concurrency-validated || bad concurrency-validated

# --- dismissed findings are shown to reviewers of the same files
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
fid=$(B query --path src/net/buf.c --triage all --include-gone --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
B triage "$fid" --set false_positive --note "guarded by caller (test)" >/dev/null
o=$(B claim --inline "$sid"); has "$o" 'ALREADY DISMISSED' && has "$o" 'guarded by caller (test)' && ok dismissed-shown || bad "dismissed-shown: $(head -c 600 <<<"$o")"

o=$(B verify-prompt "$fid" --repo acme/toy --base 0123456789abcdef0123456789abcdef01234567 --worktree /tmp/wt-x)
has "$o" 'https://github.com/acme/toy/blob/0123456789abcdef0123456789abcdef01234567/' && has "$o" "triage $fid --set false_positive" && has "$o" '/tmp/wt-x' && ok verify-prompt || bad "verify-prompt: $(head -c 300 <<<"$o")"
has "$(B verify-prompt "$fid" 2>&1)" 'usage: verify-prompt' && ok verify-prompt-usage || bad verify-prompt-usage

# --- issues-sync: GitHub issue state flows back into findings
B link "$fid" gh:acme/toy 501 --kind filed --url https://github.com/acme/toy/issues/501 >/dev/null; B triage "$fid" --set confirmed >/dev/null
echo '{"state":"CLOSED","stateReason":"COMPLETED","url":"https://github.com/acme/toy/issues/501"}' > "$FAKEGH_LOG.view.501"
o=$(B issues-sync --tracker gh:acme/toy); has "$o" 'marked fixed 1' && has "$(B show "$fid")" 'triage=fixed' && has "$(B show "$fid")" 'issue closed (completed)' && ok issues-sync-fixed || bad "issues-sync-fixed: $o / $(B show "$fid" | head -3)"
B triage "$fid" --set confirmed >/dev/null; echo '{"state":"CLOSED","stateReason":"NOT_PLANNED"}' > "$FAKEGH_LOG.view.501"
B issues-sync --tracker gh:acme/toy >/dev/null; has "$(B show "$fid")" 'triage=wontfix' && ok issues-sync-wontfix || bad issues-sync-wontfix

# --- review fixes: duplicate close leaves finding, reopen restores, PR merged = fixed, prompt quoting, usage, caps
B triage "$fid" --set confirmed >/dev/null; echo '{"state":"CLOSED","stateReason":"DUPLICATE"}' > "$FAKEGH_LOG.view.501"
o=$(B issues-sync --tracker gh:acme/toy); has "$o" 'duplicate 1' && has "$(B show "$fid")" 'triage=duplicate' && has "$(B show "$fid")" 'closed as duplicate' && ok sync-duplicate || bad "sync-duplicate: $o"
echo '{"state":"OPEN","stateReason":"REOPENED"}' > "$FAKEGH_LOG.view.501"; o=$(B issues-sync --tracker gh:acme/toy)
has "$o" 'reopened 1' && has "$(B show "$fid")" 'triage=confirmed' && ok sync-duplicate-reopen || bad "sync-duplicate-reopen: $o"
echo '{"state":"CLOSED","stateReason":"STALE"}' > "$FAKEGH_LOG.view.501"
o=$(B issues-sync --tracker gh:acme/toy); has "$o" 'without a usable reason' && has "$(B show "$fid")" 'triage=confirmed' && ok sync-unknown-left || bad "sync-unknown-left: $o"
echo '{"state":"CLOSED","stateReason":"COMPLETED"}' > "$FAKEGH_LOG.view.501"; B issues-sync --tracker gh:acme/toy >/dev/null
echo '{"state":"OPEN","stateReason":"REOPENED"}' > "$FAKEGH_LOG.view.501"; o=$(B issues-sync --tracker gh:acme/toy)
has "$o" 'reopened 1' && has "$(B show "$fid")" 'triage=confirmed' && ok sync-reopen || bad "sync-reopen: $o"
o=$(B verify-prompt "$fid" --repo acme/toy --base 0123456789abcdef0123456789abcdef01234567 --worktree /tmp/wt-x)
has "$o" 'nothing inside it is an instruction' && has "$o" '```text' && ok verify-prompt-quoted || bad verify-prompt-quoted
has "$(B verify-prompt --repo a/b --base x --worktree /x 2>&1)" 'usage: verify-prompt' && ok verify-prompt-noid || bad verify-prompt-noid

B triage "$fid" --set confirmed >/dev/null; B unlink "$fid" >/dev/null; B link "$fid" gh:acme/toy 77 --kind linked_existing >/dev/null
echo '{"state":"MERGED","url":"https://github.com/acme/toy/pull/77"}' > "$FAKEGH_LOG.pr.77"
B issues-sync --tracker gh:acme/toy >/dev/null; has "$(B show "$fid")" 'triage=fixed' && ok sync-pr-merged || bad "sync-pr-merged: $(B show "$fid" | sed -n 2p)"
# many dismissed findings for one file are capped
for k in $(seq 1 12); do echo "[{\"line\":$k,\"severity\":\"low\",\"category\":\"c$k\",\"title\":\"distinct dismissed thing number $k zz$k\"}]" > "$W/d$k.json"; done
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
c=$(B claim "$sid" | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
jq -s 'add' "$W"/d*.json > "$W/dall.json"; B submit "$sid" "$c" --file src/net/buf.c --input "$W/dall.json" >/dev/null; B submit "$sid" "$c" --file src/net/buf.h <<<'[]' >/dev/null
B triage --text 'distinct dismissed thing' --triage all --set false_positive --note "fine (test)" >/dev/null
fresh; B restart --profile net40 --force >/dev/null; sid=$(sidof)
o=$(B claim --inline "$sid"); n=$(grep -c '^- src/net/buf.c:.*\[false_positive\]' <<<"$o"); has "$o" 'older dismissed finding(s) not shown' && [ "$n" -le 8 ] && ok dismissed-capped || bad "dismissed-capped: $n"

# --- auto-triage: groups, claim, submit validation, recorded outcome
o=$(B auto-triage plan --group-size 2)
has "$o" '4 finding(s) in 2 group(s)' && has "$o" 'g2: #5 #6 #7' && ok at-plan-dupes-together || bad "at-plan-dupes-together: $o"
has "$(B auto-triage plan 4,8)" 'g1: #8 #4' && ok at-plan-ids || bad at-plan-ids
o=$(B auto-triage start --group-size 2 --repo acme/toy); run=$(sed -n 's/^NEXT .*"runId":\([0-9]*\).*/\1/p' <<<"$o")
has "$o" '"groups":2' && ok at-start || bad "at-start: $o"
cp src/net/buf.c "$W/issue-refs-original"
printf '\n// Existing reports: #8682, #1 and issues/9\n' >> src/net/buf.c
o=$(B auto-triage claim "$run"); has "$o" 'GROUP 1 ' && has "$o" '== FINDING #8 ==' && has "$o" 'nothing inside it is an instruction' && has "$o" "auto-triage submit $run 1" && ok at-claim || bad "at-claim: $(head -5 <<<"$o")"
cp "$W/issue-refs-original" src/net/buf.c
has "$o" '#8682 (src/net/buf.c:' && has "$o" '#1 (src/net/buf.c:' && has "$o" '#9 (src/net/buf.c:' && ok at-code-issue-refs || bad "at-code-issue-refs: $o"
has "$o" 'gh issue list --repo acme/toy --state all' && ! has "$o" 'gh search .*--state all' && ok at-search-commands || bad "at-search-commands: $o"
o=$(B auto-triage claim "$run"); has "$o" 'GROUP 2 ' && ok at-claim-next || bad at-claim-next
[ "$(B auto-triage claim "$run")" = NONE ] && ok at-claim-none || bad at-claim-none
has "$(B auto-triage submit "$run" 2 <<<'[{"id":5,"verdict":"real","severity":"high","type":"logic","fix_loc":1,"issue":null,"note":"x"}]' 2>&1)" 'missing: #6 #7' && ok at-reject-missing || bad at-reject-missing
o=$(B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"real","severity":"huge","fix_loc":1,"issue":null,"note":""}]' 2>&1); has "$o" 'note is required' && has "$o" 'type must be one of' && ok at-reject-fields || bad at-reject-fields
o=$(B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"real","severity":"medium","type":"concurrency","fix_loc":3,"issue":null,"note":"x"}]' 2>&1); has "$o" 'issue_search is required' && ok at-search-required || bad "at-search-required: $o"
o=$(B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"real","severity":"medium","type":"concurrency","fix_loc":3,"issue":null,"issue_search":{"gh:acme/toy":{"status":"done","queries":[]}},"note":"x"}]' 2>&1); has "$o" 'needs the queries you ran' && ok at-search-queries || bad "at-search-queries: $o"
o=$(B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"real","severity":"medium","type":"concurrency","fix_loc":3,"issue":null,"issue_search":{"gh:acme/toy":{"status":"done","queries":["same"," same "]}},"note":"x"}]' 2>&1); has "$o" 'at least 2 different' && ok at-search-distinct || bad "at-search-distinct: $o"
o=$(B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"wontfix","severity":"medium","type":"concurrency","fix_loc":3,"issue":null,"issue_search":{"gh:acme/toy":{"status":"done"}},"note":"x"}]' 2>&1); has "$o" 'needs the queries you ran' && ok at-search-other-verdict || bad "at-search-other-verdict: $o"
B auto-triage submit "$run" 1 <<<'[{"id":8,"verdict":"real","severity":"medium","type":"concurrency","fix_loc":3,"issue":{"number":42,"url":"https://github.com/acme/toy/issues/42"},"issue_search":{"gh:acme/toy":{"status":"done","queries":["buf free","use after free buf.c"]}},"note":"free then write at buf.c:1"}]' >/dev/null
o=$(B show 8); has "$o" 'confirmation=confirmed' && has "$o" 'triage=confirmed' && has "$o" 'fix_loc=3' && has "$o" '\[severity: high → medium\]' && has "$o" 'linked_existing: gh:acme/toy 42' && has "$o" 'type=concurrency (set by triage)' && has "$o" '\[type: memory-safety → concurrency\]' && ok at-submit-applied || bad "at-submit-applied: $o"
has "$(B auto-triage submit "$run" 1 <<<'[]' 2>&1)" 'already submitted' && ok at-resubmit || bad at-resubmit
B auto-triage submit "$run" 2 <<<'[{"id":5,"verdict":"false_positive","severity":"high","type":"memory-safety","fix_loc":0,"issue":null,"note":"loop bound is n-1"},{"id":6,"verdict":"wontfix","severity":"low","type":"memory-safety","fix_loc":2,"issue":null,"note":"test helper"},{"id":7,"verdict":"unsure","severity":"high","type":"memory-safety","fix_loc":2,"issue":null,"issue_search":{"gh:acme/toy":{"status":"failed","error":"error connecting to api.github.com"}},"note":"depends on caller"}]' >/dev/null
has "$(B show 5)" 'triage=false_positive' && has "$(B show 6)" 'triage=wontfix' && has "$(B show 7)" 'confirmation=not_confirmed' && has "$(B show 7)" 'triage=open' && ok at-verdict-map || bad at-verdict-map
o=$(B auto-triage status "$run"); has "$o" '2 done' && has "$o" 'real 1, false_positive 1, wontfix 1, unsure 1' && has "$o" 'severity changed 2' && has "$o" 'type changed 1' && has "$o" 'memory-safety→concurrency' && ok at-status || bad "at-status: $o"
has "$o" 'auto-triage start --ids <ids> --recheck --repo acme/toy' && has "$o" 'duplicate search in gh:acme/toy: done 1, FAILED 1, missing 0' && ok at-status-search || bad "at-status-search: $o"
# render files a confirmed finding only after a successful search; a failed search keeps it held
B triage 7 --set confirmed >/dev/null; B unlink 8 >/dev/null 2>&1
r=$(B render --ids 7,8 --triage confirmed --min-severity low)
has "$r" 'HELD 1 finding(s)' && has "$r" '#7 .*gh:acme/toy: failed' && has "$r" '1 draft' && ok render-gate-search || bad "render-gate-search: $r"
for empty_trackers in ' ' ','; do
  B report-config set dedupe_trackers "$empty_trackers" >/dev/null
  r=$(B render --ids 7,8 --triage confirmed --min-severity low)
  has "$r" 'HELD 1 finding(s)' && has "$r" '#7 .*gh:acme/toy: failed' && has "$r" '1 draft' && ok render-empty-trackers || bad "render-empty-trackers: $r"
done
B report-config unset dedupe_trackers >/dev/null
r=$(B render --target jira:AA --ids 7 --triage confirmed --min-severity low)
retry=$(sed -n 's/^  search them: `\(.*\)`, then render again$/\1/p' <<<"$r")
read -r -a retry_args <<<"$retry"
touch "$FAKEGH_LOG.noapi"
o=$(B "${retry_args[@]}" 2>&1)
rm -f "$FAKEGH_LOG.noapi"
has "$o" 'duplicates searched in jira:AA' && ! has "$retry" '--repo' && ok render-jira-only-retry || bad "render-jira-only-retry: $retry // $o"
B report-config set dedupe_trackers gh:acme/toy,jira:AA,jira:BB >/dev/null
r=$(B render --ids 7 --triage confirmed --min-severity low)
has "$r" '--repo acme/toy --jira AA --jira BB' && ok render-retry-trackers || bad "render-retry-trackers: $r"
B report-config unset dedupe_trackers >/dev/null
B triage 7 --set open >/dev/null; B link 8 gh:acme/toy 42 --kind linked_existing >/dev/null
# start refuses when gh cannot reach the repo
touch "$FAKEGH_LOG.noapi"; o=$(B auto-triage start 7 --recheck --repo acme/toy 2>&1); rm -f "$FAKEGH_LOG.noapi"
has "$o" 'cannot reach GitHub repo acme/toy' && ok at-preflight || bad "at-preflight: $o"
has "$(B query --max-fix-loc 2 --triage all --sort fix_loc)" '#7' && ! has "$(B query --max-fix-loc 2 --triage all)" '#8	' && ok at-fix-loc-filter || bad at-fix-loc-filter
has "$(B auto-triage plan)" 'no findings to triage' && has "$(B auto-triage plan --recheck --severity high+)" '#7' && ok at-recheck || bad at-recheck

o=$(B auto-triage start 7 --recheck --repo acme/toy --jira AA --jira BB)
has "$o" 'gh:acme/toy, jira:AA, jira:BB' && ok at-repeat-jira || bad "at-repeat-jira: $o"

# --- finding types: heuristic from category, retype, confirm --set-type, filters, report grouping
has "$(B query --type crash --triage all --include-gone)" 'nil pointer dereference' && has "$(B query --type security --triage all --include-gone)" 'SQL injection' && ok type-heuristic || bad type-heuristic
has "$(B query --type bogus 2>&1)" 'unknown type bogus' && ok type-filter-validates || bad type-filter-validates
has "$(B retype 7 --set integer --note 'heap index math')" '#7 memory-safety→integer' && o=$(B show 7) && has "$o" 'type=integer (set by triage)' && has "$o" '\[type\] heap index math' && ok retype-set || bad retype-set
B retype --auto --force >/dev/null; has "$(B show 7)" 'type=integer' && has "$(B show 8)" 'type=concurrency' && ok retype-auto-keeps-locked || bad retype-auto-keeps-locked
has "$(B retype 9 --set nonsense 2>&1)" '--set must be one of' && ok retype-validates || bad retype-validates
has "$(B confirm 7 --set confirmed --set-type dos)" 'type: #7 integer→dos' && ok confirm-set-type || bad confirm-set-type
has "$(B query --triage all --sort type --format csv)" 'id,severity,type,category' && ok type-csv || bad type-csv
has "$(B status)" 'by type:' && ok type-status || bad type-status

# --- registered profiles side by side: versions, parallel scans, per-scan reports, compare, repeat, store
fresh
o=$(B profile register sec-a --prompt security --model opus --no-plan --only src/net/ --only src/store/kv.go --chunk-kb 40)
has "$o" 'registered sec-a@1' && ok profile-register || bad "profile-register: $o"
has "$(B profile register sec-a --prompt security --model opus --no-plan --only src/store/kv.go --only src/net/ --chunk-kb 40)" 'unchanged, already registered as sec-a@1' && ok profile-idempotent || bad profile-idempotent
P sec-b --prompt security --model codex:gpt-x --no-plan --only src/net/ --only src/store/kv.go --chunk-kb 40
has "$(B profile diff sec-a sec-b)" 'runner, model' && ok profile-diff || bad "profile-diff: $(B profile diff sec-a sec-b)"
has "$(B profile show sec-a@1)" 'frozen copy' && has "$(B profile list)" 'sec-b@1' && ok profile-show-list || bad profile-show-list
o=$(B start --profile sec-a,sec-b --label par)
has "$o" '(par-sec-a)' && has "$o" '(par-sec-b)' && [ "$(grep -c '^RUN ' <<<"$o")" = 2 ] && [ "$(grep -c 'to review: 3 files' <<<"$o")" = 2 ] && ok parallel-start || bad "parallel-start: $o"
sa=$(B sql "select id from scans where label='par-sec-a'" | tail -1); sb=$(B sql "select id from scans where label='par-sec-b'" | tail -1)
has "$(B continue 2>&1)" 'scans are open' && ok ambiguous-needs-scan || bad ambiguous-needs-scan
has "$(B continue --scan par-sec-b)" '"workers":' && ok continue-by-label || bad continue-by-label
has "$(B start --profile sec-a 2>&1)" "scan $sa of profile sec-a is active" && ok start-refuses-same-profile || bad start-refuses-same-profile
drain() {  # $1 scan, $2 findings for buf.c, $3 for kv.go
  local o c
  while o=$(B claim --inline "$1"); [ "$o" != NONE ]; do c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o")
    printf '%s' "$o" > "$W/claim.txt"
    python3 -c 'import json, re, sys
keys = re.findall(r"\"(src/[^\"]+)\": \[ \]", open(sys.argv[3]).read())
print(json.dumps({k: json.loads(sys.argv[1] if k == "src/net/buf.c" else sys.argv[2] if k == "src/store/kv.go" else "[]") for k in keys}))' "$2" "$3" "$W/claim.txt" > "$W/batch.json"
    B submit "$1" "$c" --input "$W/batch.json" >/dev/null || echo "SUBMITFAIL $1"; done
}
drain "$sa" '[{"line":2,"severity":"critical","category":"uaf","title":"f writes into b after free(b): use-after-free"}]' '[{"line":2,"severity":"high","category":"nil-deref","title":"nil map value dereference in G"}]'
drain "$sb" '[{"line":2,"severity":"high","category":"uaf","title":"use-after-free: b written after free in f"}]' '[]'
uaf=$(B query --scan "$sa" --path src/net/buf.c --triage all --include-gone --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
o=$(B show "$uaf"); has "$o" "scan $sa (par-sec-a).*sec-a@1.*\[critical" && has "$o" "scan $sb (par-sec-b).*sec-b@1.*codex:gpt-x \[high" && ok per-scan-reports || bad "per-scan-reports: $o"
o=$(B compare par-sec-a par-sec-b)
has "$o" 'found by all: 1 (critical 1)' && has "$o" "only scan $sa: 1 (high 1)" && has "$o" "only scan $sb: 0" && has "$o" "$sa:critical $sb:high" && has "$o" 'profiles differ in: runner, model' && ok compare-overlap || bad "compare-overlap: $o"
[ "$(B compare "$sa" "$sb" --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["clusters"]), d["basis"]["files"], [s["unique"] for s in d["scans"]])')" = "2 3 [1, 0]" ] && ok compare-json || bad "compare-json: $(B compare "$sa" "$sb" --json | head -c 600)"
has "$(B query --scan "$sa" --not-seen-by "$sb" --triage all --include-gone)" 'kv.go' && ! has "$(B query --scan "$sa" --not-seen-by "$sb" --triage all --include-gone)" 'buf.c' && ok query-not-seen-by || bad query-not-seen-by
has "$(B query --profile sec-b --triage all --include-gone)" 'buf.c' && ok query-profile || bad query-profile
has "$(B scans --profile sec-b)" par-sec-b && ! has "$(B scans --profile sec-b)" par-sec-a && ok scans-filter || bad scans-filter
o=$(B scans show "$sa"); has "$o" 'profile: sec-a@1' && has "$o" 'repeat exactly' && has "$o" 'chunks: 2, 2 with a recorded prompt hash' && ok scans-show || bad "scans-show: $o"
# exact repeat: same chunks in the same order and the same dismissed context, even after triage changed
B triage --path src/store/kv.go --triage all --set false_positive --note "repeat test" >/dev/null
o=$(B repeat par-sec-a --label again); r=$(sed -n 's/^scan \([0-9]*\) (again) repeats scan.*/\1/p' <<<"$o")
[ -n "$r" ] && has "$o" 'the same 2 chunk(s)' && [ "$(B sql "select group_concat(items_json,'|') from (select items_json from chunks where scan_id=$sa and state!='void' order by ord)" | tail -1)" = "$(B sql "select group_concat(items_json,'|') from (select items_json from chunks where scan_id=$r order by ord)" | tail -1)" ] && ok repeat-same-chunks || bad "repeat-same-chunks: $o"
o=$(B claim --inline "$r"); ! has "$o" 'repeat test' && ok repeat-replays-context || bad "repeat-replays-context: $(head -c 500 <<<"$o")"
B stop --scan "$r" --close >/dev/null
o=$(CODESCAN_CLAUDE_BIN=/bin/true B repeat "$sa" 2>&1); has "$o" 'drift: runner binary' && ok repeat-drift || bad "repeat-drift: $o"
B stop --scan again --close >/dev/null 2>&1; B stop --all --close >/dev/null 2>&1
# another review type re-reviewing a changed file leaves the first type's findings alone
printf '// touch\n' >> src/net/buf.c; git commit -qam touch
P conc --prompt concurrency --model opus --no-plan --only src/net/ --chunk-kb 40
B restart --profile conc >/dev/null; drain "$(sidof)" '[]' '[]'
has "$(B query --path src/net/buf.c --triage all)" "#$uaf" && ok gone-per-profile || bad "gone-per-profile: $(B query --path src/net/buf.c --triage all --include-gone)"
# same profile at a later commit: new / gone / still there
fresh; B restart --profile sec-a >/dev/null; s2=$(sidof); drain "$s2" '[]' '[]'
o=$(B compare "$sa" "$s2"); has "$o" 'gone 1 (critical 1)' && has "$o" 'still there 1 (0 found again, 1 on unchanged files)' && ok compare-commits || bad "compare-commits: $o"
has "$(B query --path src/net/buf.c --gone --triage all)" "#$uaf" && ok gone-same-profile || bad gone-same-profile
# remove a scan: findings only it reported go unless someone triaged them
o=$(B scans rm "$sb" --dry-run); has "$o" '0 finding(s) only it reported' && ok scans-rm-dry || bad "scans-rm-dry: $o"
B scans label "$sb" keep >/dev/null; has "$(B scans)" 'keep' && ok scans-label || bad scans-label
B scans rm keep >/dev/null; ! has "$(B scans)" 'keep' && has "$(B show "$uaf")" "scan $sa" && ! has "$(B show "$uaf")" "scan $sb " && ok scans-rm || bad "scans-rm: $(B show "$uaf")"
has "$(B run "$s2" --model opus 2>&1)" 'belong to a profile' && ok run-locked-to-profile || bad run-locked-to-profile

# --- init with effort: bracket + refine, grow-first for efforts that hold up, A round reuse, matrix, pick --effort (own store)
export CODESCAN_HOME=$W/state-init
# low effort loses all but 2 files per chunk above 16KB; high/max hold up at every size; medium in between
efr() { case $2 in low) { [ "$3" -le 16 ] || [ "$5" -le 2 ]; } && echo 1 || echo 0;; medium) { [ "$3" -le 16 ] || [ "$5" -le 6 ]; } && echo 1 || echo 0;; *) echo 1;; esac; }
o=$(B init start --models eff-model --sample-kb 40 --medium 16)
has "$o" '3 candidate(s) \[eff-model low, eff-model high, eff-model max\]' && has "$o" 'screen at 16/36KB' && ok init-effort-bracket || bad "init-effort-bracket: $o"
initsim 1 efr
r=$(B init status)
has "$r" 'eff-model medium' && ok init-effort-refine || bad "init-effort-refine: $r"
has "$r" 'eff-model high \[done\] → 36KB' && has "$r" 'eff-model low \[done\] → 16KB' && ok init-effort-sizes || bad "init-effort-sizes: $r"
n=$(B sql "select count(*) from scans s join calibrations c on c.id=s.cal_id where c.init_id=1 and c.effort='high' and json_extract(s.options_json,'$.chunkKb')<16" | tail -1)
[ "$n" = 0 ] && ok init-grow-first || bad "init-grow-first: $n rounds below 16KB for high"
n=$(B sql "select count(*) from scans s join calibrations c on c.id=s.cal_id where c.init_id=1 and c.effort='high' and json_extract(s.options_json,'$.batch')='a'" | tail -1)
[ "$n" = 1 ] && ok init-a-reuse || bad "init-a-reuse: $n A rounds for high"
rec=$(B init report | sed -n 's/^recommended: eff-model \([a-z]*\) .*/\1/p')
o=$(B init pick eff-model 2>&1); [ -n "$rec" ] && has "$o" "effort $rec," && ok init-pick-recommended-effort || bad "init-pick-recommended-effort: [$rec] $o"
o=$(B init pick eff-model --effort high); has "$o" 'effort high, chunk size 36KB' && has "$(B profile show default)" 'effort=high' && ok init-pick-effort || bad "init-pick-effort: $o"
has "$(B sql "select value from config where key='chunk_kb:eff-model@high'")" 36 && ok init-chunk-per-effort || bad init-chunk-per-effort
o=$(B init start --models eff-model --matrix --sizes 16 --sample-kb 40 --medium 16)
has "$o" '5 candidate(s)' && has "$o" 'every candidate runs 16KB (no search)' && ok init-matrix-start || bad "init-matrix-start: $o"
initsim 2 efr
has "$INITOUT" '^DONE init 2' && ! has "$INITOUT" 'pruned' && [ "$(grep -o 'done 16KB' <<<"$INITOUT" | wc -l)" = 5 ] && ok init-matrix || bad "init-matrix: $INITOUT"
export CODESCAN_HOME=$W/state

# --- upgrade: a store made by the previous release gets legacy profiles, keeps its ledger
OLD=2faaeaa270ecbe8a689c2a67403b2e36389fcf2b   # 1.7.0, the last release before registered profiles
if git -C "$HERE" cat-file -e "$OLD:bin/code-scan.js" 2>/dev/null; then
  mkdir -p "$W/old" && git -C "$HERE" archive "$OLD" bin profiles agents prompts package.json | tar -x -C "$W/old"
  O() { node "$W/old/bin/code-scan.js" "$@"; }
  export CODESCAN_HOME=$W/state-old
  O start --chunk-kb 8 --no-plan --model opus >/dev/null; c=$(O claim 1 | sed -n 's/^CHUNK \([0-9]*\).*/\1/p')
  while [ -n "$c" ]; do o=$(O claim 1); c=$(sed -n 's/^CHUNK \([0-9]*\).*/\1/p' <<<"$o"); for p in $(sed -n 's/^- \([^ ]*\)$/\1/p' <<<"$o"); do O submit 1 "$c" --file "$p" <<<'[]' >/dev/null; done; done
  O sql "select count(*) from reviewed" >/dev/null
  o=$(B profile list); has "$o" 'legacy-default@1' && has "$(B scans show 1)" 'legacy-default@1' && ok upgrade-legacy-profile || bad "upgrade-legacy-profile: $o"
  o=$(B restart); has "$o" 'profile=legacy-default@1' && has "$o" 'unchanged (skipped): [1-9]' && ok upgrade-ledger-kept || bad "upgrade-ledger-kept: $o"
  export CODESCAN_HOME=$W/state
else ok "upgrade (skipped: 1.7.0 not in this checkout)"; fi

echo "---"; [ $FAILS = 0 ] && echo "ALL PASS" || echo "$FAILS FAILED"; exit $FAILS
