#!/usr/bin/env bash
# Runner regression: drives scans, auto-triage, calibration and init through every supported agent CLI,
# each replaced by test/fake-runners/fake-agent.js (no LLM). Usage: test/runners-e2e.sh [workdir]
set -uo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=${1:-$(mktemp -d)}
rm -rf "$W"; mkdir -p "$W/repo" "$W/bin" "$W/home"
export PATH=$W/bin:$PATH FAKE_LOG=$W/argv.log HOME=$W/home
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
B() { node "$HERE/bin/code-scan.js" "$@"; }
FAILS=0
ok()   { echo "PASS $1"; }
bad()  { echo "FAIL $1"; FAILS=$((FAILS+1)); }
has()  { grep -q -- "$2" <<<"$1"; }
Q()    { B sql "$1" | tail -1 | tr '\t' ','; }
M()    { [ "$1" = claude ] && echo opus || echo "$1:m1"; }   # a model id per runner
P()    { B profile register "$@" >/dev/null || echo "REGFAIL $*"; }
for r in claude codex gemini agy copilot cursor-agent opencode; do
  n=$r; [ "$r" = cursor-agent ] && n=cursor
  printf '#!/bin/sh\nexec node %s %s "$@"\n' "$HERE/test/fake-runners/fake-agent.js" "$n" > "$W/bin/$r"; chmod +x "$W/bin/$r"
done
printf '#!/bin/sh\nexit 1\n' > "$W/bin/gh"; chmod +x "$W/bin/gh"

cd "$W/repo" && git init -q -b main && git config user.email t@t && git config user.name t
mkdir -p src/net src/store
printf 'void f(char*b){ free(b); b[0]=1; }\n' > src/net/buf.c
printf 'package s\nfunc G(m map[string]*int,k string) int { return *m[k] }\n' > src/store/kv.go
printf 'def q(c,n):\n    return c.execute("select %%s" %% n)\n' > src/store/db.py
python3 -c "print('\n'.join('int h%d(int a){return a+%d;}'%(i,i) for i in range(1500)))" > src/store/big.c
git add -A && git commit -qm init

# --- runner choice
o=$(B runners); has "$o" 'codex .*fake-codex' && has "$o" 'a new scan would use: claude' && ok runners-list || bad "runners-list: $o"
o=$(CODESCAN_DETECT=env CODEX_SANDBOX=seatbelt B runners); has "$o" 'running inside codex' && has "$o" 'would use: codex' && ok detect-host-env || bad "detect-host-env: $o"
o=$(CODESCAN_RUNNER=opencode B runners); has "$o" 'would use: opencode' && ok runner-env || bad "runner-env: $o"
o=$(B runners --model codex:gpt-6.2-sol); has "$o" 'would use: codex model codex:gpt-6.2-sol' && ok runner-from-model || bad "runner-from-model: $o"
o=$(B runners --runner nope 2>&1); has "$o" "unknown runner 'nope'" && ok runner-unknown || bad "runner-unknown: $o"
o=$(B runners --runner codex --model gemini:x 2>&1); has "$o" 'conflicts' && ok runner-conflict || bad "runner-conflict: $o"

# --- a full scan per runner (planner + reviewers), usage and dollars recorded
for r in claude codex gemini agy copilot cursor opencode; do
  rm -rf "$W/state-$r"; export CODESCAN_HOME=$W/state-$r
  P "p-$r" --prompt default --model "$(M "$r")" --chunk-kb 8
  o=$(B start --profile "p-$r")
  has "$o" "runner: $r" && has "$o" "^RUN .* run 1 --detach" && has "$o" "\"runner\":\"$r\"" || bad "start-$r: $o"
  o=$(B run 1 --concurrency 2 2>&1)
  st=$(B status)
  n=$(Q "SELECT COUNT(*) n FROM findings WHERE path='src/net/buf.c'")
  if has "$o" 'planner: plan applied' && has "$st" '\[done\]' && [ "$n" = 1 ] && has "$st" 'agents: .* ok, 0 failed'; then ok "scan-$r"; else bad "scan-$r: $o // $st"; fi
  u=$(Q "SELECT SUM(usd) u, SUM(input_tokens) i FROM agent_runs")
  case $r in
    copilot) [ "$u" = "," ] || [ "$u" = ",0" ] || [[ "$u" == ,* ]] && ok "usage-$r (none reported)" || bad "usage-$r: $u" ;;
    *) [[ "$u" =~ ^0\.[0-9]+,[0-9]+$ ]] && ok "usage-$r" || bad "usage-$r: $u" ;;
  esac
