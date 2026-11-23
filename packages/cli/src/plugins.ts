/**
 * Plugin registry — every bro capability as a BroPlugin: subcommand +
 * skill + owned config section (+ plan schema later, bro-cap). The CLI
 * dispatches argv[0] through this list; nothing is hardcoded in main.
 */
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACT_PLAN_VERSION, type ActPlan, parseActPlan } from '@broject/act';
import { CONVOY_PLAN_VERSION, type ConvoyPlan, parseConvoyPlan } from '@broject/convoy';
import {
  actSection,
  agentsSection,
  type BroPlugin,
  beadsSection,
  CommandError,
  type ConfigLayerName,
  type ConfigSection,
  type Connector,
  type ConnectorHooks,
  checkBeads,
  configDiagnostics,
  type DocType,
  debtSection,
  definePlugin,
  EXIT,
  type FacadeMap,
  hasHelpFlag,
  isMode,
  loadConfig,
  meshSection,
  printUsage,
  querySection,
  registerConnector,
  type Scope,
  sddSection,
  serveSection,
  stackSection,
  sweepSection,
  syncSection,
} from '@broject/core';
import { DEBT_PLAN_VERSION, type DebtPlan, parseDebtPlan } from '@broject/debt';
import { DRILL_PLAN_VERSION, type DrillPlan, drillSection, parseDrillPlan } from '@broject/drill';
import { guardSection } from '@broject/guard';
import { judgeSection } from '@broject/judge';
import { learnSection } from '@broject/learn';
import { loopSection } from '@broject/loop';
import { otelSection } from '@broject/otel';
import {
  applyQueryPlan,
  parseQueryPlan,
  PLAN_VERSION as QUERY_PLAN_VERSION,
  type QueryPlan,
} from '@broject/query';
import { parsePlanDoc, RETRO_PLAN_VERSION, type RetroPlan } from '@broject/retro';
import { runAcpCommand } from './commands/acp.ts';
import { runAcpWorkerCommand } from './commands/acp-worker.ts';
import { applyActPlan, runActCommand } from './commands/act.ts';
import { runAgentsCommand } from './commands/agents.ts';
import { runStampCommand } from './commands/buildstamp.ts';
import { runBusCommand } from './commands/bus.ts';
import { runCheckCommand } from './commands/check.ts';
import { checkSection } from './commands/check-config.ts';
import { runClaimCommand } from './commands/claim.ts';
import { runCleanupCommand } from './commands/cleanup.ts';
import { runContractCommand } from './commands/contract.ts';
import { applyConvoyPlan, runConvoyCommand } from './commands/convoy.ts';
import { runDaemonCommand } from './commands/daemon.ts';
import { applyVerdicts, runDebtCommand } from './commands/debt.ts';
import { runDelegateCommand } from './commands/delegate-cli.ts';
import { runDoctorCommand } from './commands/doctor.ts';
import { runBenchmarkCommand, runDogfoodCommand } from './commands/dogfood.ts';
import { applyDrillPlan, runDrillCommand } from './commands/drill.ts';
import { runDriveCommand } from './commands/drive.ts';
import { driveSection } from './commands/drive-config.ts';
import { runExecCommand } from './commands/exec.ts';
import { runFleetCommand } from './commands/fleet.ts';
import { runGoalCommand } from './commands/goal.ts';
import { goalSection } from './commands/goal-config.ts';
import { runGuardCommand } from './commands/guard.ts';
import { runHerdrCommand } from './commands/herdr.ts';
import { runHooksCommand } from './commands/hooks.ts';
import { runJudgeCommand } from './commands/judge.ts';
import { runLearnCommand } from './commands/learn.ts';
import { runLoopCommand } from './commands/loop.ts';
import { runMcpCommand } from './commands/mcp.ts';
import { runMergeCommand } from './commands/merge.ts';
import { runMeshCommand } from './commands/mesh.ts';
import { runModeCommand } from './commands/mode.ts';
import { runMsgCommand } from './commands/msg.ts';
import { applyNextPlan, runNextCommand } from './commands/next.ts';
import {
  PLAN_VERSION as NEXT_PLAN_VERSION,
  type NextPlan,
  parseNextPlan,
} from './commands/next-plan.ts';
import { runNotifyCommand } from './commands/notify.ts';
import { runOtelCommand } from './commands/otel.ts';
import { runPipelineCommand } from './commands/pipeline.ts';
import { resolvePlanDoc, runPlanCommand } from './commands/plan.ts';
import { runPluginsCommand } from './commands/plugins.ts';
import { runClientsCommand } from './commands/clients.ts';
import { freshnessSection } from './commands/postmerge.ts';
import { runProviderCommand } from './commands/provider.ts';
import { runProvidersCommand } from './commands/providers.ts';
import { runPulseCommand } from './commands/pulse.ts';
import { runQueryCommand } from './commands/query.ts';
import { runQueueCommand } from './commands/queue.ts';
import { runRequestCommand } from './commands/request.ts';
import { runResumeCommand } from './commands/resume.ts';
import { cmdRecord, runRetrospectCommand } from './commands/retrospect.ts';
import { runRigCommand } from './commands/rig.ts';
import { rigSection } from './commands/rig-config.ts';
import { runRouterCommand } from './commands/router.ts';
import { runServeCommand } from './commands/serve.ts';
import { runSessionsCommand } from './commands/sessions.ts';
import { runSetupCommand } from './commands/setup.ts';
import { runSinksCommand } from './commands/sinks.ts';
import { runSkillsCommand } from './commands/skills.ts';
import { skillsSection } from './commands/skills-config.ts';
import { runSpecCommand } from './commands/spec.ts';
import { runStackCommand } from './commands/stack.ts';
import { runStatusCommand } from './commands/status.ts';
import { runSweepCommand } from './commands/sweep.ts';
import { runSyncCommand } from './commands/sync.ts';
import { runTraceCommand } from './commands/trace.ts';
import { telemetrySection } from './commands/trace-config.ts';
import { runWaitCommand } from './commands/wait.ts';
import { runWatchCommand } from './commands/watch.ts';
import { watchSection } from './commands/watch-config.ts';
import { runWatchdogCommand } from './commands/watchdog.ts';
import { runWorkCommand } from './commands/work.ts';
// Built-in connector registration lives in connectors.ts — shared with
// the slim hook entry (dist/hooks.js) so `bro hooks` never needs this
// registry's import graph. Side-effect import: order is the contract.
import './connectors.ts';

/** The telemetry plane's usage — the plane had no help of its own, and
 *  `bro telemetry --help` ran the report. */
const TELEMETRY_USAGE = 'bro telemetry [--session <id>] [--json]   Hook + command latency report';

