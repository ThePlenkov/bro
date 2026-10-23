#!/bin/sh
# Plugin hook launcher — resolves bro without depending on PATH:
#   1. built dist reachable from this checkout (local/dev installs — the
#      plugin's own code, so hook behavior tracks the checkout; found by
#      walking up from the plugin dir so adapters under plugins/<c>/bro/
#      resolve the repo root too)
#   2. `bro` on PATH — but only if it actually has the hooks subcommand
#      (`bro hooks` with no event is a silent no-op; an older bro fails
#      the probe instead of failing every hook)
#   3. published package via npx, pinned to the plugin's own version
#      (gen:plugins keeps it in sync with plugin.json)
#
# Fail-open contract: nothing here may stall or fail the session —
# commands run (not exec'd), a failed candidate falls through to the
# next, and the script always exits 0.
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

CAPTURED=0
PAYLOAD=
EVENT=${1:-}

# feed the (possibly captured) hook payload to whichever binary runs —
# the fast-path events re-read stdin, so it is replayed instead of the
# original fd
run_hook() {
  if [ "$CAPTURED" = 1 ]; then printf %s "$PAYLOAD" | "$@"; else "$@"; fi
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
  # by the drain, never delivered, so they cost no spawn here
  for _f in $(find "$_mb" -maxdepth 1 -type f -name '*.txt' ! -name '.*' -mmin -60 2>/dev/null); do
    _b=${_f##*/}
    _unseen=0
    for _s in ${SIDS:-unknown}; do
      grep -qxF "$_b" "$_mb/.seen-$_s" 2>/dev/null || { _unseen=1; break; }
    done
    [ "$_unseen" = 1 ] || continue
    # an empty drop is consumed silently, never emitted
    [ -s "$_f" ] || continue
    # non-'{'-shaped text drains verbatim → broadcast → ours
    head -c 1 "$_f" 2>/dev/null | grep -q '{' || return 0
    # '{'-shaped drops are addressed only as single-line envelopes
    # carrying the contract's required keys — anything else (verbatim
    # text, pretty-printed JSON, a malformed note) drains verbatim to
    # everyone
    [ "$(wc -l <"$_f" 2>/dev/null)" = 0 ] || return 0
    grep -qE '"topic"[[:space:]]*:' "$_f" || return 0
    grep -qE '"kind"[[:space:]]*:' "$_f" || return 0
    grep -qE '"to"[[:space:]]*:' "$_f" || return 0
    # addressed-looking — every string recipient must be provably
    # foreign before the drop stops mattering; a "to" no extraction
    # covers (non-string, empty, nested-only) is doubt, and doubt
    # delivers. Ours = a candidate sid, $BRO_AGENT_ID, or the reserved
    # 'orchestrator' role a session with no agent id answers to —
    # addressedTo() in core/notify.ts.
    _nk=$(grep -oE '"to"[[:space:]]*:' "$_f" | wc -l)
    _to=$(grep -oE '"to"[[:space:]]*:[[:space:]]*"[^"]+"' "$_f" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/' | grep .)
    [ -n "$_to" ] || return 0
    [ "$(printf '%s\n' "$_to" | wc -l)" -lt "$_nk" ] && return 0
    _ours=0
    for _t in $_to; do
      for _s in $SIDS; do
        [ "$_t" = "$_s" ] && { _ours=1; break 2; }
      done
      if [ -n "${BRO_AGENT_ID:-}" ]; then
        [ "$_t" = "$BRO_AGENT_ID" ] && { _ours=1; break; }
      else
        [ "$_t" = orchestrator ] && { _ours=1; break; }
      fi
    done
    [ "$_ours" = 1 ] && return 0
    # every extracted recipient is foreign — stays pending for them
  done
  return 1
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
      devin|claude|codex|gemini|aider|opencode|amp) _top=$_p ;;
      node|npx|bun|bunx|tsx|uvx|deno)
        _a1=$(tr '\0' '\n' <"/proc/$_p/cmdline" 2>/dev/null | sed -n '2{s|.*/||;s|\..*||;p}')
        case "$_a1" in devin|claude|codex|gemini|aider|opencode|amp) _top=$_p ;; esac ;;
    esac
    tr '\0' '\n' <"/proc/$_p/environ" 2>/dev/null \
      | grep -qE '^(BRO_AGENT_ID|AI_AGENT)=' && _top=$_p
    _p=$(sed -n 's/^PPid:[[:space:]]*//p' "/proc/$_p/status" 2>/dev/null)
    _d=$((_d + 1))
  done
  echo "$_top"
}

