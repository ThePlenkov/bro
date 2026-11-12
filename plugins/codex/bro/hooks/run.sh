#!/bin/sh
# Plugin hook launcher — prefer the checkout's built CLI, then `bro` on
# PATH. There is no network fallback on the hook path.
#
# Fail-open contract: nothing here may stall or fail the session —
# normal candidate failures fall through, deadline exhaustion stops the
# chain, and the script always exits 0.
#
# No-op fast path (spec: specs/bro-arm83.md): post-tool fires on every
# tool call and prompt-submit on every prompt; most emit nothing yet
# still paid a Node spawn. For those two events the checks below answer
# "could this event emit or mutate?" from on-disk state — payload shape,
# session markers, mailbox drops, lesson/guard caches, want-markers —
# and exit 0 when every answer is no. Doubt always defers to Node: a
# wasted spawn beats a skipped gate, never the other way round. Every
# other event — permission especially, whose stdout IS the answer — is
# untouched.
set -u

# BRO_HOOKS=0 marks a machine-backend tree (the acp provider pins it on
# the agent it spawns — spec bro-ddksm): session hooks rehydrate and gate
# for a human session that isn't there, so each event is pure deadline
# cost. Exit before resolving any binary — the flag must cost nothing.
# permission is the exception: its stdout IS the answer (Cursor denies a
# beforeShellExecution hook that prints nothing — even the self-tools it
# must allow), so it still resolves the binary; the CLI's flag check
# answers before any probe runs.
[ "${BRO_HOOKS:-}" = "0" ] && [ "${1:-}" != "permission" ] && exit 0
BRO_HOOK_T0=$(date +%s)

SCRIPT_ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." 2>/dev/null && pwd -P)
DEVIN_PROJECT_ROOT=
if [ -n "${DEVIN_PROJECT_DIR:-}" ]; then
  DEVIN_PROJECT_ROOT=$(CDPATH= cd -P "$DEVIN_PROJECT_DIR" 2>/dev/null && pwd -P)
fi

project_devin_hook_owns_event() {
  _event=$1
  case "$_event" in
    ''|*[!a-z-]*) return 1 ;;
    *) : ;;
  esac
  [ -n "$SCRIPT_ROOT" ] || return 1
  [ -n "$DEVIN_PROJECT_ROOT" ] || return 1
  [ "$SCRIPT_ROOT" != "$DEVIN_PROJECT_ROOT" ] || return 1
  [ -f "$DEVIN_PROJECT_ROOT/.devin/hooks.v1.json" ] || return 1
  [ -x "$DEVIN_PROJECT_ROOT/hooks/run.sh" ] || return 1
  grep -Eq "hooks/run[.]sh[^[:alnum:]_-]+${_event}([^a-z-]|$)" \
    "$DEVIN_PROJECT_ROOT/.devin/hooks.v1.json"
}

# Devin's project-local chain owns only its registered event.
if project_devin_hook_owns_event "${1:-}"; then
  exit 0
fi

CAPTURED=0
PAYLOAD=
PAYLOAD_FILE=
EVENT=${1:-}

cleanup_payload() {
  [ -z "$PAYLOAD_FILE" ] || rm -f "$PAYLOAD_FILE"
  return 0
}

trap cleanup_payload 0

BRO_HOOK_WATCHDOG_S=${BRO_HOOK_WATCHDOG_S:-8}
case "$BRO_HOOK_WATCHDOG_S" in
  ''|*[!0-9]*) BRO_HOOK_WATCHDOG_S=8 ;;
  *) [ "$BRO_HOOK_WATCHDOG_S" -gt 0 ] 2>/dev/null || BRO_HOOK_WATCHDOG_S=8 ;;
esac

# feed the (possibly captured) hook payload to whichever binary runs —
# the fast-path events re-read stdin, so it is replayed instead of the
# original fd
run_hook() {
  if [ "$CAPTURED" = 1 ]; then
    exec "$@" < "$PAYLOAD_FILE"
  else
    exec "$@" <&0
  fi
}

_kill_tree() {
  # children before parent — a dead parent's orphans reparent to init
  # and pkill -P sees nothing once the link is gone
  command -v pkill >/dev/null 2>&1 && pkill -"$2" -P "$1" 2>/dev/null
  kill -s "$2" "$1" 2>/dev/null
  :
}