export const PLUGINS: BroPlugin[] = [
  // Contract `json` refs are enforced two ways: contract.test.ts proves
  // every ref resolves on disk; contract-schema.test.ts validates each
  // schema against the emitter's real --json output (and fails on field
  // drift). --json emitters deliberately NOT schema'd — action reports,
  // acks, diagnostics, passthroughs, producer streams — are tabulated in
  // specs/bro-6ptci.2.md §4 (e.g. otel/doctor/guard/check/pulse/delegate,
  // act wait, convoy run, agents prune, pipeline, telemetry); the §4
  // deferred agent-facing reads are wired by specs/bro-6ptci.3.md
  // (convoy next, wait, mesh wait/inbox — sessions resume has no --json
  // by design and stays flags/exits-only).
  definePlugin({
    name: 'debt',
    group: 'review',
    summary: 'Review-debt pipeline: collect|status|stats|trend|prs|list|mark|set|sync|next|watch',
    run: runDebtCommand,
    skill: 'debt',
    configKey: 'debt',
    contract: {
      subs: {
        status: {
          exits: { 0: 'ledger summary printed', 1: 'usage (debt usage exits 1 today)' },
        },
        next: {
          flags: {
            '--json': 'the finding row as JSON',
            '--claim': 'mark the finding claimed atomically (CAS)',
            '--area <a>': 'only findings in this area',
            '--author <u>': 'only findings from this thread author',
          },
          json: 'schemas/cli/debt-next.schema.json',
          exits: {
            0: 'top open finding emitted',
            1: 'no open findings, or the claim CAS lost',
            2: 'usage',
          },
        },
        stats: {
          flags: {
            '--json': 'StatBucket[] — totals × status per --by group',
            '--by <f>': 'group field — author (default) | source | area',
          },
          json: 'schemas/cli/debt-stats.schema.json',
          exits: {
            0: 'stats printed',
            2: 'usage — bad --by value',
          },
        },
        trend: {
          flags: {
            '--json': 'TrendPoint[] — opened/closed/open per bucket × --by group',
            '--by <f>': 'group field — default ungrouped (key "all")',
            '--bucket <g>': 'week (default) | day',
            '--since <date>': 'lower bound on the window',
          },
          json: 'schemas/cli/debt-trend.schema.json',
          exits: {
            0: 'trend printed',
            2: 'usage — bad --by/--bucket/--since value',
          },
        },
      },
    },
    configSchema: debtSection,
    planSchema: (doc, source) => parseDebtPlan(doc, source),
    planVersion: DEBT_PLAN_VERSION,
    runPlan: plan => applyVerdicts((plan as DebtPlan).verdicts),
  }),
  definePlugin({
    name: 'act',
    group: 'review',
    summary: 'Open-PR loop: status|threads|resolve|reply|merge|dismiss',
    run: runActCommand,
    skill: 'act',
    configKey: 'act',
    contract: {
      subs: {
        status: {
          flags: {
            '--json': 'PR state + exit gate as one JSON document',
            '--pr <n>': 'the PR to inspect — default: the current branch',
          },
          exits: {
            0: 'exit gate green',
            1: 'gate blocked — threads/failures remain (usage errors also exit 1 today)',
            2: 'no open PR for the current branch',
          },
          json: 'schemas/cli/act-status.schema.json',
        },
        dismiss: {
          flags: {
            '--pr <n>': 'the PR whose stale veto reviews to dismiss — default: the current branch',
            '--dry-run': 'list the stale vetoes without dismissing',
            '--message <t>': 'the dismissal note the host records',
          },
          exits: {
            0: 'stale vetoes dismissed — or none standing/eligible (live vetoes are never dismissed)',
            1: 'host cannot enumerate/dismiss reviews, PR not OPEN, or a dismissal failed',
            2: 'usage — no PR for the current branch',
          },
        },
      },
    },
    configSchema: actSection,
    planSchema: (doc, source) => parseActPlan(doc, source),
    planVersion: ACT_PLAN_VERSION,
    runPlan: plan => applyActPlan(plan as ActPlan),
  }),
  definePlugin({
    name: 'merge',
    group: 'review',
    summary: 'Full merge cycle as one verb: ready → gate → automerge → retro [--bead|--no-retro]',
    run: runMergeCommand,
    skill: 'act',
    contract: {
      flags: {
        '--bead <id>': 'beads the merge discharges on MERGED',
        '--no-retro': 'skip the post-merge retro record',
      },
      exits: {
        0: 'MERGED — cycle complete',
        1: 'blocked gate, closed-unmerged PR, timeout, or merge failure',
        2: 'usage',
      },
    },
  }),
  definePlugin({
    name: 'convoy',
    group: 'flow',
    summary: 'Convoy execution over beads molecules: status|next|done|pour|list|run',
    run: runConvoyCommand,
    skill: 'convoy',
    contract: {
      subs: {
        next: {
          flags: {
            '[mol]': 'the molecule — default: the single open molecule in the store',
            '--mol <id>': 'same molecule, flag spelling',
          },
          // no --json flag: `next` emits ConvoyNext as JSON
          // unconditionally — the flag is rejected as an unknown option
          json: 'schemas/cli/convoy-next.schema.json',
          exits: {
            0: 'next-step JSON emitted — state step|gate|blocked|complete',
            1: 'molecule resolution failed — none open, ambiguous, or unreadable',
            2: 'usage — unknown option',
          },
        },
      },
    },
    planSchema: (doc, source) => parseConvoyPlan(doc, source),
    planVersion: CONVOY_PLAN_VERSION,
    runPlan: plan => applyConvoyPlan(plan as ConvoyPlan),
  }),
  definePlugin({
    name: 'next',
    group: 'flow',
    summary: 'Claim + emit the top ready bead — the autonomous backlog loop',
    run: runNextCommand,
    skill: 'next',
    contract: {
      flags: {
        '--list': 'emit the work order without claiming',
        '--json': 'the verdict as JSON — {state: task|gated|idle, bead, beads, queue, …}',
        '--global': 'read the user-level store instead of the project',
        '--label <a,b>': 'only beads carrying one of these labels are claimable',
      },
      json: 'schemas/cli/next.schema.json',
      exits: {
        0: 'verdict emitted — task | gated | idle',
        1: 'task store unreachable or classify failed',
        2: 'usage',
      },
    },
    planSchema: (doc, source) => parseNextPlan(doc, source),
    planVersion: NEXT_PLAN_VERSION,
    runPlan: plan => applyNextPlan(plan as NextPlan),
  }),
  definePlugin({
    name: 'loop',
    group: 'flow',
    summary: 'Autonomous backlog runner — claim → agent → gate → close → repeat',
    run: runLoopCommand,
    skill: 'loop',
    configKey: 'loop',
    configSchema: loopSection,
  }),
  definePlugin({
    // The loop's supervisor, not a second runner: this verb prints the
    // launch brief + tick-0 baselines and points at the skill that owns
    // the tick protocol — the loop itself stays model work.
    name: 'watchdog',
    group: 'flow',
    summary: 'Infinite read-only pipeline watchdog — launch brief + tick-0 baselines [--json]',
    run: runWatchdogCommand,
    skill: 'watchdog',
    contract: {
      flags: {
        '--json':
          'the launch brief as {ts, skill, baselines} — every plane measured now or `unavailable (<why>)`',
      },
      json: 'schemas/cli/watchdog.schema.json',
      exits: {
        0: 'brief printed (human or --json)',
        2: 'unknown flag — usage on stderr',
      },
    },
  }),
  definePlugin({
    name: 'pipeline',
    group: 'pipeline',
    summary:
      'Pipeline surface — run|accept|answer|wake: queue→run starter, verdict store, settled-run waker',
    run: runPipelineCommand,
    contract: {
      subs: {
        run: {
          flags: {
            '--formula <file>': 'REQUIRED — the pipeline formula (TOML) every run drives',
            '--engines <module>':
              'path to a module exporting engines (EngineMap or (dir)=>EngineMap)',
            '--customer <id>': 'the recorded customer — default: $BRO_CUSTOMER, else the bd actor',
            '--label <label>': 'the queue label to scan (default pipeline)',
            '--item <id>': 'explicit bead id (repeatable) — bypasses the label scan',
            '--limit <n>': 'cap how many candidates this invocation scans',
            '--max-in-flight <n>':
              'machine in-flight cap — narrows limits.in_flight (0 = uncapped)',
            '--dry-run': 'report what WOULD start without invoking runPipeline',
            '--json': 'machine-readable report',
          },
          exits: {
            0: 'scan completed — per-item outcomes in the report',
            1: 'customer-unresolved or a run-level failure',
            2: 'usage or an unloadable formula/engines module',
          },
        },
        accept: {
          flags: {
            '--notes <text>': "the customer's notes — required on rejected (the fix scope)",
            '--by <id>': 'signer identity — default: $BRO_AGENT_ID, else the actor chain',
            '--run <id>': 'the run to write to — default: the sole run parked at accept',
          },
          exits: {
            0: 'verdict recorded on the run channel',
            1: 'no run awaiting, an ambiguous target, or an unresolvable signer',
            2: 'usage',
          },
        },
        answer: {
          flags: {
            '-m <text>': 'answer text (short spelling)',
            '--message <text>': 'answer text',
            '--answers-file <path>': 'answers from a file (JSON parsed when it parses)',
            '--by <id>': 'who answered — optional provenance',
            '--run <id>': 'the run to write to — default: the sole run parked at intake',
          },
          exits: {
            0: 'answers recorded on the run channel',
            1: 'no run awaiting answers or an unreadable file',
            2: 'usage',
          },
        },
        wake: {
          flags: {
            '--engines <module>':
              'engine map module replacing the built-in production map — exports engines (EngineMap or (dir)=>EngineMap)',
            '--formula <file>':
              'formula TOML for every run (default: the <runId>.formula.toml sidecar)',
            '--formula-dir <dir>': 'formula TOML dir — the file whose sha matches formula_sha wins',
            '--json': 'emit the WakeReport as JSON',
          },
          exits: {
            0: 'pass complete — per-run actions reported (woken|waiting|unresolved|skipped|failed)',
            1: 'the wake pass itself failed (pipeline plane unreadable)',
            2: 'usage',
          },
        },
      },
    },
  }),
  definePlugin({
    name: 'fleet',
    group: 'fleet',
    summary:
      // no `a|b` alternation in this summary — gen-command-docs'
      // signature() would extract it as subcommands; the arg lists use
      // spaced pipes so the generated page prints the prose only
      'Fleet view — mols × steps × agents × worktrees × PRs; walls [--json | clear <account> | --all]; leases [--json | release <key>]; hosts [--json]',
    run: runFleetCommand,
    contract: {
      flags: {
        '--json':
          'fleet payload as JSON — rows, degraded, conflicts, prErrors, occupancy, budget, walls',
        '--live': 'TTY dashboard repaint loop (needs a TTY)',
        '--every N': 'repaint cadence seconds — implies --live',
      },
      subs: {
        hosts: {
          flags: {
            '--json':
              '{hosts, projects, generatedAt} — hosts × installs + sessions per project over the session ledger',
          },
          json: 'schemas/cli/fleet-hosts.schema.json',
          exits: {
            0: 'board printed',
            1: 'ledger unavailable',
            2: 'usage',
          },
        },
        leases: {
          flags: {
            '--json': 'live lease rows — key, holder rig/host/pid/agentId, acquiredAt, expiresAt',
            'release <key>': 'force-release a held lease',
          },
          json: 'schemas/cli/fleet-leases.schema.json',
          exits: {
            0: 'leases printed',
            2: 'usage',
          },
        },
        walls: {
          flags: {
            '--json':
              'FleetWallRow[] — registry-derived provider walls + ledger-recorded host walls',
            'clear <account>|--all': 'clear the ledger-recorded walls',
          },
          json: 'schemas/cli/fleet-walls.schema.json',
          exits: {
            0: 'walls printed',
            2: 'usage',
          },
        },
      },
      json: 'schemas/cli/fleet.schema.json',
      exits: {
        0: 'fleet printed',
        2: 'usage — --live without TTY, --every out of range, --json + --live',
      },
    },
  }),
  definePlugin({
    name: 'sessions',
    group: 'fleet',
    summary:
      'Agent sessions on this machine — the session-ledger view: host, sid, state, mode, agent, bead, claims, resume, worktree [--json]',
    run: argv => runSessionsCommand(argv),
    contract: {
      flags: {
        '--json': '{sessions, warnings} — epoch-ms times, full sids',
        '--project': 'only sessions of the current project — the default is machine-wide',
        '--all': 'every session on the machine — the default',
        '--host <h>': 'only sessions of this host (claude, codex, devin, …)',
        '--live': 'only sessions whose derived state is live',
      },
      json: 'schemas/cli/sessions.schema.json',
      exits: {
        0: 'sessions printed',
        1: 'ledger unavailable',
        2: 'usage',
      },
      subs: {
        resume: {
          flags: {
            '<id>': 'session key, sid (exact or unique prefix), or agentId',
            '--print': 'render the resume argv without spawning it',
            '--last': 'the most recently seen session',
            '--pick': 'interactive picker — needs a TTY',
          },
          // no `json` ref: resume takes --print|--last|--pick only — it
          // has no --json flag, so there is no schema to pin (the
          // exclusion is documented in specs/bro-6ptci.3.md)
          exits: {
            // an unsupported host is reported, never guessed — the
            // launchResume resumeArgv===null arm returns normally, so
            // it is an exit-0 outcome like --print or a cancelled pick
            0: 'argv printed (--print), picker cancelled, host has no resume command, or the host resume ran',
            1: 'no sessions in the ledger, spawn failed, or the resume exited nonzero',
            2: 'usage — missing/ambiguous target, --pick without a TTY',
          },
        },
      },
    },
  }),
  definePlugin({
    name: 'mode',
    group: 'fleet',
    summary:
      'Per-session behaviour mode — observe | plan | code | review | orchestrate; get, set, list, clear, render snapshots [--json]',
    run: argv => runModeCommand(argv),
    contract: {
      flags: {
        '--json': 'mode payload as JSON — get: {session, warnings}; list: {modes, warnings}',
        '--session <sid>': 'target session id — default: session env / hook identity',
        '--host <h>': 'target host (claude, codex, cursor, devin, …)',
        '--mode <m>': 'render only this mode (bro mode render)',
      },
      subs: {
        get: {},
        list: {},
        clear: {},
        render: {},
      },
      json: 'schemas/cli/mode.schema.json',
      exits: {
        0: 'mode printed/set/cleared/rendered — or hook-binding notice',
        1: 'ledger unavailable',
        2: 'usage',
      },
    },
  }),
  definePlugin({
    name: 'claim',
    group: 'fleet',
    summary:
      'Session resource claims — leases on worktree/branch/task/pr/path/role URIs in the session ledger [--json]',
    run: argv => runClaimCommand(argv),
    contract: {
      flags: {
        '--json':
          'claim → {ok,resource,session,conflict}; release → {released,session}; list → {claims,warnings}',
        '--session <sid>': 'claiming session id — default: session env / hook identity',
        '--host <h>': 'claiming host (claude, codex, devin, …)',
        '--ttl <sec>': 'lease seconds — default 24h; 0 = no expiry',
        '--exclusive': 'refuse every other live holder (role:* default)',
        '--shared': 'allow co-claims unless the standing claim is exclusive',
        '--project': 'list only claims of the current project id',
        '--resource <prefix>': 'list only claims whose URI starts with this prefix',
      },
      subs: {
        release: {},
        list: {},
      },
      json: 'schemas/cli/claim.schema.json',
      exits: {
        0: 'claimed/released/listed — a refused claim exits 1 with the standing holder',
        1: 'claims store unavailable, usage error, or claim refused',
        2: 'usage',
      },
    },
  }),
  definePlugin({
    name: 'delegate',
    group: 'fleet',
    summary:
      'Activate another agent — sync ask (--wait, pooled ACP turn) or detached registry spawn (--detach)',
    run: runDelegateCommand,
    skill: 'delegate',
    contract: {
      flags: {
        '--wait': 'sync short ask — one pooled ACP turn; reply text on stdout (default)',
        '--detach': 'real work — the registry spawn `bro agents run` takes; returns the agentId',
        '--prompt <text>': 'literal prompt (positional text is the same channel)',
        '--prompt-file <file>': 'prompt from a file',
        '--provider <name>': 'providers.<name> pin — --wait needs an acp entry',
        '--class <name>':
          'fleet.routing lane — chain[0] supplies the provider (exclusive with --provider)',
        '--model <m>': 'model override — --wait pins it on the ACP session',
        '--timeout <sec>': '--wait deadline (default 120)',
        '--connector <name>': '--detach backend pin',
        '--worktree <path>': '--detach worktree (default: minted <repo>--adhoc-*)',
        '--auto-approve': '--detach ACP permission policy',
        '--beads-dir <dir>': 'shared store override',
        '--json':
          '{mode,provider,model,class?,stopReason,text,delegatedBy?} for wait; {mode,delegatedBy?,agent} for detach',
      },
      exits: {
        0: 'delegation served — reply printed (--wait) or agent spawned (--detach)',
        1: 'provider walled/unavailable, spawn refused, prompt/pin error, or usage (usage errors also exit 1 today)',
      },
    },
  }),
  definePlugin({
    name: 'agents',
    group: 'fleet',
    summary: 'Agent supervisor — status|up|down over the orchestrator connectors',
    run: runAgentsCommand,
    skill: 'agents',
    configKey: 'agents',
    contract: {
      subs: {
        status: {
          flags: {
            '--json': 'agent rows + occupancy + session quota as JSON',
            '--connector <name>': 'pin the agents facade connector',
          },
          json: 'schemas/cli/agents-status.schema.json',
          exits: {
            0: 'agent plane printed',
            1: 'backend collection failed',
            2: 'usage',
          },
        },
      },
    },
    configSchema: agentsSection,
  }),
  definePlugin({
    name: 'status',
    group: 'fleet',
    summary: 'The compact live board — beads + fleet + drill + git [--json|--deep]',
    run: runStatusCommand,
    skill: 'status',
    contract: {
      flags: {
        '--json': 'the board as one JSON document',
        '--deep':
          'add the act exit gate for the current branch PR — the fast path stays local-only',
      },
      json: 'schemas/cli/fleet-status.schema.json',
      exits: { 0: 'board printed' },
    },
  }),
  definePlugin({
    name: 'notify',
    group: 'comms',
    summary:
      'Drop an event into the session mailbox — drained into context by the next postTool probe',
    run: runNotifyCommand,
    skill: 'notify',
  }),
  definePlugin({
    name: 'msg',
    group: 'comms',
    summary:
      'Message a fleet session — ledger-resolved <host>:<sid>|sid|agentId|orchestrator; inbox file on proven hosts + events record',
    run: argv => runMsgCommand(argv),
    skill: 'msg',
    contract: {
      flags: {
        '--kind <k>': 'note|info|ask|result|block (default note) — a label, never a grant',
        '--in-reply-to <r>': 'the drop/bead/step this answers',
        '--key <k>': 'coalesce: a pending same-key drop from this source is superseded',
      },
      exits: {
        0: 'message delivered — one line per delivery channel',
        2: 'usage — bad target grammar, ambiguous session, or missing text',
      },
    },
  }),
  definePlugin({
    // sinks documents itself in the notify skill — the human edge of
    // the same event plane, not a separate capability surface.
    name: 'sinks',
    group: 'comms',
    summary: 'Outbound event sinks — list configured webhooks, send a probe [list|test]',
    run: runSinksCommand,
  }),
  definePlugin({
    name: 'watch',
    group: 'review',
    summary:
      'Orchestrator heartbeat — mols × act gates × fleet snapshot [--once|--every N|--notify|--json|install|uninstall]',
    run: runWatchCommand,
    skill: 'watch',
    contract: {
      flags: {
        '--json':
          'the WatchSnapshot — ts, attention, mols, gates, fleet, loop, daemon (+ additive error/section keys)',
        '--once': 'one tick, then exit',
      },
      json: 'schemas/cli/watch.schema.json',
      exits: {
        0: 'snapshot printed',
        2: 'usage',
      },
    },
    configKey: 'watch',
    configSchema: watchSection,
  }),
  definePlugin({
    name: 'drive',
    group: 'review',
    summary:
      'Post-PR review driver — poll act gates, spawn fixer agents, merge on green [--once|--every N|--no-merge]',
    run: runDriveCommand,
    skill: 'drive',
    configKey: 'drive',
    configSchema: driveSection,
  }),
  definePlugin({
    name: 'daemon',
    group: 'fleet',
    summary:
      'Project-scoped supervisor — owns the drive pass long-term [up|status|down|run --every N]',
    run: runDaemonCommand,
    skill: 'daemon',
  }),
  definePlugin({
    name: 'resume',
    group: 'fleet',
    summary:
      'Post-restart recovery — rearm dead watches, revive the daemon, audit survivors [--dry-run|--json]',
    run: runResumeCommand,
    skill: 'resume',
    contract: {
      flags: {
        '--json':
          'the ResumeReport — dryRun, sweep, watch, daemon(s), loop, agents, worktrees, sessions',
        '--dry-run': 'report only — every leg read-only',
      },
      json: 'schemas/cli/fleet-resume.schema.json',
      exits: {
        0: 'recovery report printed',
        2: 'usage',
      },
    },
  }),
  definePlugin({
    name: 'serve',
    group: 'fleet',
    summary: 'Facade host for thin clients — HTTP/JSON on 127.0.0.1 [--port N]',
    run: runServeCommand,
    skill: 'serve',
    configKey: 'serve',
    configSchema: serveSection,
  }),
  definePlugin({
    name: 'provider',
    group: 'fleet',
    summary: 'Claude-facing Messages-API plane — host listener + url|token|env wiring helpers',
    run: runProviderCommand,
    skill: 'provider',
  }),
  definePlugin({
    name: 'mcp',
    group: 'fleet',
    summary: 'Stdio MCP server over the read planes — bro_<plane>_<read> tools',
    run: runMcpCommand,
    skill: 'mcp',
  }),
  definePlugin({
    name: 'pulse',
    group: 'fleet',
    summary:
      'Session-owned metronome — tick + mailbox beat every S seconds [S|--no-notify|--json|-- <cmd>…]',
    run: runPulseCommand,
    skill: 'pulse',
  }),
  definePlugin({
    // No `skill` yet: the skill documents the hook integration, which is
    // the follow-up PR — shipping a stub skill now would document a
    // capability that does not exist.
    name: 'bus',
    group: 'comms',
    summary: 'Local event bus — serve/publish/subscribe agent events by topic',
    run: runBusCommand,
  }),
  definePlugin({
    name: 'check',
    summary: 'Run the repo sverka workflow — per-step stats + findings [--json]',
    run: runCheckCommand,
    skill: 'check',
    configKey: 'check',
    configSchema: checkSection,
  }),
  definePlugin({
    name: 'cleanup',
    group: 'review',
    summary: 'Delete local branches whose PR merged and stale temp dirs [--remote] [--dry-run]',
    run: runCleanupCommand,
  }),
  definePlugin({
    name: 'drill',
    group: 'work',
    summary: 'Scoped descent over beads: down|up|current|tree|list|report|distill',
    run: runDrillCommand,
    skill: 'drill',
    configKey: 'drill',
    configSchema: drillSection,
    planSchema: (doc, source) => parseDrillPlan(doc, source),
    planVersion: DRILL_PLAN_VERSION,
    runPlan: plan => applyDrillPlan(plan as DrillPlan),
  }),
  definePlugin({
    name: 'unwind',
    group: 'work',
    aliasOf: 'drill up',
    summary: 'Alias for `drill up`',
    run: runDrillCommand,
    argvPrefix: ['up'],
  }),
  definePlugin({
    name: 'queue',
    group: 'work',
    summary:
      'Frame-scoped intake queue: ls|drill|bump|rm — rank-ordered items that promote to frames',
    run: runQueueCommand,
  }),
  definePlugin({
    name: 'retrospect',
    group: 'self',
    summary: 'Self-correction: capture|record|status|list|schema',
    run: runRetrospectCommand,
    skill: 'wtf',
    planSchema: (doc, source) => parsePlanDoc(doc, source),
    planVersion: RETRO_PLAN_VERSION,
    runPlan: plan => {
      checkBeads();
      cmdRecord(plan as RetroPlan);
    },
  }),
  definePlugin({
    name: 'wtf',
    group: 'self',
    aliasOf: 'retrospect capture',
    summary: 'Alias for `retrospect capture` — vent, verbatim',
    // bare `bro wtf` has nothing to capture — report open wtfs instead
    run: argv => runRetrospectCommand(argv.length === 0 ? ['status'] : ['capture', ...argv]),
  }),
  definePlugin({
    name: 'learn',
    group: 'self',
    // lesson store + capture/probe/promote + the connector that injects
    // them (spec: bro-f4ot.1-learn.md)
    summary: 'Self-improvement loop — lessons: add|list|show|forget|promote|capture|probe',
    run: runLearnCommand,
    skill: 'learn',
    configKey: 'learn',
    configSchema: learnSection,
  }),
  definePlugin({
    name: 'goal',
    group: 'work',
    summary:
      'Session-scoped completion goal — status|pause|resume|clear, or <condition> to set; hooks remind + judge-verdict',
    run: runGoalCommand,
    skill: 'goal',
    configKey: 'goal',
    configSchema: goalSection,
  }),
  definePlugin({
    name: 'skills',
    group: 'self',
    summary:
      'Agent-skill deps — skills.install sources materialise into .agents/skills/ [sync|list]',
    run: runSkillsCommand,
    skill: 'skills',
    configKey: 'skills',
    configSchema: skillsSection,
    contract: {
      subs: {
        sync: {
          flags: {
            '--root <dir>': 'run root — its bro.config and .agents/skills apply',
            '--json': 'per-source steps + reconcile rows + drift as JSON',
          },
          json: 'schemas/cli/skills-sync.schema.json',
          exits: {
            0: 'all declared sources installed — lock verifies',
            1: 'a source failed, or drift reported after sync',
            2: 'usage',
          },
        },
        list: {
          flags: {
            '--root <dir>': 'run root',
            '--json': 'the reconcile rows as JSON',
          },
          json: 'schemas/cli/skills-list.schema.json',
          exits: { 0: 'rows printed', 2: 'usage' },
        },
      },
    },
  }),
  definePlugin({
    name: 'judge',
    group: 'self',
    summary: 'Calibrated decision judge — decide smoke test over systemone + llm-judge',
    run: runJudgeCommand,
    skill: 'judge',
    configKey: 'judge',
    configSchema: judgeSection,
  }),
  definePlugin({
    name: 'dogfood',
    group: 'self',
    summary:
      'Scenario-driven e2e self-test — markdown runbook, fresh-agent runner, analyst verdict',
    run: runDogfoodCommand,
    skill: 'dogfood',
  }),
  definePlugin({
    name: 'benchmark',
    group: 'self',
    summary: 'Paired native-vs-BRO workflow outcome benchmarks',
    run: runBenchmarkCommand,
    skill: 'dogfood',
  }),
  definePlugin({
    // No `skill` yet: the skill documents the hook-side evaluation,
    // which lands with the engine (bro-nkn6.3) — same stub-skill
    // reasoning as `bus` above.
    name: 'guard',
    group: 'self',
    summary: 'Declarative prompt guards — list resolved declarations [--json]',
    run: runGuardCommand,
    configKey: 'guard',
    configSchema: guardSection,
  }),
  definePlugin({
    name: 'docs',
    summary: 'Doc-type dispatch — `bro <verb> <noun|ref>` (bro <verb> store|task)',
    // dispatch lives in index.ts's argv[0] fallback — this entry owns
    // the beads config section and keeps the registry honest
    hidden: true,
    run: () => {
      throw new CommandError('docs plugin must be dispatched via verb-first dispatch', EXIT.usage);
    },
    skill: 'docs',
    configKey: 'beads',
    configSchema: beadsSection,
  }),
  definePlugin({
    name: 'work',
    group: 'work',
    summary: 'Parallel-friendly worktrees: enter|leave|list|prune',
    run: runWorkCommand,
    skill: 'work',
    configKey: 'stack',
    configSchema: stackSection,
  }),
  definePlugin({
    name: 'stack',
    group: 'flow',
    summary: 'Stacked bead→worktree→PR chains: push|list|sync|publish|merge',
    run: runStackCommand,
    skill: 'stack',
    // the 'stack' config section (stack.mode) stays owned by `work`
  }),
  definePlugin({
    name: 'stamp',
    group: 'work',
    summary: 'Attribute shared-output writes — record/read the last build stamp',
    run: runStampCommand,
  }),
  definePlugin({
    name: 'spec',
    group: 'spec',
    summary: 'Spec-driven development policy: check|new (sdd.mode gates hooks)',
    run: runSpecCommand,
    skill: 'sdd',
    configKey: 'sdd',
    configSchema: sddSection,
  }),
  definePlugin({
    name: 'hooks',
    summary: 'Agent lifecycle hooks',
    run: runHooksCommand,
    hidden: true,
    configKey: 'freshness',
    configSchema: freshnessSection,
  }),
  definePlugin({
    name: 'telemetry',
    group: 'fleet',
    aliasOf: 'hooks perf',
    summary: 'Hook + command latency report — perf journal rollup [--session <id>] [--json]',
    run: argv => {
      // a help request never runs the report: the plane reads the perf
      // journal, and the token that leads the argv says help, not run
      if (hasHelpFlag(argv)) {
        printUsage(TELEMETRY_USAGE, 0);
        return;
      }
      return runHooksCommand(['perf', ...argv]);
    },
  }),
  definePlugin({
    name: 'trace',
    group: 'fleet',
    summary:
      '<ref> → provenance chain (VERIFIED/FORGED/MISSING) · export — OTLP export of session trace journals',
    run: runTraceCommand,
    skill: 'trace',
    configKey: 'telemetry',
    configSchema: telemetrySection,
  }),
  definePlugin({
    name: 'otel',
    group: 'fleet',
    summary:
      'Hook-first telemetry — status|test|on|off; every dispatched hook exports through the emitHook facade (spec bro-xgejl)',
    run: runOtelCommand,
    skill: 'otel',
    configKey: 'otel',
    configSchema: otelSection,
    contract: {
      subs: {
        status: {
          flags: { '--json': 'machine-readable report' },
          exits: { 0: 'report printed' },
        },
        test: {
          flags: { '--json': 'machine-readable report' },
          exits: { 0: 'would-be record printed', 2: 'missing hook name' },
        },
        on: {
          exits: {
            0: 'otel.enabled=true written to bro.config.local.json',
            2: 'bro.config.local.ts shadows',
          },
        },
        off: {
          exits: {
            0: 'otel.enabled=false written to bro.config.local.json',
            2: 'bro.config.local.ts shadows',
          },
        },
      },
      exits: { 0: 'status (bare `bro otel`)', 2: 'usage — unknown subcommand' },
    },
  }),
  definePlugin({
    name: 'acp-worker',
    summary: 'ACP provider spawn unit — backends exec this; never typed',
    run: runAcpWorkerCommand,
    hidden: true,
  }),
  definePlugin({
    name: 'herdr',
    summary: 'Herdr bridge — pane-facing helpers (status-view); spawned, never typed',
    run: runHerdrCommand,
    hidden: true,
  }),
  definePlugin({
    name: 'acp',
    group: 'fleet',
    summary:
      'ACP edge — bare `bro acp` is bro-as-agent (slash commands + routed provider); `proxy -- <agent cmd>` the cascade edge',
    run: runAcpCommand,
    skill: 'acp',
    contract: {
      flags: {
        '--provider <name>': 'providers.<name> pin (acp entries only — exclusive with --class)',
        '--class <name>':
          'fleet.routing lane — chain[0] supplies the provider (exclusive with --provider)',
      },
      exits: {
        0: 'client closed the wire — clean session end',
        1: 'downstream agent died first, or a config error (provider kind, dead lane)',
        2: 'usage — unknown subcommand/flag, --provider + --class together',
      },
      subs: {
        proxy: {
          exits: {
            0: 'client closed the wire — clean session end',
            1: 'downstream agent died first — abnormal end',
            2: 'usage — missing `--`, or empty agent argv',
          },
        },
      },
    },
  }),
  definePlugin({
    name: 'providers',
    group: 'self',
    summary: 'Provider registry — models catalog as <provider>/<model> [name…]',
    run: runProvidersCommand,
    skill: 'providers',
  }),
  definePlugin({
    name: 'router',
    summary:
      'The model router — the served catalog and the clients it renders for: models|clients|client <id> [--write]',
    run: runRouterCommand,
    skill: 'brouter',
  }),
  definePlugin({
    name: 'setup',
    summary: 'Wire bro into the current repo',
    run: runSetupCommand,
  }),
  definePlugin({
    name: 'doctor',
    summary: 'Environment diagnostics: node, git, gh auth, bd, hooks, config, remotes [--json]',
    run: runDoctorCommand,
  }),
  definePlugin({
    name: 'rig',
    group: 'fleet',
    summary:
      'Rig freshness — main checkout tracks upstream, rebuilt + hotpatched: sync|status|watch|install',
    run: runRigCommand,
    skill: 'rig',
    configKey: 'rig',
    contract: {
      subs: {
        status: {
          flags: {
            '--repo <dir>': 'rig checkout to inspect (default: this repo)',
            '--json': 'rig status as JSON',
          },
          json: 'schemas/cli/rig-status.schema.json',
          exits: { 0: 'rig fresh — no error surfaced', 1: 'a status error was found', 2: 'usage' },
        },
        next: {
          flags: { '--json': 'the re-entry verdict as JSON' },
          json: 'schemas/cli/rig-next.schema.json',
          exits: {
            0: 'verdict — step | gate | wait | done',
            1: 'verdict blocked',
            2: 'usage',
          },
        },
      },
    },
    configSchema: rigSection,
  }),
  definePlugin({
    name: 'sync',
    group: 'work',
    summary: 'Push/pull artifact dirs on refs/bro/data [--pull]',
    run: runSyncCommand,
    skill: 'sync',
    configKey: 'sync',
    configSchema: syncSection,
  }),
  definePlugin({
    name: 'sweep',
    group: 'work',
    summary: 'Gated disposal for closed beads: status|distill|run — gate → archive → prune',
    run: runSweepCommand,
    skill: 'sweep',
    configKey: 'sweep',
    configSchema: sweepSection,
  }),
  definePlugin({
    name: 'query',
    group: 'plan',
    summary:
      'Cross-provider GraphQL plan — `bro query <plan.toml>` or `kind = "query"` via `bro run`',
    run: argv => runQueryCommand(argv, PLUGINS),
    skill: 'query',
    configKey: 'query',
    configSchema: querySection,
    planSchema: (doc, source) => parseQueryPlan(doc, source),
    planVersion: QUERY_PLAN_VERSION,
    runPlan: async plan => {
      const code = await applyQueryPlan(plan as QueryPlan);
      if (code !== 0) {
        const core = await import('@broject/core');
        throw new core.CommandError('', core.passthroughExitCode(code));
      }
    },
  }),
  definePlugin({
    name: 'mesh',
    group: 'mesh',
    summary:
      'Inter-rig work federation: me|peers|pull|inbox|request|claim|done|accept|reject|wait (specs/mesh)',
    run: runMeshCommand,
    skill: 'mesh',
    configKey: 'mesh',
    contract: {
      subs: {
        inbox: {
          flags: {
            '--json':
              '[{peer, bead, …envelope, mismatch?, unbound?}] — pending requests addressed to this rig',
            '--no-pull': 'serve replica stores as they stand — skip the sync leg',
          },
          json: 'schemas/cli/mesh-inbox.schema.json',
          exits: {
            0: 'inbox rows printed (human table or --json)',
            2: 'not inside a git repository / rig unaddressed / usage',
          },
        },
        wait: {
          flags: {
            '<thread>': 'the request/thread id — `bro mesh request` and lifecycle verbs print it',
            '--json':
              '{thread, stage?, turn?, envelopes} — stage/turn keys absent when the reduction has none',
            '--no-pull': 'serve replica stores as they stand — skip the sync leg',
          },
          json: 'schemas/cli/mesh-wait.schema.json',
          exits: {
            0: 'thread state printed — --json always takes this arm',
            1: 'no request visible for the thread (human mode only)',
            2: 'not inside a git repository / rig unaddressed / usage',
          },
        },
      },
    },
    configSchema: meshSection,
  }),
  definePlugin({
    name: 'request',
    group: 'mesh',
    summary:
      'Post a request to a repo or peer — delivers into same-machine checkouts (specs/cross-repo)',
    run: runRequestCommand,
  }),
  definePlugin({
    // top-level on purpose: `bro wait` is the dep-plane watcher —
    // a `group: 'mesh'` membership would steal `bro mesh wait` from
    // the mesh host's own thread subcommand
    name: 'wait',
    summary:
      'Dep-plane watcher — `bro wait external:<rig>:<id>` polls the dep stores, verdict = exit code (specs/cross-repo)',
    run: runWaitCommand,
    contract: {
      flags: {
        'external:<rig>:<id>…': 'one or more dep refs — `bro request` prints the one it wired',
        '--json': '{verdict, refs, unsettled?} — the exit code IS the verdict',
        '--every <sec>': 'poll interval — default 30s',
        '--timeout <sec>': 'the bound — default 2700s (45m); 0 waits unbounded',
      },
      json: 'schemas/cli/wait.schema.json',
      exits: {
        0: 'free — every watched dep shipped',
        1: 'unreadable — a store failed 3 polls running',
        2: 'unresolved — a ref is absent on its posting store (usage also exits 2)',
        3: 'actionable — rejected or closed-unshipped; a human must move',
        4: 'timeout — the bound held with refs still open',
      },
    },
  }),
  definePlugin({
    name: 'run',
    group: 'plan',
    summary: 'Execute a plan file — `kind` routes to the owning plugin',
    run: argv => runPlanFile(argv),
  }),
  definePlugin({
    name: 'exec',
    group: 'work',
    summary:
      'Run a shell command, then fire taskFinish connector probes — the pane report-back for agent kinds without a native task-exit wake (spec bro-84zrj)',
    run: runExecCommand,
    contract: {
      exits: { 2: 'usage', 130: 'child killed by SIGINT' },
    },
  }),
  definePlugin({
    name: 'plan',
    group: 'plan',
    summary: 'Plan contract — kinds, schema versions, shipped JSON Schemas: list|validate|describe',
    run: argv => runPlanCommand(argv, PLUGINS),
  }),
  definePlugin({
    name: 'plugins',
    summary: 'The BroPlugin registry — plugins for bro (commands, skills, config)',
    run: argv => runPluginsCommand(argv, PLUGINS),
  }),
  definePlugin({
    name: 'clients',
    summary: 'Agents that use bro — install matrix + adapters: list|install|uninstall <client>',
    run: argv => runClientsCommand(argv),
  }),
  definePlugin({
    // consumer surface (agents/transports), not an operator one —
    // hidden like hooks/acp-worker; spec bro-k9ces
    name: 'contract',
    summary: 'The CLI surface as data — dump|check|gen over the registry',
    run: argv => runContractCommand(argv, PLUGINS, GROUP_META),
    hidden: true,
  }),
];