case "$EVENT" in
post-tool|prompt-submit)
  PAYLOAD=$(cat)
  CAPTURED=1
  # same base the hook resolves for non-cursor hosts
  BASE=${DEVIN_PROJECT_DIR:-$PWD}
  NEED_NODE=

  # the repo opt-in gate (core's repoOptedIn — `bro hooks` exits
  # silent on it, so this is exact parity, not an approximation): any
  # bro.config*/.beads walking up from the base, else nothing emits
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
  [ "$_opted" = 0 ] && exit 0

  # session-id candidates — every value offered, sanitized the same
  # way markerPath()/seenPath() do ([^\w.-] → _). None extractable is
  # not "no session": a missed extraction would skip marker checks the
  # real sid would have failed, so sid-less payloads defer entirely.
  SIDS=$(printf %s "$PAYLOAD" | grep -oE '"(session_id|conversation_id)"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/;s/[^A-Za-z0-9_.-]/_/g' | sort -u)
  [ -z "$SIDS" ] && NEED_NODE=1

  # foreign-schema payload — cursor/codex need schema translation, the
  # hydrate leg, and CURSOR_PROJECT_DIR/workspace_roots resolution;
  # never fast-pathed
  if [ -z "$NEED_NODE" ]; then
    case "$PAYLOAD" in
      *'"cursor_version"'*|*'"hook_event_name"'*|*'"turn_id"'*|*'"workspace_roots"'*) NEED_NODE=1 ;;
    esac
  fi

  # payload content that names work: supersets of the real classifiers —
  # a string that merely contains the tokens defers to Node, where
  # command-position parsing decides. False positives are the safe side.
  if [ -z "$NEED_NODE" ]; then
    _W='[^[:alnum:]_-]'
    if [ "$EVENT" = post-tool ]; then
      printf %s "$PAYLOAD" | grep -qE \
        -e "(^|$_W)(bro|npx)($_W|$)[^;&|]{0,60}(act|drill|wtf|work|retrospect|debt|convoy|spec|next|loop|sync|unwind)" \
        -e "(^|$_W)gh($_W|$)[^;&|]{0,30}pr($_W|$)" \
        -e "(^|$_W)git($_W|$)[^;&|]{0,40}(push|worktree)($_W|$)" \
        -e "(^|$_W)bd($_W|$)[^;&|]{0,60}(--claim|worktree($_W|$))" \
        && NEED_NODE=1
    else
      printf %s "$PAYLOAD" | grep -qE 'pull/[0-9]|merge_requests/[0-9]' && NEED_NODE=1
    fi
  fi

  # the user-level mailbox drains even outside a repo — git-independent
  if [ -z "$NEED_NODE" ]; then
    mailbox_pending "${XDG_STATE_HOME:-${HOME:-}/.local/state}/bro/notify" && NEED_NODE=1
  fi

  # git-dir state — without a common dir Node resolves hooksDir/
  # mailboxDir/beadsDir to null in the same spots, so the checks below
  # can only fail the same way: nothing there exists to miss
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

    # orchestrator want-markers — a dead pulse/drive/rig gets respawned
    # by the post-tool checkpoint; workers (BRO_AGENT_ID) never rearm
    if [ -z "$NEED_NODE" ] && [ "$EVENT" = post-tool ] && [ -z "${BRO_AGENT_ID:-}" ]; then
      [ -f "$BRODIR/pulse.json" ] || [ -f "$BRODIR/rig-pulse.json" ] || [ -f "$BRODIR/drive.json" ] && NEED_NODE=1
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
        _w=${_w%/*}
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

      # 0 when a store manifest is newer than snapshot file $1 —
      # the probe would re-read live, so its cached answer no longer
      # proves this event a no-op
      _snap_stale() {
        while IFS= read -r _b; do
          [ -n "$_b" ] || continue
          for _m in "$_b"/embeddeddolt/*/.dolt/noms/manifest "$_b"/dolt/*/.dolt/noms/manifest; do
            [ -f "$_m" ] && [ "$_m" -nt "$1" ] && return 0
          done
        done <<EOF
$_beads
EOF
        return 1
      }

      # lessons — a fresh [] snapshot is the only "no lessons" proof
      if [ -z "$NEED_NODE" ] && [ "$_learn_off" = 0 ]; then
        SNAP=$HOOKS/cache/lessons.json
        if [ -f "$SNAP" ]; then
          grep -q '"lessons"[[:space:]]*:[[:space:]]*\[\]' "$SNAP" || NEED_NODE=1
          [ -z "$NEED_NODE" ] && _snap_stale "$SNAP" && NEED_NODE=1
        elif [ "$_manifest" = 1 ]; then
          NEED_NODE=1
        fi
      fi

      # open drill frames nudge every session's prompt-submit — a
      # fresh null snapshot is the only "no open frame" proof
      if [ -z "$NEED_NODE" ] && [ "$EVENT" = prompt-submit ]; then
        SNAP=$HOOKS/cache/drills.json
        if [ -f "$SNAP" ]; then
          grep -q '"frame"[[:space:]]*:[[:space:]]*null' "$SNAP" || NEED_NODE=1
          [ -z "$NEED_NODE" ] && _snap_stale "$SNAP" && NEED_NODE=1
        elif [ "$_manifest" = 1 ]; then
          NEED_NODE=1
        fi
      fi
    fi

    # guard defs for this event — the hook records resolved presence
    # itself (connector guards() and computed defs are invisible to a
    # config grep): .stamp is the freshness anchor, guards/<event>
    # exists while a collected def targets that event
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
        [ -z "$NEED_NODE" ] && [ -f "$GUARDSD/$EVENT" ] && NEED_NODE=1
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

  [ -z "$NEED_NODE" ] && exit 0
  ;;
esac

# each client exports its own plugin-root var — take whichever exists
# (Cursor, Devin, Claude, or the generic PLUGIN_ROOT).
# a relative or nonexistent root is untrusted input: canonicalize an
# absolute root, and fall back to this script's own dir otherwise so the
# walk-up can't wander off CWD and execute an unrelated dist.
SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
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

if [ -f "$DIR/packages/cli/dist/index.js" ] && command -v node >/dev/null 2>&1; then
  run_hook node "$DIR/packages/cli/dist/index.js" hooks "$@" && exit 0
fi
# stdin is the host's hook payload — the capability probe must not
# consume it, so it runs with stdin closed (a pre-0.2.5 `bro hooks`
# would otherwise eat the payload the real invocation needs)
if command -v bro >/dev/null 2>&1 && bro hooks </dev/null >/dev/null 2>&1; then
  run_hook bro hooks "$@" && exit 0
fi
if command -v npx >/dev/null 2>&1; then
  # --prefer-offline: warm npm cache wins over the network, so a slow
  # fetch can't eat the whole hook timeout
  run_hook npx -y --prefer-offline "@broject/bro@0.2.5" hooks "$@" || true
fi
exit 0