bro_hook_kill_journal() {
  # best-effort journal of host/watchdog kills to <git-common>/bro/hooks/perf/killed.jsonl
  # fail-open
  local _base=${DEVIN_PROJECT_DIR:-$PWD}
  local _common
  # the rev-parse is bounded where timeout(1) exists — a wedged git
  # must not stall the hook past the budget this code enforces;
  # where it doesn't the call runs bare, same as it always did
  if command -v timeout >/dev/null 2>&1; then
    _common=$(timeout 2 git -C "$_base" rev-parse --git-common-dir 2>/dev/null | sed -n 1p)
  else
    _common=$(git -C "$_base" rev-parse --git-common-dir 2>/dev/null | sed -n 1p)
  fi
  case "$_common" in
    /*) ;;
    ?*) _common=$_base/$_common ;;
    *) _common= ;;
  esac
  [ -n "$_common" ] || return 0
  local _dir="$_common/bro/hooks/perf"
  mkdir -p "$_dir" 2>/dev/null || return 0
  local _ts _ev _budget
  # ISO only — an epoch-seconds fallback would write a second format
  # into killed.jsonl and break consumers (kilo); the sentinel keeps
  # the field parseable even if date somehow fails
  _ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '1970-01-01T00:00:00Z')
  _ev=${1:-timeout}
  _budget=${2:-${BRO_HOOK_WATCHDOG_S:-8}}
  # try to use python/node if available for safe JSON; fallback to printf
  if command -v node >/dev/null 2>&1; then
    node -e "require('fs').appendFileSync(process.argv[1], JSON.stringify({ts:new Date().toISOString(),event:process.argv[2],budget_ms:Number(process.argv[3])*1000})+'\n');" "$_dir/killed.jsonl" "$_ev" "$_budget" 2>/dev/null && return 0
  fi
  # printf fallback — sanitize first: the arithmetic dies on a
  # non-digit budget, and quotes/backslashes/newlines in _ev would
  # break the JSON row (kody)
  _budget=$(printf '%s' "$_budget" | tr -cd '0-9')
  [ -n "$_budget" ] || _budget=8
  _ev=$(printf '%s' "$_ev" | tr -d '"\\\n\r\t')
  printf '{"ts":"%s","event":"%s","budget_ms":%d}\n' "$_ts" "$_ev" $((_budget * 1000)) >> "$_dir/killed.jsonl" 2>/dev/null || true
  return 0
}

run_bounded() {
  RUN_BOUNDED_EXPIRED=0
  _now=$(date +%s)
  _elapsed=$((_now - BRO_HOOK_T0))
  _remaining=$((BRO_HOOK_WATCHDOG_S - _elapsed))
  if [ "$_remaining" -le 0 ]; then
    RUN_BOUNDED_EXPIRED=1
    bro_hook_kill_journal timeout
    return 124
  fi
  _marker=$(mktemp "${TMPDIR:-/tmp}/bro-hook-watchdog.XXXXXX" 2>/dev/null) || {
    RUN_BOUNDED_EXPIRED=1
    bro_hook_kill_journal timeout
    return 124
  }
  # fd 0 may be closed at launch: `exec` is a POSIX special builtin —
  # a failed redirect would exit the script before `||` runs, while a
  # redirect attached to it directly would persist in the shell. The
  # `command` prefix drops the exit rule; the brace group's 2>/dev/null
  # swallows the error without lasting (compound redirects don't persist).
  { command exec 3<&0 || command exec 3</dev/null; } 2>/dev/null
  run_hook "$@" <&3 &
  _pid=$!
  _kidsfile=$_marker.kids
  # detached dog: after the leftover window it marks expiry, pins the
  # direct kids (once the parent dies they reparent to init and
  # `pkill -P` sees nothing — the parent below owes the recorded ones
  # their signal), and TERMs the tree. Only TERM lives here: the KILL
  # leg runs in the parent, where cancelling this subshell mid-leg
  # can't leave a straggler holding the host's pipe
  (
    sleep "$_remaining"
    printf 1 > "$_marker" 2>/dev/null
    command -v pgrep >/dev/null 2>&1 && pgrep -P "$_pid" > "$_kidsfile" 2>/dev/null
    _kill_tree "$_pid" TERM
  ) </dev/null >/dev/null 2>&1 &
  _wd=$!
  wait "$_pid" 2>/dev/null
  _rc=$?
  kill "$_wd" 2>/dev/null
  wait "$_wd" 2>/dev/null || true
  if [ -s "$_marker" ]; then
    RUN_BOUNDED_EXPIRED=1
    bro_hook_kill_journal timeout
    # the dog's TERM landed before it exited — give the tree its 1s
    # grace, then KILL the recorded kids and sweep. Checked after
    # wait $_wd too: a marker that lands between the wait and the dog's
    # exit still gets its leg
    sleep 1
    if [ -s "$_kidsfile" ]; then
      while IFS= read -r _k; do
        [ -n "$_k" ] && kill -s KILL "$_k" 2>/dev/null
      done < "$_kidsfile"
    fi
    _kill_tree "$_pid" KILL
  else
    _now=$(date +%s)
    _elapsed=$((_now - BRO_HOOK_T0))
    [ "$_elapsed" -ge "$BRO_HOOK_WATCHDOG_S" ] && { RUN_BOUNDED_EXPIRED=1; bro_hook_kill_journal timeout; }
  fi
  rm -f "$_marker" "$_kidsfile" 2>/dev/null
  return "$_rc"
}

# 1 when a drop in mailbox dir $1 is deliverable to this session —
# the drain's own rules (core/notify.ts): an unexpired regular .txt
# file, non-empty, and either broadcast or addressed to us. The
# .seen-<sid> cursor proves consumption only when EVERY candidate sid
# has it — the payload can carry several session-id-shaped strings and
# the drain consults just the real one's cursor, which we cannot tell
# apart.
mailbox_pending() {
  _mb=$1
  [ -d "$_mb" ] || return 1
  # -mmin -60 mirrors DROP_TTL_MS on mtime — expired drops are reaped
  # by the drain, never delivered, so they cost no spawn here. The read
  # loop must not word-split — a space in the mailbox dir or a drop name
  # would fragment paths and hide a pending drop (under-trigger).
  _hit=$(find "$_mb" -maxdepth 1 -type f -name '*.txt' ! -name '.*' -mmin -60 -print 2>/dev/null | while IFS= read -r _f; do
    _b=${_f##*/}
    _unseen=0
    for _s in ${SIDS:-unknown}; do
      grep -qxF "$_b" "$_mb/.seen-$_s" 2>/dev/null || { _unseen=1; break; }
    done
    [ "$_unseen" = 1 ] || continue
    # an empty drop is consumed silently, never emitted
    [ -s "$_f" ] || continue
    # non-'{'-shaped text drains verbatim → broadcast → ours
    head -c 1 "$_f" 2>/dev/null | grep -q '{' || { echo p; exit 0; }
    # '{'-shaped drops are addressed only as single-line envelopes
    # carrying the contract's required keys — anything else (verbatim
    # text, pretty-printed JSON, a malformed note) drains verbatim to
    # everyone. wc -l counts newlines: 0 = one line, 1 = one line iff
    # that newline is the last byte (an interior newline means a
    # second line of content — doubt delivers)
    _ll=$(wc -l <"$_f" 2>/dev/null)
    [ "$_ll" = 1 ] && [ -z "$(tail -c 1 "$_f" 2>/dev/null)" ] && _ll=0
    [ "$_ll" = 0 ] || { echo p; exit 0; }
    grep -qE '"topic"[[:space:]]*:' "$_f" || { echo p; exit 0; }
    grep -qE '"kind"[[:space:]]*:' "$_f" || { echo p; exit 0; }
    grep -qE '"to"[[:space:]]*:' "$_f" || { echo p; exit 0; }
    # addressed-looking — every string recipient must be provably
    # foreign before the drop stops mattering; a "to" no extraction
    # covers (non-string, empty, nested-only) is doubt, and doubt
    # delivers. Ours = a candidate sid, $BRO_AGENT_ID, or the reserved
    # 'orchestrator' role a session with no agent id answers to —
    # addressedTo() in core/notify.ts.
    _nk=$(grep -oE '"to"[[:space:]]*:' "$_f" | wc -l)
    _to=$(grep -oE '"to"[[:space:]]*:[[:space:]]*"[^"]+"' "$_f" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | grep .)
    [ -n "$_to" ] || { echo p; exit 0; }
    [ "$(printf '%s\n' "$_to" | wc -l)" -lt "$_nk" ] && { echo p; exit 0; }
    _ours=0
    # line-wise — a recipient may itself contain spaces; word-splitting
    # would compare fragments and misread "my agent" as foreign
    while IFS= read -r _t; do
      [ -n "$_t" ] || continue
      # an escaped recipient (\uXXXX, \/) can't be compared raw — doubt
      # delivers; otherwise compare the sanitized form, the same
      # normalize addressedTo's caller-side identity goes through
      case "$_t" in *\\*) _ours=1; break ;; *) ;; esac
      _tn=$(printf %s "$_t" | sed 's/[^A-Za-z0-9_.-]/_/g')
      for _s in $SIDS; do
        [ "$_tn" = "$_s" ] && { _ours=1; break 2; }
      done
      if [ -n "${BRO_AGENT_ID:-}" ]; then
        [ "$_t" = "$BRO_AGENT_ID" ] && { _ours=1; break; }
      else
        [ "$_t" = orchestrator ] && { _ours=1; break; }
      fi
    done <<EOF
$_to
EOF
    [ "$_ours" = 1 ] && { echo p; exit 0; }
    # every extracted recipient is foreign — stays pending for them
  done)
  [ -n "$_hit" ]
}

# This process's topmost agent-shaped ancestor pid — mirrors
# procAgentRoot (proc-owner.ts): agent-shaped comm, agent argv[1] under
# a launcher, or an env badge per ancestor; topmost match wins, bounded
# at 16. Prints -1 when an agent root exists but the pid cannot be
# proven (env pin, or no /proc — doubt must never disprove), 0 when no
# ancestor is agent-shaped.
agent_root_pid() {
  if [ -n "${BRO_AGENT_ID:-}${AI_AGENT:-}" ]; then
    echo -1; return
  fi
  [ -d /proc ] || { echo -1; return; }
  _p=$PPID _top=0 _d=0
  while [ "${_p:-0}" -gt 1 ] && [ "$_d" -lt 16 ]; do
    _c=$(cat "/proc/$_p/comm" 2>/dev/null) || break
    case "${_c%%.*}" in
      devin|claude|codex|gemini|aider|opencode|amp|omp) _top=$_p ;;
      node|npx|bun|bunx|tsx|uvx|deno)
        _a1=$(tr '\0' '\n' <"/proc/$_p/cmdline" 2>/dev/null | sed -n '2{s|.*/||;s|\..*||;p}')
        case "$_a1" in devin|claude|codex|gemini|aider|opencode|amp|omp) _top=$_p ;; *) ;; esac ;;
      *) ;;
    esac
    tr '\0' '\n' <"/proc/$_p/environ" 2>/dev/null \
      | grep -qE '^(BRO_AGENT_ID|AI_AGENT)=' && _top=$_p
    _p=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$_p/status" 2>/dev/null)
    _d=$((_d + 1))
  done
  echo "$_top"
}