/** Group one-liners for `bro --help` — order is the render order.
 *  A plugin whose name equals the group name is the group's host:
 *  unmatched argv falls through to it (specs/cli — dispatch model). */
export const GROUP_META: ReadonlyArray<readonly [string, string]> = [
  ['review', 'PR review loop — gates, threads, debt'],
  ['flow', 'scheduling & work chains — claims, loops, stacks'],
  ['fleet', 'agent plane — workers, serve, the board'],
  ['work', 'worktree & session mechanics'],
  ['self', 'self-correction — retro, lessons, judgment, guards'],
  ['comms', 'events & session mailbox'],
  ['plan', 'versioned plans'],
  ['mesh', 'inter-rig federation'],
  ['spec', 'spec-driven development'],
  ['pipeline', 'pipeline customer surface — accept verdicts, intake answers'],
];

/** name → members, derived over the live registry each call so
 *  external plugins loaded from config can join a group too. Groups
 *  holding a same-named plugin (mesh/spec/plan) are HOSTED — the host
 *  plugin receives argv the group itself does not claim. */
export function pluginGroups(): Map<string, BroPlugin[]> {
  const groups = new Map<string, BroPlugin[]>();
  for (const p of PLUGINS) {
    if (!p.group) continue;
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  return groups;
}

/** `bro run <plan.toml>` — parse the file, route on `kind`, gate on the
 *  envelope `version`, validate with the owning plugin's planSchema,
 *  execute via runPlan. Resolution is shared with `bro plan validate`. */

export async function runPlanFile(argv: string[]): Promise<void> {
  const files = argv.filter(a => !a.startsWith('-'));
  const kinds = PLUGINS.filter(p => p.planSchema && p.runPlan).map(p => p.name);
  if (files.length !== 1) {
    throw new CommandError(
      `usage: bro run <plan.toml> — plan kinds: ${kinds.join(', ') || '(none)'}`,
      EXIT.usage
    );
  }
  const file = files[0] as string;
  const { plugin, plan } = resolvePlanDoc(file, PLUGINS);
  if (!plugin.runPlan) {
    throw new Error(`${file}: plugin "${plugin.name}" does not accept plans`);
  }
  await plugin.runPlan(plan);
}

/** configKey → configSchema across the registry — what `loadConfig`
 *  applies on top of core sections. External plugins register here too. */
export function pluginConfigSections(): Record<string, ConfigSection<unknown>> {
  return Object.fromEntries(
    PLUGINS.filter(p => p.configKey && p.configSchema).map(p => [
      p.configKey as string,
      p.configSchema as ConfigSection<unknown>,
    ])
  );
}

/** loadConfig + registered plugin sections — the CLI's config entrypoint.
 *  `only` restricts the layer scan (['global'] for host-level planes a
 *  checkout enclosing the state dir must not re-root). */
export function loadBroConfig(cwd: string = process.cwd(), only?: readonly ConfigLayerName[]) {
  return loadConfig(cwd, pluginConfigSections(), only);
}

/** configDiagnostics over the full registry — core sections merged with
 *  every plugin's declared configKey schema (spec: specs/bro-d9dmx.md). */
export function broConfigDiagnostics(cwd: string = process.cwd()) {
  return configDiagnostics(cwd, pluginConfigSections());
}

// The gate lives in config-policy.ts — a leaf commands/work.ts can
// import without the TDZ cycle back into this registry. The merged
// section list is registered here at init so assertMutableConfig sees
// plugin configKeys, not just core's.
export { assertMutableConfig, ConfigPolicyError } from './config-policy.ts';

import { registerPolicySections } from './config-policy.ts';

registerPolicySections(pluginConfigSections);

/** `field "…" <expectation>` — the rejection reason a skipped-export
 *  warning prints. The path names the offending key so the author
 *  fixes it instead of bisecting the export (spec bro-l8c4f.1). */
const field = (path: string, why: string): string => `field "${path}" ${why}`;

/** Optional keys of T — the fields an author may set or omit; the
 *  coverage asserts below require a runtime check row for each. */
type OptionalKeysOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

/** Function-typed optional keys — a present-but-wrong value becomes a
 *  delayed TypeError at dispatch, so each must sit in
 *  CONNECTOR_FUNCTION_KEYS. */
type FunctionKeysOf<T> = {
  [K in keyof T]-?: T[K] extends ((...args: never[]) => unknown) | undefined ? K : never;
}[keyof T];

/** Compile-time coverage pin — `assertNever<Exclude<…>>` fails
 *  typecheck when the set difference is non-empty, i.e. when a type
 *  grows a field nobody validates at runtime. `_proof` only exists so
 *  T sits in the signature (lint counts bare type params unused). */
function assertNever<T extends never>(_proof?: T): void {}

function isFunction(v: unknown): boolean {
  return typeof v === 'function';
}
function isString(v: unknown): boolean {
  return typeof v === 'string';
}
function isBoolean(v: unknown): boolean {
  return typeof v === 'boolean';
}
function isPlanVersion(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}
/** Dense element check — index reads, the same iteration the
 *  docs/connectors/optInFacades loops use. `every()` skips sparse
 *  holes (a hole must read `undefined` and fail the predicate), and an
 *  enumerable-key count conflates the two ways `keys ≠ indices`: a
 *  hole plus an extra prop nets the right count, and a dense list
 *  carrying a non-index prop gets rejected though dispatch only ever
 *  reads indices 0..length-1 (spread/includes/index access). */
function isDenseArray(v: unknown, ok: (item: unknown) => boolean): boolean {
  if (!Array.isArray(v)) {
    return false;
  }
  for (let i = 0; i < v.length; i++) {
    if (!ok(v[i])) {
      return false;
    }
  }
  return true;
}
function isDenseStringArray(v: unknown): boolean {
  return isDenseArray(v, item => typeof item === 'string');
}
/** DocType scopes — `satisfies` keeps every element a Scope; the
 *  `Exclude<Scope, …>` pin in the coverage block fails typecheck when
 *  core's union grows a value this list doesn't know. */
const SCOPES = ['project', 'global'] as const satisfies readonly Scope[];
function isScope(v: unknown): boolean {
  return SCOPES.includes(v as Scope);
}
function isScopeArray(v: unknown): boolean {
  return isDenseArray(v, isScope);
}

/** Table row — a present-but-wrong optional field answers the
 *  field-named rejection reason; absent or well-typed answers
 *  undefined. Table form keeps pluginExportProblem flat as fields
 *  grow, and the `as const` keys feed the coverage asserts below. */
const check = <K extends keyof BroPlugin>(
  key: K,
  why: string,
  ok: (v: unknown) => boolean
): readonly [K, (v: unknown) => string | undefined] => [
  key,
  v => (ok(v) ? undefined : field(key, why)),
];

const PLUGIN_FIELD_CHECKS = [
  check('configSchema', 'must be a function', isFunction),
  check('planSchema', 'must be a function', isFunction),
  check('planVersion', 'must be an integer ≥ 1', isPlanVersion),
  check('runPlan', 'must be a function', isFunction),
  check('skill', 'must be a string', isString),
  check('deprecated', 'must be a string', isString),
  check('flatDeprecated', 'must be a string', isString),
  check('configKey', 'must be a string', isString),
  check('argvPrefix', 'must be an array of strings', isDenseStringArray),
  ['docs', docsProblem],
  ['connectors', connectorsProblem],
  check('contract', 'must be a CliContract (flags/exits/subs maps)', isCliContract),
  check('group', 'must be a string', isString),
  check('aliasOf', 'must be a string', isString),
  check('hidden', 'must be a boolean', isBoolean),
  check('external', 'must be a boolean', isBoolean),
] as const satisfies ReadonlyArray<readonly [keyof BroPlugin, (v: unknown) => string | undefined]>;

/** Validate one config-loaded export — undefined = valid; a string is
 *  the rejection reason naming the offending field. Every malformed
 *  shape the registry would later call or iterate rejects here, before
 *  PLUGINS.push/registerConnector, so dispatch never meets it. */
export function pluginExportProblem(p: unknown): string | undefined {
  if (!isObject(p)) {
    return 'export must be an object';
  }
  if (!isNonEmptyString(p.name)) {
    return field('name', 'must be a non-empty string');
  }
  if (typeof p.summary !== 'string') {
    return field('summary', 'must be a string');
  }
  if (!isFunction(p.run)) {
    return field('run', 'must be a function');
  }
  for (const [key, problem] of PLUGIN_FIELD_CHECKS) {
    const v = p[key as string];
    if (v === undefined) {
      continue;
    }
    const why = problem(v);
    if (why !== undefined) {
      return why;
    }
  }
  return pluginPairProblem(p);
}

/** Schema/executor pairs — configKey↔configSchema and
 *  planSchema↔runPlan arrive together or the config/plan layer crashes
 *  on the missing half later. */
function pluginPairProblem(p: Record<string, unknown>): string | undefined {
  const hasConfigKey = p.configKey !== undefined;
  if (hasConfigKey !== (p.configSchema !== undefined)) {
    return field(
      hasConfigKey ? 'configSchema' : 'configKey',
      'is required — configKey and configSchema come in pairs'
    );
  }
  const hasPlanSchema = p.planSchema !== undefined;
  if (hasPlanSchema !== (p.runPlan !== undefined)) {
    return field(
      hasPlanSchema ? 'runPlan' : 'planSchema',
      'is required — planSchema and runPlan come in pairs'
    );
  }
  return undefined;
}

/** `contract` must be the declared shape at every level — a malformed
 *  nested map (flags: 5, subs: "x") would otherwise reach the
 *  dump/reconcile engine and crash or corrupt the snapshot. */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isStrMap = (v: unknown): boolean =>
  isRecord(v) && Object.values(v).every(x => typeof x === 'string');

const isSubContract = (v: unknown): boolean =>
  isRecord(v) &&
  (v.flags === undefined || isStrMap(v.flags)) &&
  (v.exits === undefined || isStrMap(v.exits)) &&
  (v.json === undefined || typeof v.json === 'string');

function isCliContract(v: unknown): boolean {
  return (
    isSubContract(v) &&
    isRecord(v) &&
    (v.subs === undefined || (isRecord(v.subs) && Object.values(v.subs).every(isSubContract)))
  );
}

const FACADE_KEYS = new Set([
  'tasks',
  'tasksAsync',
  'reviews',
  'mergeQueue',
  'specs',
  'judge',
  'events',
  'queries',
  'stacks',
  'ledger',
  'claims',
] as const satisfies ReadonlyArray<keyof FacadeMap>);

/** The literal key union inside FACADE_KEYS — the coverage assert
 *  consumes it; `ReadonlySet<keyof FacadeMap>` alone would infer away. */
type FacadeKey = typeof FACADE_KEYS extends ReadonlySet<infer F> ? F : never;

const CONNECTOR_FUNCTION_KEYS = [
  'matchRemote',
  'matchDir',
  'auth',
  'tasks',
  'tasksAsync',
  'reviews',
  'mergeQueue',
  'specs',
  'judge',
  'events',
  'queries',
  'stacks',
  'ledger',
  'claims',
  'hooks',
  'guards',
] as const satisfies ReadonlyArray<FunctionKeysOf<Connector>>;

const CONNECTOR_HOOK_KEYS = [
  'sessionStart',
  'parallelWork',
  'promptSubmit',
  'postTool',
  'stopGate',
  'preTool',
  'taskFinish',
] as const satisfies ReadonlyArray<keyof ConnectorHooks>;

const isObject = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object';

/** A connectors entry must be a Connector — name + at least the shape
 *  registerConnector relies on — else facade resolution would crash. */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v !== '';
}

