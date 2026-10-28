/**
 * Action `claim-bead` — `bro next` claims the top ready bead (the plain
 * command-plane call; the claim itself is bro's work, not ours). The
 * interactive lane: start a visible herdr agent in the caller's
 * workspace and prompt it with the work order — the agent's own
 * `bro work enter`/`bd --claim` creates the `.work` markers and claims,
 * so this writes nothing into bro.
 *
 * Agent kind comes from $HERDR_PLUGIN_CONFIG_DIR/config.toml
 * (`agent_kind = "devin"`), default `devin`.
 */
import { broJson, configValue, ctxJson, herdr, herdrTry, notify, repoDir } from './lib.ts';

interface NextOut {
  state: string;
  bead?: { id: string; title: string; description?: string };
}

const ctx = ctxJson();
const repo = repoDir(ctx);
const dir = ctx.worktree?.checkout_path ?? repo;

const next = broJson<NextOut>(['next', '--json'], dir);
if (next.state !== 'task' || next.bead === undefined) {
  const msg = `bro next → ${next.state} — nothing claimable`;
  notify('bro claim-bead', msg);
  console.log(msg);
  process.exit(0);
}

const bead = next.bead;
const order =
  `You are working ${bead.id} — "${bead.title}". The bead is claimed to ` +
  `this run. Begin with 'bro work enter ${bead.id}' inside this ` +
  `repository's primary checkout, then implement the description below.\n\n` +
  `${bead.description ?? ''}`;

const kind = configValue('agent_kind', 'devin');
const name = bead.id
  .toLowerCase()
  .replace(/[^a-z0-9_-]/g, '-')
  .slice(0, 31);

const pane = ctx.pane?.pane_id ?? ctx.focused_pane?.pane_id ?? process.env.HERDR_PANE_ID;
if (pane === undefined) {
  notify('bro claim-bead', `${bead.id} claimed — no pane context to spawn the agent`);
  console.log(
    `${bead.id} claimed; work order printed below (no pane context for agent start)\n\n${order}`
  );
  process.exit(0);
}

// a sibling pane of the caller, same workspace — the visible lane
const split = herdrTry<{ pane?: { pane_id?: string } }>([
  'pane',
  'split',
  pane,
  '--direction',
  'right',
  '--cwd',
  dir,
  '--no-focus',
]);
const target = split?.pane?.pane_id;
if (target === undefined) {
  notify('bro claim-bead', `${bead.id} claimed — pane split failed, agent not started`);
  console.log(`${bead.id} claimed; split failed\n\n${order}`);
  process.exit(1);
}

const started = herdrTry([
  'agent',
  'start',
  name,
  '--kind',
  kind,
  '--pane',
  target,
  '--timeout',
  '60000',
]);
if (started === undefined) {
  notify('bro claim-bead', `${bead.id} claimed — agent start (${kind}) failed in ${target}`);
  console.log(
    `${bead.id} claimed; agent start failed — pane ${target} is free for manual start\n\n${order}`
  );
  process.exit(1);
}

const prompted = herdrTry(['agent', 'prompt', name, order]);
if (prompted === undefined) {
  notify('bro claim-bead', `${bead.id} claimed — agent ${name} started, prompt failed`);
  console.log(
    `${bead.id} claimed; agent ${name} running in ${target} — prompt it manually:\n\n${order}`
  );
  process.exit(1);
}

notify('bro claim-bead', `${bead.id} → agent ${name} (${kind}) in ${target}`);
console.log(`${bead.id} claimed → agent ${name} (${kind}) in pane ${target}`);