# silence on Cursor's beforeShellExecution is a deny — when no binary
# answered (the watchdog expired the run, or nothing could run), the
# launcher itself emits the no-opinion. Defined beside the spool block
# because the capture-expiry path calls it before the dispatch section.
cursor_permission_ask() {
  [ "$EVENT" = permission ] && [ -n "${CURSOR_PLUGIN_ROOT:-}" ] || return 0
  printf '%s\n' '{"permission":"ask"}'
}

# --- session mode (specs/bro-izpyk.2.md) --------------------------------------
#
# Tier-0 mode check: $XDG_STATE_HOME/bro/sessions/<host>-<sid>.mode —
# line 1 is the mode (observe|plan|code|review|orchestrate). A missing or
# invalid file resolves to `observe` unless a bro.config* names `modes`
# (the cheap probe below defers to Node, which resolves modes.default
# and materializes the file). `observe` keeps the cheap fast path —
# post-tool/prompt-submit run today's could-emit checks, every other
# session event exits before Node entirely — while an ACTIVE mode pays
# the full pipeline on every event. The mode file is the hook-time
# truth; the ledger's mode column is only a projection of it.
#
# HOOK_MODE values: observe | plan | code | review | orchestrate —
# empty means "unresolved": sid-less/host-unknown events and the
# modes.default deferral keep today's unrestricted behavior.
HOOK_MODE=
HOOK_MODE_FILE=
HOOK_INBOX=

# permission_shell_answer — the observe-mode permission answer, mirroring
# hooks.ts emitPermission: a bare `bro`/`bd`/`npx bro…` invocation (no
# shell metacharacters, no package override) approves in the host's
# vocabulary; anything else gets Cursor's `ask` and silence elsewhere —
# identical to the non-match outcome the Node path produces today.
permission_self_tool() {
  # $1 = the tool_input.command string. Metacharacters veto outright —
  # a chained/piped/redirected command is never a self-tool call.
  printf '%s' "$1" | grep -qE '[;&|`$()<>\\]' && return 1
  _t=$(printf '%s' "$1" | sed 's/^[[:space:]]*//')
  case "$_t" in
    bro|bd|bro[[:space:]]*|bd[[:space:]]*) return 0 ;;
    npx|npx[[:space:]]*) ;;
    *) return 1 ;;
  esac
  # npx form — a package selector anywhere vetoes (JS checks every
  # token); flags between npx and the executable must be the known
  # no-value set, and the first real token must name bro itself.
  printf '%s' "$_t" | grep -qE '(^|[[:space:]])(-p|--package)([[:space:]=]|$)' && return 1
  _self=0; _skip=0
  # set -f: word splitting must not pathname-expand a `*`/`?` token —
  # JS splits on whitespace only
  set -f
  for _w in $_t; do
    [ "$_skip" = 0 ] && { _skip=1; continue; }   # drop the leading npx
    case "$_w" in
      -y|--yes|--no-install|-q|--quiet) continue ;;
      -*) set +f; return 1 ;;
      bro|bro@*|@broject/bro|@broject/bro@*) _self=1; break ;;
      *) break ;;
    esac
  done
  set +f
  [ "$_self" = 1 ]
}

permission_shell_answer() {
  [ "$EVENT" = permission ] || return 0
  # extract tool_input.command — first "command":"…" string, the same
  # grep technique hook_spool_sid uses. JSON escapes (\" \\) make the
  # extraction ambiguous → non-match → today's outcome, never a guess.
  _cmd=$(printf %s "$PAYLOAD" \
    | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
    | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
  # a command carrying a JSON escape extracted ambiguously — treat as
  # non-match (today's outcome) rather than approve a guess
  case "$_cmd" in *\\*) _cmd= ;; esac
  if [ -n "$_cmd" ] && permission_self_tool "$_cmd"; then
    case "$PAYLOAD" in
      *'"turn_id"'*)
        printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
        ;;
      *)
        if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
          printf '%s\n' '{"permission":"allow"}'
        else
          printf '%s\n' '{"decision":"approve"}'
        fi
        ;;
    esac
    hook_spool_end 0 fastpath 2>/dev/null || :
    exit 0
  fi
  # non-match — identical to the Node path's non-answer: cursor must
  # still say `ask` (silence is a deny there); every other host stays
  # silent and pairs the start row like any other fast-path exit.
  cursor_permission_ask
  hook_spool_end 0 fastpath 2>/dev/null || :
  exit 0
}

# --- hook spool (v2) ---------------------------------------------------------
#
# Tier-0 telemetry: every launch appends a start row and exactly one end
# row to $XDG_STATE_HOME/bro/hooks.spool (BRO_HOOK_SPOOL pins the path,
# literal 0 disables). v2 carries the enrichment the machine-wide ledger
# (specs/bro-izpyk.1.1.md) needs — native session id, pid/ppid, adapter
# version, plugin root, launcher — as TSV with cwd LAST so embedded tabs
# survive (readers re-join the tail). Mid-row fields are sanitized of
# tab/newline at compute time; everything here is fail-open — a spool
# problem must never break the hook it guards.
#
# The functions live ABOVE the fast-path case on purpose: post-tool and
# prompt-submit can exit before Node runs, and their fastpath start/end
# pair is exactly the observe-mode signal the ledger exists to see.

HOOK_SPOOL_STARTED=0
HOOK_SPOOL_IDENTITY=0