function isValidFacadeKey(f: unknown): boolean {
  return typeof f === 'string' && FACADE_KEYS.has(f as keyof FacadeMap);
}

function optInFacadesProblem(v: unknown, path: string): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!Array.isArray(v)) {
    return field(path, 'must be an array of facade names');
  }
  for (let i = 0; i < v.length; i++) {
    if (!isValidFacadeKey(v[i])) {
      return field(`${path}[${i}]`, 'is not a facade name');
    }
  }
  return undefined;
}

/** One activeIn value — absent or the dense Mode list
 *  connectorHookActive's `modes.includes(mode)` walks. */
const isModeList = (v: unknown): boolean => v === undefined || isDenseArray(v, isMode);

/** activeIn own keys — a name outside ConnectorHooks is a typo'd kind
 *  that would silently never match in hook dispatch. */
function activeInKindProblem(v: Record<string, unknown>, path: string): string | undefined {
  const bad = Object.keys(v).find(
    kind => !(CONNECTOR_HOOK_KEYS as readonly string[]).includes(kind)
  );
  return bad === undefined ? undefined : field(`${path}.${bad}`, 'is not a hook kind');
}

/** activeIn values — the pass reads `v[kind]`, the same prototype-chain
 *  read dispatch makes, so an inherited `stopGate: 5` cannot slip past
 *  `Object.keys`/`entries` (own keys only). */