done
has "$(grep '^codex ' "$FAKE_LOG" | head -1)" '--sandbox read-only' && ok codex-read-only || bad codex-read-only
has "$(grep '^claude ' "$FAKE_LOG" | head -1)" '--disallowedTools Edit,Write' && ok claude-read-only || bad claude-read-only
has "$(grep '^copilot ' "$FAKE_LOG" | head -1)" '--deny-tool write' && ok copilot-read-only || bad copilot-read-only

# --- invalid reply → one fix-up agent, then stored
export CODESCAN_HOME=$W/state-fix; mkdir -p "$W/badonce"
P fix --prompt default --model codex:m1 --no-plan --chunk-kb 8; B start --profile fix >/dev/null
o=$(FAKE_BAD_ONCE=$W/badonce B run 2>&1)
k=$(Q "SELECT COUNT(*) FROM agent_runs WHERE kind='fix'")
[ "$k" = 1 ] && has "$(B status)" '\[done\]' && ok reply-fixup || bad "reply-fixup: $k $o"

# --- the agent CLI itself fails: stop after the planner instead of failing every chunk
export CODESCAN_HOME=$W/state-cli-fail
P cf --prompt default --model codex:m1 --chunk-kb 8; B start --profile cf >/dev/null
o=$(FAKE_FAIL='model not supported' B run 2>&1); n=$(Q "SELECT COUNT(*) FROM agent_runs")
has "$o" 'stopped: the planner agent failed' && has "$o" 'model not supported' && [ "$n" = 1 ] && ok cli-fail-stops-early || bad "cli-fail-stops-early: $n $o"
o=$(B run 2>&1); has "$o" 'planner: plan applied' && has "$(B status)" '\[done\]' && ok cli-fail-rerun || bad "cli-fail-rerun: $o"

# --- limits
export CODESCAN_HOME=$W/state-lim
P cp --prompt default --model copilot:m1; P cx --prompt default --model codex:m1
o=$(B start --profile cp --max-usd 5 2>&1); has "$o" 'cannot be enforced with the copilot runner' && ok copilot-max-usd-refused || bad "copilot-max-usd: $o"
o=$(B start --profile cx --max-5h-pct 50 2>&1); has "$o" 'needs the claude runner' && ok 5h-needs-claude || bad "5h-needs-claude: $o"
P oc --prompt default --model opencode:m1 --no-plan --chunk-kb 8; B start --profile oc --max-usd 0.01 >/dev/null
o=$(B run --concurrency 1 2>&1); st=$(B status)
has "$st" 'stopped by limit: spend' && has "$st" 'pending' && ok max-usd-stops || bad "max-usd-stops: $o // $st"

# --- detach + stop --now
export CODESCAN_HOME=$W/state-det
P gm --prompt default --model gemini:m1 --no-plan --chunk-kb 8; B start --profile gm >/dev/null
o=$(FAKE_SLEEP_MS=20000 B run --detach); has "$o" 'RUNNING scan 1 on gemini' || bad "detach: $o"
for i in $(seq 1 50); do [ "$(Q "SELECT COUNT(*) FROM chunks WHERE state='claimed'")" != 0 ] && break; sleep 0.2; done
has "$(B status)" 'runner process [0-9]*: running' && ok detach-running || bad "detach-running: $(B status)"
o=$(B stop --now); has "$o" 'killed' || bad "stop-now: $o"
sleep 1
st=$(B status); c=$(Q "SELECT COUNT(*) FROM chunks WHERE state='claimed'")
[ "$c" = 0 ] && has "$st" 'not running' && ! pgrep -f "fake-agent.js gemini" >/dev/null && ok stop-now-kills || bad "stop-now-kills: claimed=$c $st"
o=$(B run 2>&1); has "$o" 'stopped' && ok run-needs-continue || bad "run-needs-continue: $o"