hook_spool_prepare() {
  [ "${BRO_HOOK_SPOOL:-}" = 0 ] && return 0
  if [ -n "${BRO_HOOK_SPOOL:-}" ]; then
    HOOK_SPOOL=$BRO_HOOK_SPOOL
  elif [ -n "${XDG_STATE_HOME:-}" ]; then
    HOOK_SPOOL=$XDG_STATE_HOME/bro/hooks.spool
  elif [ -n "${HOME:-}" ]; then
    HOOK_SPOOL=$HOME/.local/state/bro/hooks.spool
  else
    # No XDG_STATE_HOME/HOME and no explicit pin — Node resolves the OS
    # home via the passwd db, which the shell cannot (same doubt-defers
    # rule as the mailbox probe above); a guessed root-level path only
    # fails mkdir or lands where the reader never looks. Empty
    # HOOK_SPOOL tells the writers to skip the row.
    HOOK_SPOOL=
    return 0
  fi
  case "$HOOK_SPOOL" in
    */*) HOOK_SPOOL_DIR=${HOOK_SPOOL%/*}; [ -n "$HOOK_SPOOL_DIR" ] || HOOK_SPOOL_DIR=/ ;;
    *) HOOK_SPOOL_DIR=. ;;
  esac
  if [ ! -d "$HOOK_SPOOL_DIR" ]; then
    mkdir -p "$HOOK_SPOOL_DIR" 2>/dev/null || :
  fi
}

# Mid-row TSV fields must not carry tab/newline — octal escapes because
# \t is not portable tr syntax everywhere; one tr per field, run ONCE
# per launch inside hook_spool_identity (values are cached, so start
# and end rows share the sanitized copies). A missing tr (stripped PATH)
# falls back to the raw value — a possibly-dirty field beats an empty
# one that would make the whole row unparseable.
_spool_field() {
  _o=$(printf '%s' "$1" | tr -d '\011\012\015' 2>/dev/null || printf '%s' "$1")
  printf '%s' "$_o"
}

# plugin manifest version — the portable root plugin.json first, then the
# per-adapter manifests; first "version" string wins. Empty when nothing
# resolves (a foreign plugin root, a source checkout without manifests).
hook_spool_adapter() {
  for _f in \
    "$SCRIPT_ROOT/plugin.json" \
    "$SCRIPT_ROOT/.claude-plugin/plugin.json" \
    "$SCRIPT_ROOT/.codex-plugin/plugin.json" \
    "$SCRIPT_ROOT/.cursor-plugin/plugin.json" \
    "$SCRIPT_ROOT/.devin-plugin/plugin.json"; do
    [ -f "$_f" ] || continue
    _v=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_f" 2>/dev/null | head -n 1)
    [ -n "$_v" ] && { _spool_field "$_v"; return 0; }
  done
  return 0
}

# first session_id/conversation_id string in the payload — the same
# identity hooks.ts normalizes to input.session_id. Empty when the event
# carried none (or stdin was never captured).
hook_spool_sid() {
  [ -n "${PAYLOAD:-}" ] || return 0
  _sid=$(printf %s "$PAYLOAD" \
    | grep -oE '"(session_id|conversation_id)"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
    | head -n 1 \
    | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$_sid" ] && _spool_field "$_sid"
  return 0
}

# computed once per launch — every field is env/script/payload state that
# cannot change between the start and end rows of one invocation.
hook_spool_identity() {
  [ "$HOOK_SPOOL_IDENTITY" = 1 ] && return 0
  HOOK_SPOOL_IDENTITY=1
  HOOK_SPOOL_ID=$$-$BRO_HOOK_T0

  # host — env markers first (the *_PLUGIN_ROOT vars each client exports,
  # then *_PROJECT_DIR corroboration), then bare PLUGIN_ROOT which the
  # repo's codex paths already treat as the codex plugin root, then a
  # payload fingerprint only when env detection found nothing.
  HOOK_SPOOL_HOST=unknown
  if [ -n "${CURSOR_PLUGIN_ROOT:-}" ]; then
    HOOK_SPOOL_HOST=cursor
  elif [ -n "${DEVIN_PLUGIN_ROOT:-}" ]; then
    HOOK_SPOOL_HOST=devin
  elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    HOOK_SPOOL_HOST=claude
  elif [ -n "${CURSOR_PROJECT_DIR:-}" ]; then
    HOOK_SPOOL_HOST=cursor
  elif [ -n "${DEVIN_PROJECT_DIR:-}" ]; then
    HOOK_SPOOL_HOST=devin
  elif [ -n "${PLUGIN_ROOT:-}" ]; then
    HOOK_SPOOL_HOST=codex
  else
    case "$PAYLOAD" in
      *'"cursor_version"'*|*'"workspace_roots"'*) HOOK_SPOOL_HOST=cursor ;;
      *'"turn_id"'*) HOOK_SPOOL_HOST=codex ;;
      *) ;;
    esac
  fi

  # launcher — env only, no forks; 'agent' is the bro-spawned badge
  if [ -n "${BRO_AGENT_ID:-}" ]; then
    HOOK_SPOOL_LAUNCHER=agent
  elif [ "${HERDR_ENV:-}" = 1 ] || [ -n "${HERDR_PANE_ID:-}" ]; then
    HOOK_SPOOL_LAUNCHER=herdr
  elif [ -n "${TMUX:-}" ]; then
    HOOK_SPOOL_LAUNCHER=tmux
  elif [ -n "${ZELLIJ:-}" ]; then
    HOOK_SPOOL_LAUNCHER=zellij
  elif [ -n "${STY:-}" ]; then
    HOOK_SPOOL_LAUNCHER=screen
  elif [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
    HOOK_SPOOL_LAUNCHER=ssh
  else
    HOOK_SPOOL_LAUNCHER=interactive
  fi

  HOOK_SPOOL_SID=$(hook_spool_sid)
  HOOK_SPOOL_AGENT=
  [ -n "${BRO_AGENT_ID:-}" ] && HOOK_SPOOL_AGENT=$(_spool_field "$BRO_AGENT_ID")
  HOOK_SPOOL_ADAPTER=$(hook_spool_adapter)
  HOOK_SPOOL_PROOT=$(_spool_field "$SCRIPT_ROOT")
  HOOK_SPOOL_EVENT=$(_spool_field "$EVENT")
}

hook_spool_start() {
  # idempotent — the dispatch paths call this again as a guard, and the
  # early call below already wrote the row for every event
  [ "$HOOK_SPOOL_STARTED" = 1 ] && return 0
  HOOK_SPOOL_STARTED=1
  [ "${BRO_HOOK_SPOOL:-}" = 0 ] && return 0
  hook_spool_prepare
  [ -n "${HOOK_SPOOL:-}" ] || return 0
  hook_spool_identity
  printf 'v2\t%s\tstart\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$BRO_HOOK_T0" "$HOOK_SPOOL_ID" "$HOOK_SPOOL_HOST" "$HOOK_SPOOL_SID" \
    "$HOOK_SPOOL_EVENT" "$$" "$PPID" "$HOOK_SPOOL_AGENT" "$HOOK_SPOOL_ADAPTER" \
    "$HOOK_SPOOL_PROOT" "$HOOK_SPOOL_LAUNCHER" "${PWD:-}" \
    >> "$HOOK_SPOOL" 2>/dev/null || :
  return 0
}

hook_spool_end() {
  [ "${BRO_HOOK_SPOOL:-}" = 0 ] && return 0
  hook_spool_prepare
  [ -n "${HOOK_SPOOL:-}" ] || return 0
  hook_spool_identity
  _hook_spool_ts=$(date +%s 2>/dev/null) || _hook_spool_ts=$BRO_HOOK_T0
  printf 'v2\t%s\tend\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$_hook_spool_ts" "$HOOK_SPOOL_ID" "$HOOK_SPOOL_HOST" "$HOOK_SPOOL_SID" \
    "$HOOK_SPOOL_EVENT" "$$" "$PPID" "$HOOK_SPOOL_AGENT" "$HOOK_SPOOL_ADAPTER" \
    "$HOOK_SPOOL_PROOT" "$HOOK_SPOOL_LAUNCHER" "$1" "$2" "${PWD:-}" \
    >> "$HOOK_SPOOL" 2>/dev/null || :
  return 0
}

# Universal stdin capture — the v2 sid and the fast-path checks both need
# the payload, so stdin is captured once when the spool is on (or the
# event is a fast-path candidate, which needs it regardless of spooling).
# Node still reads identical bytes through CAPTURED/PAYLOAD_FILE. The
# capture rides run_bounded so a never-EOF stdin dies at the same
# watchdog budget the node run would have had — an expired capture means
# the payload never completed: record the launch as a watchdog kill and
# get out of the host's way.
_spool_capture=0
[ "${BRO_HOOK_SPOOL:-}" != 0 ] && _spool_capture=1
case "$EVENT" in
  post-tool|prompt-submit) _spool_capture=1 ;;
esac
if [ "$_spool_capture" = 1 ] && [ ! -t 0 ]; then
  PAYLOAD_FILE=$(mktemp "${TMPDIR:-/tmp}/bro-hook.XXXXXX" 2>/dev/null) || PAYLOAD_FILE=
  if [ -n "$PAYLOAD_FILE" ]; then
    _cap_rc=0
    run_bounded cat > "$PAYLOAD_FILE" || _cap_rc=$?
    if [ "$RUN_BOUNDED_EXPIRED" = 1 ]; then
      hook_spool_start
      hook_spool_end "$_cap_rc" watchdog
      cursor_permission_ask
      exit 0
    fi
    # a short read (cat rc != 0 without expiry) means the payload never
    # completed — the pre-spool contract exits before any candidate can
    # run on bytes it cannot faithfully forward. The launch is still
    # journaled: start + one nonzero end (the worker maps it to the
    # canonical `error`), then out of the host's way.
    if [ "$_cap_rc" != 0 ] || ! PAYLOAD=$(cat "$PAYLOAD_FILE" 2>/dev/null); then
      [ "$_cap_rc" = 0 ] && _cap_rc=1
      hook_spool_start
      hook_spool_end "$_cap_rc" nonzero
      cursor_permission_ask
      exit 0
    fi
    CAPTURED=1
    RUN_BOUNDED_EXPIRED=0
  fi
fi

# the start row lands for EVERY event that reaches this point — including
# the fast-path exits below and every operator/binary path after. Events
# that exited earlier (BRO_HOOKS=0, a project-owned devin hook) were
# never bro launches and write nothing.
hook_spool_start

# --- session mode resolution (Tier-0, specs/bro-izpyk.2.md) -------------------
# The mode file is the hook-time truth hooks.js also reads — resolving it
# here lets observe sessions skip Node on events that cannot emit, and
# lets active modes skip the could-emit fast path entirely. Everything
# fails open: an unreadable state dir, a missing HOME, a garbage mode
# file all resolve to observe/unrestricted, never a blocked hook.
if [ -n "${HOOK_SPOOL_HOST:-}" ] && [ "$HOOK_SPOOL_HOST" != "unknown" ] \
   && [ -n "${HOOK_SPOOL_SID:-}" ]; then
  if [ -n "${XDG_STATE_HOME:-}" ]; then
    _bro_state=$XDG_STATE_HOME/bro
  elif [ -n "${HOME:-}" ]; then
    _bro_state=$HOME/.local/state/bro
  else
    _bro_state=
  fi
  if [ -n "$_bro_state" ]; then
    _msid=$(printf '%s' "$HOOK_SPOOL_SID" | sed 's/[^A-Za-z0-9_.-]/_/g')
    HOOK_MODE_FILE=$_bro_state/sessions/$HOOK_SPOOL_HOST-$_msid.mode
    HOOK_INBOX=$_bro_state/inbox/$HOOK_SPOOL_HOST-$_msid
    if [ -f "$HOOK_MODE_FILE" ]; then
      _m=$(sed -n '1{s/^[[:space:]]*//;s/[[:space:]]*$//;p;q}' "$HOOK_MODE_FILE" 2>/dev/null)
      case "$_m" in
        observe|plan|code|review|orchestrate) HOOK_MODE=$_m ;;
        *) HOOK_MODE=observe ;;   # invalid content → observe, fail-open
      esac
    else
      # no file → modes.default probe: the four project config names at
      # the session base (plus its main worktree root when resolvable
      # cheaply) and the two global names; any containing the word
      # `modes` defers to Node — hooks.js resolves the section,
      # materializes the file, and updates the ledger. HOOK_MODE stays
      # empty = unrestricted = today's behavior until the file exists.
      _mdirs=$PWD
      _mgit=$(git -C "$PWD" rev-parse --git-common-dir 2>/dev/null | sed -n 1p)
      case "$_mgit" in
        /*) _mroot=${_mgit%/*} ;;
        ?*) _mroot=$PWD/$_mgit; _mroot=${_mroot%/*} ;;
        *)  _mroot= ;;
      esac
      [ -n "$_mroot" ] && [ "$_mroot" != "$PWD" ] && _mdirs="$_mdirs
$_mroot"
      _mfound=
      while IFS= read -r _md; do
        [ -n "$_md" ] || continue
        for _mn in bro.config.ts bro.config.json bro.config.local.ts bro.config.local.json; do
          [ -f "$_md/$_mn" ] || continue
          grep -qE '(^|[^[:alnum:]_])modes([^[:alnum:]_]|$)' "$_md/$_mn" 2>/dev/null && _mfound=1 && break 2
        done
      done <<EOF
$_mdirs
EOF
      if [ -z "$_mfound" ]; then
        for _mn in config.ts config.json; do
          _mg="${XDG_CONFIG_HOME:-${HOME:-}/.config}/bro/$_mn"
          [ -f "$_mg" ] || continue
          grep -qE '(^|[^[:alnum:]_])modes([^[:alnum:]_]|$)' "$_mg" 2>/dev/null && _mfound=1 && break
        done
      fi
      [ -n "$_mfound" ] || HOOK_MODE=observe
    fi
  fi
fi

case "$EVENT" in
post-tool|prompt-submit)
  # same base the hook resolves for non-cursor hosts
  BASE=${DEVIN_PROJECT_DIR:-$PWD}
  NEED_NODE=
  # the payload was captured above — CAPTURED=0 means stdin was a tty,
  # the spool+mktemp both failed, or this event never needed one: no
  # payload to inspect, so the checks cannot prove a no-op → defer
  [ "$CAPTURED" = 1 ] || NEED_NODE=1

  # an ACTIVE session mode always reaches Node — the could-emit checks
  # below are the observe/unrestricted fast path only (specs/bro-izpyk.2.md)
  case "$HOOK_MODE" in
    observe|'') ;;
    *) NEED_NODE=1 ;;
  esac

  # foreign-schema payload — cursor/codex need schema translation, the
  # hydrate leg, and CURSOR_PROJECT_DIR/workspace_roots resolution;
  # never fast-pathed. Checked BEFORE the opt-in walk: a cursor payload
  # names its project in fields the walk cannot see, so exiting on the
  # cwd's opt-in would drop real hook work.
  case "$PAYLOAD" in
    *'"cursor_version"'*|*'"hook_event_name"'*|*'"turn_id"'*|*'"workspace_roots"'*) NEED_NODE=1 ;;
    *) ;;
  esac

  # the repo opt-in gate (core's repoOptedIn — `bro hooks` exits
  # silent on it, so this is exact parity, not an approximation): any
  # bro.config*/.beads walking up from the base, else nothing emits
  if [ -z "$NEED_NODE" ]; then
    _opted=0
    _d=$BASE
    while :; do
      for _n in bro.config.ts bro.config.json bro.config.local.ts bro.config.local.json .beads; do
        [ -e "$_d/$_n" ] && { _opted=1; break; }
      done
      [ "$_opted" = 1 ] && break
      [ "$_d" = / ] && break
      _p=${_d%/*}; [ -z "$_p" ] && _p=/
      [ "$_p" = "$_d" ] && break
      _d=$_p
    done
    if [ "$_opted" = 0 ]; then
      # resolved to a shell no-op on a repo with no bro opt-in — pair
      # the start row like the fastpath exit below so the launch does
      # not read as a host kill in the spool
      hook_spool_end 0 fastpath
      exit 0
    fi
  fi

  # session-id candidates — every value offered, sanitized the same
  # way markerPath()/seenPath() do ([^\w.-] → _). None extractable is
  # not "no session": a missed extraction would skip marker checks the
  # real sid would have failed, so sid-less payloads defer entirely.
  # A raw value still carrying a JSON escape (\uXXXX, \/) sanitizes to
  # a different marker name than Node's decoded sid — doubt defers.
  _raw_sids=$(printf %s "$PAYLOAD" | grep -oE '"(session_id|conversation_id)"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' | sort -u)
  case "$_raw_sids" in *\\*) NEED_NODE=1 ;; *) ;; esac
  SIDS=$(printf %s "$_raw_sids" | sed 's/[^A-Za-z0-9_.-]/_/g')
  [ -z "$SIDS" ] && NEED_NODE=1

  # payload content that names work: supersets of the real classifiers —
  # a string that merely contains the tokens defers to Node, where
  # command-position parsing decides. The [^;&|]* window is unbounded —
  # classifyArmCommand accepts flags of any length between binary and
  # subcommand. False positives are the safe side.
  if [ -z "$NEED_NODE" ]; then
    _W='[^[:alnum:]_-]'
    if [ "$EVENT" = post-tool ]; then
      printf %s "$PAYLOAD" | grep -qE \
        -e "(^|$_W)(bro|npx)($_W|$)[^;&|]*(act|drill|wtf|work|retrospect|debt|convoy|spec|next|loop|sync|unwind)" \
        -e "(^|$_W)gh($_W|$)[^;&|]*pr($_W|$)" \
        -e "(^|$_W)git($_W|$)[^;&|]*(push|worktree)($_W|$)" \
        -e "(^|$_W)bd($_W|$)[^;&|]*(--claim|worktree($_W|$))" \
        && NEED_NODE=1
    else
      printf %s "$PAYLOAD" | grep -qE 'pull/[0-9]|[Mm][Ee][Rr][Gg][Ee]_[Rr][Ee][Qq][Uu][Ee][Ss][Tt][Ss]/[0-9]' && NEED_NODE=1
    fi
  fi

  # the user-level mailbox drains even outside a repo — git-independent.
  # With neither XDG_STATE_HOME nor HOME set Node still resolves the OS
  # home; the shell cannot — doubt defers.
  if [ -z "$NEED_NODE" ]; then
    if [ -n "${XDG_STATE_HOME:-}${HOME:-}" ]; then
      mailbox_pending "${XDG_STATE_HOME:-$HOME/.local/state}/bro/notify" && NEED_NODE=1
    else
      NEED_NODE=1
    fi
  fi

  # git-dir state — without a common dir Node resolves hooksDir/
  # mailboxDir/beadsDir to null in the same spots, so the checks below
  # can only fail the same way: nothing there exists to miss.
  # GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR are unset the same way core's
  # repoEnv() strips them for `-C` calls — an inherited pin would
  # silently retarget the probe at the parent's repository.
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR
  COMMON=$(git -C "$BASE" rev-parse --git-common-dir 2>/dev/null | sed -n 1p)
  case "$COMMON" in
    /*) ;;
    ?*) COMMON=$BASE/$COMMON ;;
    *)  COMMON= ;;
  esac

  # config files node would merge (loadConfigLayers): project + local
  # at the base and the main worktree root, plus the global user layer.
  # Newline-separated — a checkout path may contain spaces.
  CFGS=
  _dirs=$BASE
  [ -n "$COMMON" ] && _dirs="$_dirs
${COMMON%/*}"
  while IFS= read -r _d; do
    for _n in bro.config.ts bro.config.json bro.config.local.ts bro.config.local.json; do
      [ -f "$_d/$_n" ] && CFGS="$CFGS$_d/$_n
"
    done
  done <<EOF
$_dirs
EOF
  for _n in config.ts config.json; do
    _g="${XDG_CONFIG_HOME:-${HOME:-}/.config}/bro/$_n"
    [ -f "$_g" ] && CFGS="$CFGS$_g
"
  done

  # 0 when ERE $1 matches any config file
  cfg_grep() {
    while IFS= read -r _f; do
      [ -n "$_f" ] || continue
      grep -qE -- "$1" "$_f" 2>/dev/null && return 0
    done <<EOF
$CFGS
EOF
    return 1
  }

  if [ -z "$NEED_NODE" ] && [ -n "$COMMON" ]; then
    BRODIR=$COMMON/bro
    HOOKS=$BRODIR/hooks

    mailbox_pending "$BRODIR/notify" && NEED_NODE=1

    # orchestrator want-markers — a dead pulse/drive/loop/rig gets
    # respawned by the post-tool checkpoint; workers (BRO_AGENT_ID)
    # never rearm. loop.json belongs: a repo armed only by
    # `bro loop install` has no drive.json, and without it here the
    # fast path would exit 0 before the checkpoint could ever run
    if [ -z "$NEED_NODE" ] && [ "$EVENT" = post-tool ] && [ -z "${BRO_AGENT_ID:-}" ]; then
      if [ -f "$BRODIR/pulse.json" ] || [ -f "$BRODIR/rig-pulse.json" ] || [ -f "$BRODIR/drive.json" ] || [ -f "$BRODIR/loop.json" ]; then
        NEED_NODE=1
      fi
    fi

    # bead-store barometer — lessons and open drill frames are bead
    # rows; the probes cache their answers as stamp-keyed snapshots
    # under cache/, and a dolt manifest newer than a snapshot is the
    # write signal. `.beads` present without any manifest is a store
    # the snapshots can't key on — the probes read it live, so the
    # fast path defers.
    if [ -z "$NEED_NODE" ]; then
      _learn_off=0
      # `learn: {…enabled:false}` — the brace-boundary keeps another
      # section's enabled:false from masquerading as learn's opt-out;
      # anything ambiguous just scans the store
      cfg_grep '"?learn"?[[:space:]]*:[[:space:]]*{[^}]*"?enabled"?[[:space:]]*:[[:space:]]*false' && _learn_off=1
      _beads=
      [ -n "${BEADS_DIR:-}" ] && [ -d "$BEADS_DIR" ] && _beads=$BEADS_DIR
      [ -d "${COMMON%/*}/.beads" ] && _beads="$_beads
${COMMON%/*}/.beads"
      _w=$BASE
      while [ -n "$_w" ] && [ "$_w" != / ]; do
        [ -d "$_w/.beads" ] && _beads="$_beads
$_w/.beads"
        _p=${_w%/*}
        [ "$_p" = "$_w" ] && break
        _w=$_p
      done
      _manifest=0
      while IFS= read -r _b; do
        [ -n "$_b" ] || continue
        for _m in "$_b"/embeddeddolt/*/.dolt/noms/manifest "$_b"/dolt/*/.dolt/noms/manifest; do
          [ -f "$_m" ] && _manifest=1 && break
        done
      done <<EOF
$_beads
EOF
      [ -n "$_beads" ] && [ "$_manifest" = 0 ] && NEED_NODE=1

      # 1 when snapshot file $1 provably keys to the CURRENT store —
      # the probe stamps each snapshot with beadsStoreStamp()
      # (<beads>|<root>/<db>:<mtimeMs>:<size>|…), so a snapshot taken
      # against another BEADS_DIR or an older manifest set can't pass
      # for fresh. ms↔s gets a 1s tolerance; size is exact — doubt
      # (missing stat, torn field) counts as stale.
      _snap_fresh() {
        _st=$(sed -n 's/.*"stamp"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null)
        [ -n "$_st" ] || return 1
        _sb=${_st%%|*}
        [ "$_sb" = "$_st" ] && return 1
        while IFS= read -r _b; do
          [ -n "$_b" ] && [ "$_b" = "$_sb" ] && break
        done <<EOF
$_beads
EOF
        [ "$_b" = "$_sb" ] || return 1
        _rest=${_st#*|}
        while [ -n "$_rest" ]; do
          _seg=${_rest%%|*}
          [ "$_rest" = "$_seg" ] && _rest= || _rest=${_rest#*|}
          _db=${_seg%%:*}
          _ms=${_seg#*:}; _ms=${_ms%%:*}
          _sz=${_seg##*:}
          _f="$_sb/$_db/.dolt/noms/manifest"
          [ -f "$_f" ] || return 1
          _ys=$(stat -c %Y "$_f" 2>/dev/null || stat -f %m "$_f" 2>/dev/null) || return 1
          _ss=$(stat -c %s "$_f" 2>/dev/null || stat -f %z "$_f" 2>/dev/null) || return 1
          _sec=${_ms%%.*}
          _d=$((_sec - _ys)); [ "$_d" -lt 0 ] && _d=$((-_d))
          [ "$_d" -gt 1 ] && return 1
          [ "$_ss" = "$_sz" ] || return 1
        done
        return 0
      }

      # lessons — a fresh [] snapshot keyed to this store is the only
      # "no lessons" proof
      if [ -z "$NEED_NODE" ] && [ "$_learn_off" = 0 ]; then
        SNAP=$HOOKS/cache/lessons.json
        if [ -f "$SNAP" ]; then
          grep -q '"lessons"[[:space:]]*:[[:space:]]*\[\]' "$SNAP" || NEED_NODE=1
          if [ -z "$NEED_NODE" ]; then
            _snap_fresh "$SNAP" || NEED_NODE=1
          fi
        elif [ "$_manifest" = 1 ]; then
          NEED_NODE=1
        fi
      fi

      # open drill frames nudge every session's prompt-submit — a
      # fresh null snapshot keyed to this store is the only proof
      if [ -z "$NEED_NODE" ] && [ "$EVENT" = prompt-submit ]; then
        SNAP=$HOOKS/cache/drills.json
        if [ -f "$SNAP" ]; then
          grep -q '"frame"[[:space:]]*:[[:space:]]*null' "$SNAP" || NEED_NODE=1
          if [ -z "$NEED_NODE" ]; then
            _snap_fresh "$SNAP" || NEED_NODE=1
          fi
        elif [ "$_manifest" = 1 ]; then
          NEED_NODE=1
        fi
      fi
    fi

    # guard defs for this event — the hook records resolved presence
    # itself (connector guards() and computed defs are invisible to a
    # config grep): .stamp is the freshness anchor, guards/<event>
    # exists while a collected def targets that event, and .trace marks
    # a def whose match clause reads the session trace — post-tool must
    # then reach Node so the journal it evaluates stays complete.
    if [ -z "$NEED_NODE" ]; then
      GUARDSD=$HOOKS/guards
      if [ ! -f "$GUARDSD/.stamp" ]; then
        NEED_NODE=1
      else
        while IFS= read -r _c; do
          [ -n "$_c" ] && [ "$_c" -nt "$GUARDSD/.stamp" ] && NEED_NODE=1 && break
        done <<EOF
$CFGS
EOF
        # the stamp's own body lists covered events (written atomically)
        # — checked alongside the per-event files so a concurrent prune
        # can only over-trigger, never hide a def
        if [ -z "$NEED_NODE" ]; then
          { [ -f "$GUARDSD/$EVENT" ] || grep -qx "$EVENT" "$GUARDSD/.stamp" 2>/dev/null; } && NEED_NODE=1
        fi
        if [ -z "$NEED_NODE" ] && [ "$EVENT" = post-tool ]; then
          { [ -f "$GUARDSD/.trace" ] || grep -qx '\.trace' "$GUARDSD/.stamp" 2>/dev/null; } && NEED_NODE=1
        fi
      fi
    fi

    # config shapes a grep can't evaluate defer — a TypeScript config
    # that imports, computes, or reads env can change guard defs, sdd,
    # or telemetry behind an unchanged file, and a non-empty plugins
    # section registers connectors whose probes the fast path cannot
    # see. Static literal configs keep the fast path.
    if [ -z "$NEED_NODE" ]; then
      while IFS= read -r _c; do
        [ -n "$_c" ] || continue
        case "$_c" in
          *.ts) grep -qE '(^|[^[:alnum:]_])(import|require|process\.env|=>|\|\||&&)' "$_c" 2>/dev/null && NEED_NODE=1 && break ;;
          *) ;;
        esac
      done <<EOF
$CFGS
EOF
      if [ -z "$NEED_NODE" ] && cfg_grep '"?plugins"?[[:space:]]*:' \
                             && ! cfg_grep '"?plugins"?[[:space:]]*:[[:space:]]*\[[[:space:]]*\]'; then
        NEED_NODE=1
      fi
    fi

    # telemetry — the post-tool flush spawns only with an OTLP endpoint
    if [ -z "$NEED_NODE" ] && [ "$EVENT" = post-tool ] && [ "${BRO_TELEMETRY:-}" != "0" ]; then
      if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}" ]; then
        NEED_NODE=1
      elif cfg_grep 'telemetry|otlp'; then
        NEED_NODE=1
      fi
    fi

    # sdd nudge — a claimed bead without a spec is reminded on every
    # prompt while sdd is enabled. Claims live in <sid>.task markers:
    # this session's own, plus foreign markers stamped by this tree's
    # agent root — ownerTaskClaims folds those in (a restart's stale
    # sid, bro-7022c). agent_root_pid mirrors the /proc scan; -1 means
    # agent-shaped but unproven pid — any .task then defers, the safe
    # side. Markers under other aspects (act/drill/work) feed only the
    # stop gate, which is never fast-pathed.
    if [ -z "$NEED_NODE" ] && [ "$EVENT" = prompt-submit ] && cfg_grep 'sdd'; then
      for _s in $SIDS; do
        [ -f "$HOOKS/$_s.task" ] && { NEED_NODE=1; break; }
      done
      if [ -z "$NEED_NODE" ]; then
        _root=$(agent_root_pid)
        if [ "$_root" != 0 ]; then
          for _f in "$HOOKS"/*.task; do
            [ -f "$_f" ] || continue
            if [ "$_root" = -1 ]; then
              NEED_NODE=1; break
            fi
            # marker line 1 is `<millis> [pid start]` — the fold needs
            # the stamped owner to be this root; pid alone suffices
            # (reuse only ever over-triggers)
            _o=$(sed -n '1s/^[0-9]*[[:space:]][[:space:]]*\([0-9]*\).*/\1/p' "$_f")
            [ -n "$_o" ] && [ "$_o" = "$_root" ] && { NEED_NODE=1; break; }
          done
        fi
      fi
    fi
  fi

  # sdd claims can also ride env pins — git-independent
  if [ -z "$NEED_NODE" ] && [ "$EVENT" = prompt-submit ] && \
     [ -n "${BRO_BEAD_ID:-}${BRO_BEAD_IDS:-}" ] && cfg_grep 'sdd'; then
    NEED_NODE=1
  fi

  # `bro mode <name>` typed into the session binds through the post-tool
  # hook — a fast-path exit would swallow the write, so the command
  # itself forces Node (specs/bro-izpyk.2.md). Only the tool_input.command
  # field is scanned (prompt text mentioning "bro mode" must not pay
  # Node); Node's parseModeCommand does the real parse — a false
  # positive here just runs the hook it would have run anyway.
  if [ -z "$NEED_NODE" ]; then
    _mode_cmd=$(printf %s "$PAYLOAD" \
      | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
      | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')
    case "$_mode_cmd" in *\\*) _mode_cmd= ;; esac
    [ -n "$_mode_cmd" ] \
      && printf %s "$_mode_cmd" \
        | grep -qE '(^|[^[:alnum:]_-])bro([[:space:]]+[^[:space:];&|`$()<>\\]+)*[[:space:]]+mode([[:space:]]|$)' \
      && NEED_NODE=1
  fi

  # the F4 per-session inbox drop wakes the session — non-empty means
  # Node must run so the drain delivers (F2 only wires the wake)
  if [ -z "$NEED_NODE" ] && [ -n "$HOOK_INBOX" ] && [ -s "$HOOK_INBOX" ]; then
    NEED_NODE=1
  fi

  if [ -z "$NEED_NODE" ]; then
    # resolved to a shell no-op — still a firing: pair the start row so
    # observe-mode volume reaches the ledger instead of looking like a
    # host kill
    hook_spool_end 0 fastpath
    exit 0
  fi
  ;;
session-start|post-compaction|pre-compact|stop)
  # observe is fully passive (specs/bro-izpyk.2.md): no rehydration, no
  # goal reminder, no stop gates — these events cannot emit anything a
  # passive session needs, so they never pay Node. An inbox drop or a
  # pending user-level mailbox message falls through to Node instead.
  # pre-tool is deliberately absent: the safety vetoes (session-cap)
  # stay live in every mode. Unresolved modes ('' = sid-less, host-
  # unknown, or a modes.default deferral) keep today's Node path.
  if [ "$HOOK_MODE" = observe ]; then
    if [ -n "$HOOK_INBOX" ] && [ -s "$HOOK_INBOX" ]; then
      : # inbox drop — Node drains it
    elif [ -n "${XDG_STATE_HOME:-}${HOME:-}" ] \
         && mailbox_pending "${XDG_STATE_HOME:-$HOME/.local/state}/bro/notify"; then
      : # user-level mailbox has mail — Node drains it
    else
      hook_spool_end 0 fastpath
      cursor_permission_ask
      exit 0
    fi
  fi
  ;;