function activeInModesProblem(v: Record<string, unknown>, path: string): string | undefined {
  const bad = CONNECTOR_HOOK_KEYS.find(kind => !isModeList(v[kind]));
  return bad === undefined ? undefined : field(`${path}.${bad}`, 'must be an array of modes');
}

/** activeIn — `Partial<Record<keyof ConnectorHooks, readonly Mode[]>>`;
 *  a wrong value reaches connectorHookActive's `modes.includes(mode)`
 *  as a delayed TypeError in hook dispatch (spec bro-l8c4f.1). Key and
 *  value passes stay in named helpers so this gate remains flat. */
function activeInProblem(v: unknown, path: string): string | undefined {
  if (v === undefined) {
    return undefined;
  }
  if (!isRecord(v)) {
    return field(path, 'must map hook kinds to mode lists');
  }
  return activeInKindProblem(v, path) ?? activeInModesProblem(v, path);
}

/** Function-typed optional connector fields — a present-but-wrong
 *  value is a delayed TypeError at facade/hook dispatch. */
function connectorFunctionProblem(c: Record<string, unknown>, path: string): string | undefined {
  for (const key of CONNECTOR_FUNCTION_KEYS) {
    const v = c[key];
    if (v !== undefined && typeof v !== 'function') {
      return field(`${path}.${key}`, 'must be a function');
    }
  }
  return undefined;
}