# --- two review profiles on different runners side by side; frozen runner args; run record
export CODESCAN_HOME=$W/state-par
CODESCAN_CODEX_ARGS=--frozen-arg P par-cx --prompt security --model codex:m1 --chunk-kb 8
P par-gm --prompt security --model gemini:m1 --chunk-kb 8
o=$(B start --profile par-cx,par-gm); has "$o" 'plans for the batch' && has "$o" 'waits for the plan of scan' && ok parallel-batch || bad "parallel-batch: $o"
: > "$FAKE_LOG"
o1=$(B run 1 --detach); o2=$(B run 2 --detach)
for i in $(seq 1 150); do [ "$(Q "SELECT COUNT(*) FROM scans WHERE status='done'")" = 2 ] && break; sleep 0.2; done
st=$(B status --scan 1; B status --scan 2)
[ "$(Q "SELECT COUNT(*) FROM scans WHERE status='done'")" = 2 ] && [ "$(Q "SELECT COUNT(*) FROM agent_runs WHERE kind='plan'")" = 1 ] && ok parallel-runners || bad "parallel-runners: $st"
[ "$(Q "SELECT COUNT(DISTINCT ps) FROM (SELECT group_concat(path) ps FROM (SELECT scan_id, path FROM files WHERE state='reviewed' ORDER BY path) GROUP BY scan_id)")" = 1 ] && ok parallel-same-code-set || bad parallel-same-code-set
grep '^codex ' "$FAKE_LOG" | grep -q -- '--frozen-arg' && ok runner-args-frozen || bad "runner-args-frozen: $(grep '^codex ' "$FAKE_LOG" | head -1)"
has "$(B scans show 2)" 'runner: gemini fake-gemini 1.0.0' && ok run-record || bad "run-record: $(B scans show 2)"
has "$(B compare 1 2)" 'compare 2 scans' && ok compare-runners || bad compare-runners

# --- reasoning effort: frozen in a profile, passed to the runner CLI and to Workflow agents
export CODESCAN_HOME=$W/state-effort
o=$(B profile register ef-gm --prompt security --model gemini:m1 --effort high 2>&1); has "$o" 'no reasoning-effort setting' && ok effort-unsupported || bad "effort-unsupported: $o"
o=$(B profile register ef-cx --prompt security --model codex:m1 --effort max 2>&1); has "$o" 'codex accepts minimal' && ok effort-bad-level || bad "effort-bad-level: $o"
P ef-cx --prompt security --model codex:m1 --effort xhigh --chunk-kb 8 --no-plan
P ef-cl --prompt security --model opus --effort max --chunk-kb 8 --no-plan
has "$(B profile show ef-cx)" 'effort=xhigh' && ok effort-profile-show || bad "effort-profile-show: $(B profile show ef-cx)"
o=$(B start --profile ef-cl); has "$o" '"effort":"max"' && ok effort-workflow-next || bad "effort-workflow-next: $o"
B stop --all --close >/dev/null 2>&1
o=$(B start --profile ef-cx --new); : > "$FAKE_LOG"; B run "$(Q "SELECT MAX(id) FROM scans")" >/dev/null 2>&1
grep '^codex ' "$FAKE_LOG" | grep -q 'model_reasoning_effort="xhigh"' && ok effort-codex-argv || bad "effort-codex-argv: $(grep '^codex ' "$FAKE_LOG" | head -1)"
o=$(B auto-triage start --group-size 5 --runner claude --effort low); has "$o" '"effort":"low"' && ok effort-triage-next || bad "effort-triage-next: $o"
o=$(B auto-triage start --group-size 5 --recheck --runner codex --effort max 2>&1); has "$o" 'codex accepts' && ok effort-triage-bad || bad "effort-triage-bad: $o"