permission)
  # observe answers in Tier-0 (specs/bro-izpyk.2.md): the conservative
  # self-tool approve / cursor ask / silence triple mirrors emitPermission
  # without Node. Every other mode reaches Node unchanged — including
  # the session-cap refusal the permission path carries for pre-tool-
  # less hosts.
  if [ "$HOOK_MODE" = observe ]; then
    permission_shell_answer
  fi
  ;;
*) ;;
esac

# each client exports its own plugin-root var — take whichever exists
# (Cursor, Devin, Claude, or the generic PLUGIN_ROOT).
# a relative or nonexistent root is untrusted input: canonicalize an
# absolute root, and fall back to this script's own dir otherwise so the
# walk-up can't wander off CWD and execute an unrelated dist.
ROOT="${PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${DEVIN_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}}"
case "$ROOT" in
  /*) ROOT="$(CDPATH='' cd -- "$ROOT" 2>/dev/null && pwd)" ;;
  *)  ROOT= ;;
esac
[ -n "$ROOT" ] || ROOT="$SCRIPT_ROOT"

# walk up for a built CLI — adapter dirs live below the repo root.
# break on the fixed point so a relative/malformed root can't spin.
DIR="$ROOT"
while [ ! -f "$DIR/packages/cli/dist/index.js" ]; do
  PARENT="$(dirname -- "$DIR")"
  [ "$PARENT" = "$DIR" ] && break
  DIR="$PARENT"
done

# Resolve `bro` on PATH to the slim hooks entry beside its dist/index.js
# — npm links the bin at <pkg>/dist/index.js, so hooks.js is its sibling
# (specs/bro-36sx7.7.md). A shim that doesn't resolve to a dist file (a
# wrapper script, a different layout) or a dist built before hooks.js
# existed prints nothing and the caller falls back to `bro hooks`.
bro_hooks_js() {
  _b=$(command -v bro 2>/dev/null) || return 1
  # a bare name means a function/builtin, not a PATH file — only a
  # resolved path can point into a package dist
  case "$_b" in
    */*) ;;
    *) return 1 ;;
  esac
  # chase the symlink chain — npm .bin entries link into the package;
  # plain `readlink` is POSIX (no -f, which macOS lacks). Bounded so a
  # link cycle can't spin the launcher — 40 is generous: npm link
  # chains run single digits, and a deeper chain is pathological, not
  # a layout to support.
  _n=0
  while [ -L "$_b" ] && [ "$_n" -lt 40 ]; do
    _n=$((_n + 1))
    _l=$(readlink "$_b" 2>/dev/null) || return 1
    case "$_l" in
      /*) _b=$_l ;;
      *)  _b=$(dirname -- "$_b")/$_l ;;
    esac
  done
  [ -L "$_b" ] && return 1
  case "$_b" in
    */dist/index.js) ;;
    *) return 1 ;;
  esac
  _h=${_b%/index.js}/hooks.js
  [ -f "$_h" ] || return 1
  printf '%s\n' "$_h"
}