function optInProblem(v: unknown, path: string): string | undefined {
  return v !== undefined && typeof v !== 'boolean'
    ? field(`${path}.optIn`, 'must be a boolean')
    : undefined;
}

/** One connectors entry — undefined = valid; a string names the
 *  offending field + expectation (`path` lets the caller point at
 *  `connectors[i]` so the warning lands on the entry). Field-group
 *  helpers keep this gate flat as the Connector type grows. */
export function connectorProblem(c: unknown, path: string): string | undefined {
  if (!isObject(c)) {
    return field(path, 'must be an object');
  }
  if (!isNonEmptyString(c.name)) {
    return field(`${path}.name`, 'must be a non-empty string');
  }
  return (
    connectorFunctionProblem(c, path) ??
    optInProblem(c.optIn, path) ??
    optInFacadesProblem(c.optInFacades, `${path}.optInFacades`) ??
    activeInProblem(c.activeIn, `${path}.activeIn`)
  );
}

/** The `connectors` plugin field — an array whose every entry passes
 *  connectorProblem; the first failure's path already reads
 *  `connectors[i].<field>`. */
function connectorsProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) {
    return field('connectors', 'must be an array');
  }
  for (let i = 0; i < v.length; i++) {
    const why = connectorProblem(v[i], `connectors[${i}]`);
    if (why !== undefined) {
      return why;
    }
  }
  return undefined;
}