# --- auto-triage through a runner
export CODESCAN_HOME=$W/state-codex
o=$(B auto-triage start --group-size 1 --runner cursor); has "$o" 'RUN .*auto-triage run 1' && has "$o" '"runner":"cursor"' || bad "at-start: $o"
o=$(B auto-triage run 2>&1); st=$(B auto-triage status)
has "$st" 'groups: 1 done' && has "$st" 'real 1' && ok auto-triage-run || bad "auto-triage-run: $o // $st"

# --- calibration and a mixed-vendor init
export CODESCAN_HOME=$W/state-init
o=$(B calibrate start --model codex:gpt-6.2-sol --sample-kb 200 --medium 8); has "$o" 'calibrate run' || bad "cal-start: $o"
o=$(B calibrate run 2>&1); has "$o" 'DONE chunk_kb=' && has "$(B calibrate status)" 'codex:gpt-6.2-sol \[done\]' && ok calibrate-run || bad "calibrate-run: $o"
o=$(B init start --models sonnet,codex:gpt-6.2-sol,gemini:gemini-3.1-pro-preview --sample-kb 40 --medium 8)
has "$o" '"runner":"codex"' && has "$o" 'init run' || bad "init-start: $o"
o=$(B init run 2>&1)
has "$o" 'claude-sonnet-5-5' && has "$o" 'codex:gpt-6.2-sol' && has "$o" 'gemini:gemini-3.1-pro-preview' && has "$o" 'recommended:' && ok init-run-mixed || bad "init-run-mixed: $o"
# effort bracket per runner reaches the agent CLIs; gemini has no effort setting, so one candidate
grep -q -- '--effort max' "$FAKE_LOG" && grep -q 'model_reasoning_effort="minimal"' "$FAKE_LOG" && has "$o" 'claude-sonnet-5-5	low' \
  && [ "$(B sql "select count(*) from calibrations where model like 'gemini:%' and init_id is not null" | tail -1)" = 1 ] && ok init-run-effort || bad "init-run-effort: $o"

# --- run-prompt
echo 'PING' > "$W/p.md"
o=$(B run-prompt "$W/p.md" --runner opencode); [ "$o" = PONG ] && ok run-prompt || bad "run-prompt: $o"

# --- install skills for other hosts
o=$(B install --dir "$W/skills"); has "$o" 'installed 12 skills' || bad "install: $o"
[ -f "$W/skills/code-scan-scan/SKILL.md" ] && ! grep -rq 'CLAUDE_PLUGIN_ROOT' "$W/skills" && grep -q '^name: code-scan-scan$' "$W/skills/code-scan-scan/SKILL.md" \
  && grep -q "$HERE/bin/code-scan.js" "$W/skills/code-scan-scan/SKILL.md" && ok install-render || bad install-render
mkdir -p "$W/skills2/code-scan-scan"; o=$(B install --dir "$W/skills2" 2>&1); has "$o" 'was not installed by code-scan' && ok install-no-clobber || bad "install-no-clobber: $o"
o=$(B install --dir "$W/skills"); has "$o" 'installed 12' && ok install-idempotent || bad install-idempotent
o=$(B install --dir "$W/skills" --uninstall); [ ! -e "$W/skills/code-scan-scan" ] && has "$o" 'removed 12' && ok uninstall || bad "uninstall: $o"

# extractJson: a string ending in an escaped backslash must not flip string tracking
o=$(node -e 'const {extractJson}=require(process.argv[1]); console.log(JSON.stringify(extractJson(process.argv[2])))' "$HERE/bin/lib/runners.js" 'reply: {"a":"x\\\\","b":{"c":1}} done')
[ "$o" = '{"a":"x\\\\","b":{"c":1}}' ] && ok extract-json-escaped-backslash || bad "extract-json-escaped-backslash: $o"

echo ---
[ $FAILS -eq 0 ] && echo "ALL PASS" || { echo "$FAILS FAILED"; exit 1; }