# _cli_ran marks that a binary branch actually executed — the start row
# now lands for every event before dispatch, so HOOK_SPOOL_STARTED can
# no longer stand in for "something ran" in the no-binary else below
_cli_ran=
if [ -f "$DIR/packages/cli/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  _rc=0
  _cli_ran=1
  hook_spool_start
  # prefer the slim hooks entry — same dispatch minus the PLUGINS
  # registry cold-load; a dist built before it existed falls back to
  # the full CLI spelling
  if [ -f "$DIR/packages/cli/dist/hooks.js" ]; then
    run_bounded node "$DIR/packages/cli/dist/hooks.js" "$@" || _rc=$?
  else
    run_bounded node "$DIR/packages/cli/dist/index.js" hooks "$@" || _rc=$?
  fi
  # BRO_HOOKS_NO_FALLBACK=1 — the latency bench pins it so the in-tree
  # dist result IS the measurement: a nonzero exit or an expired
  # deadline is the error, never a PATH-bro swap. Never set it on a
  # live session: it weakens the fail-open contract. The end row still
  # lands — a pinned exit without it reads as a host kill in the spool.
  if [ "${BRO_HOOKS_NO_FALLBACK:-}" = "1" ]; then
    if [ "$RUN_BOUNDED_EXPIRED" = 1 ]; then
      hook_spool_end "$_rc" watchdog
      exit 1
    fi
    if [ "$_rc" -ne 0 ]; then
      hook_spool_end "$_rc" nonzero
      exit 1
    fi
    hook_spool_end "$_rc" ok
    exit 0
  fi
  if [ "$RUN_BOUNDED_EXPIRED" = 1 ]; then
    hook_spool_end "$_rc" watchdog
    cursor_permission_ask
    exit 0
  fi
  if [ "$_rc" -eq 0 ]; then
    hook_spool_end "$_rc" ok
    exit 0
  fi
fi
# same pin when dist or node is missing — the PATH fallback must not
# hide it either. Reaching here means the dist branch never ran (its
# own NO_FALLBACK exits all write an end row), so nothing executed —
# pair the early start as no-cli rather than leaving a synthetic kill.
if [ "${BRO_HOOKS_NO_FALLBACK:-}" = "1" ]; then
  hook_spool_end 0 no-cli
  exit 1
fi
if command -v bro >/dev/null 2>&1; then
  _rc=0
  _cli_ran=1
  [ "$HOOK_SPOOL_STARTED" = 1 ] || hook_spool_start
  # the resolved bro bin's own dist/hooks.js is the same slim entry the
  # repo-dist branch prefers — published installs reach it here, where
  # no packages/cli/dist exists under the plugin root
  _hooks_js=$(bro_hooks_js)
  if [ -n "$_hooks_js" ] && command -v node >/dev/null 2>&1; then
    run_bounded node "$_hooks_js" "$@" || _rc=$?
  else
    run_bounded bro hooks "$@" || _rc=$?
  fi
  # run_bounded already journaled the kill into killed.jsonl — the
  # spool end rows here are the start/end pairing, not a second kill
  # row (kody: two killed.jsonl rows per kill)
  if [ "$RUN_BOUNDED_EXPIRED" = 1 ]; then
    hook_spool_end "$_rc" watchdog
    cursor_permission_ask
    exit 0
  fi
  if [ "$_rc" -eq 0 ]; then
    hook_spool_end "$_rc" ok
  else
    hook_spool_end "$_rc" nonzero
  fi
else
  if [ -n "$_cli_ran" ]; then
    hook_spool_end "${_rc:-1}" nonzero
  else
    hook_spool_end 0 no-cli
  fi
  cursor_permission_ask
fi
exit 0