/** Optional DocType fields — the same present-but-wrong contract as
 *  the plugin table: registration spreads `aliases` verbatim and
 *  dispatch reads `scopes`/`idPrefix`/`render`/`describe` by name, so
 *  a malformed one crashes docTypes/docVerbs or this loader. */
const DOCTYPE_FIELD_CHECKS = [
  ['aliases', 'must be an array of strings', isDenseStringArray],
  ['scopes', 'must be an array of scopes ("project" | "global")', isScopeArray],
  ['idPrefix', 'must be a string', isString],
  ['render', 'must be a function', isFunction],
  ['describe', 'must be a function', isFunction],
] as const satisfies ReadonlyArray<readonly [keyof DocType, string, (v: unknown) => boolean]>;

/** One docs entry — a DocType is name + adapter factory plus
 *  well-typed optionals; anything less crashes dispatch or the
 *  reserved-name sweep below. `path` lands the warning on `docs[i]`. */
function docTypeProblem(d: unknown, path: string): string | undefined {
  if (!isObject(d)) {
    return field(path, 'must be a DocType object');
  }
  if (!isNonEmptyString(d.name)) {
    return field(`${path}.name`, 'must be a non-empty string');
  }
  if (!isFunction(d.adapter)) {
    return field(`${path}.adapter`, 'must be a function');
  }
  for (const [key, why, ok] of DOCTYPE_FIELD_CHECKS) {
    const v = d[key];
    if (v !== undefined && !ok(v)) {
      return field(`${path}.${key}`, why);
    }
  }
  return undefined;
}

/** The `docs` plugin field — index reads keep the diagnostic at
 *  `docs[i].<field>`; a sparse hole reads `undefined` and the entry
 *  check rejects it by name (same contract as `connectors`). */
function docsProblem(v: unknown): string | undefined {
  if (!Array.isArray(v)) {
    return field('docs', 'must be an array');
  }
  for (let i = 0; i < v.length; i++) {
    const why = docTypeProblem(v[i], `docs[${i}]`);
    if (why !== undefined) {
      return why;
    }
  }
  return undefined;
}

// TypeScript↔runtime coverage (spec bro-l8c4f.1 acceptance) — every
// optional field an author can set has a check row above; a type that
// grows an unchecked field fails `npm run typecheck`, which is CI.
assertNever<Exclude<OptionalKeysOf<BroPlugin>, (typeof PLUGIN_FIELD_CHECKS)[number][0]>>();
assertNever<
  Exclude<
    OptionalKeysOf<Connector>,
    (typeof CONNECTOR_FUNCTION_KEYS)[number] | 'optIn' | 'optInFacades' | 'activeIn'
  >
>();
assertNever<Exclude<FunctionKeysOf<Connector>, (typeof CONNECTOR_FUNCTION_KEYS)[number]>>();
assertNever<Exclude<keyof FacadeMap, FacadeKey>>();
assertNever<Exclude<keyof ConnectorHooks, (typeof CONNECTOR_HOOK_KEYS)[number]>>();
assertNever<Exclude<OptionalKeysOf<DocType>, (typeof DOCTYPE_FIELD_CHECKS)[number][0]>>();
assertNever<Exclude<Scope, (typeof SCOPES)[number]>>();

/** Imports one specifier → exported candidate entries, or undefined on
 *  failure (warned). Relative specs must resolve inside the repo root —
 *  `../../etc/evil.ts` must not become a plugin just because config says so. */
async function importPluginModule(
  spec: string,
  req: ReturnType<typeof createRequire>,
  root: string
): Promise<unknown[] | undefined> {
  try {
    const resolved = req.resolve(spec);
    const rel = relative(root, resolved);
    if (spec.startsWith('.') && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new Error('plugin path escapes the repo root');
    }
    const mod = (await import(pathToFileURL(resolved).href)) as {
      default?: unknown;
    };
    const exported = mod.default ?? mod;
    return Array.isArray(exported) ? exported : [exported];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`warning: plugin "${spec}" failed to load (${msg}) — skipped`);
    return undefined;
  }
}

/** Validates + registers one export; undefined = rejected (warned). */
function registerExternal(
  entry: unknown,
  spec: string,
  reserved?: ReadonlySet<string>
): BroPlugin | undefined {
  const shapeProblem = pluginExportProblem(entry);
  if (shapeProblem !== undefined) {
    console.error(`warning: plugin "${spec}" ${shapeProblem} — skipped`);
    return undefined;
  }
  // undefined problem IS the BroPlugin guarantee — narrow once for the
  // name/registry checks below
  const pluginEntry = entry as BroPlugin;
  // plugin lookup wins argv[0] — a plugin named like a doc verb would
  // shadow `bro list`/`bro show`/`bro init` for every doc type
  if (reserved?.has(pluginEntry.name)) {
    console.error(
      `warning: plugin "${spec}" name "${pluginEntry.name}" is a reserved doc noun/verb — skipped`
    );
    return undefined;
  }
  if (PLUGINS.some(p => p.name === pluginEntry.name)) {
    console.error(`warning: plugin "${spec}" name "${pluginEntry.name}" is taken — skipped`);
    return undefined;
  }
  const plugin: BroPlugin = { ...pluginEntry, external: true };
  // a registered configKey is owned — an external plugin must not
  // shadow a builtin (or earlier external) section schema
  if (plugin.configKey && PLUGINS.some(p => p.configKey === plugin.configKey)) {
    console.error(
      `warning: plugin "${spec}" configKey "${plugin.configKey}" is already owned — its configSchema is ignored`
    );
    delete plugin.configKey;
    delete plugin.configSchema;
  }
  for (const c of plugin.connectors ?? []) {
    registerConnector(c);
  }
  PLUGINS.push(plugin);
  return plugin;
}

/** Imports config `plugins` specifiers relative to the repo and registers
 *  valid BroPlugin exports. A bad module or export warns and is skipped —
 *  one broken plugin must never take the whole CLI down. Returns what was
 *  registered (mainly so tests can unload). */
export async function loadExternalPlugins(
  cwd: string = process.cwd(),
  /** injectable for tests/callers that already loaded config */
  specs: string[] = loadConfig(cwd).plugins,
  /** plugin names that must stay dispatchable to other layers (doc verbs) */
  reserved: ReadonlySet<string> = new Set()
): Promise<BroPlugin[]> {
  const loaded: BroPlugin[] = [];
  // createRequire anchored at the repo keeps both `./x.ts` and bare
  // package specifiers resolving from the user's install, not the CLI's
  const req = createRequire(resolve(cwd, 'bro.config.json'));
  const root = resolve(cwd);
  // reserved is computed before any external plugin registers — a doc
  // noun a freshly accepted plugin just contributed must still block a
  // later plugin's command name (`bro <noun>` would route to it)
  const live = new Set(reserved);
  for (const spec of specs) {
    const entries = await importPluginModule(spec, req, root);
    for (const entry of entries ?? []) {
      const plugin = registerExternal(entry, spec, live);
      if (plugin) {
        loaded.push(plugin);
        // the accepted plugin's own name is reserved too — a later
        // plugin can't shadow `bro <name>` either
        live.add(plugin.name);
        for (const d of plugin.docs ?? []) {
          for (const n of [d.name, ...(d.aliases ?? [])]) {
            live.add(n);
          }
        }
      }
    }
  }
  return loaded;
}
