/**
 * The fixture CLI — a tiny command tree the tests spawn.
 *
 *   flat           → prints "flat"
 *   db migrate     → prints "migrate"
 *   plan run       → prints "plan-run"   (the host case: a plugin AND a
 *                    command of the same name — the member wins)
 *   plan           → prints "plan-host"  (the host itself)
 *   group          → prints the member table
 */
import { defineCommand, definePlugin, runCommand, type Command, type CommandPlugin } from '../index.ts';

const seen: string[] = [];

/** A command with ONE member — the shape `db` and `group` share. The
 *  member prints its own name. */
const singleMember = (spec: {
  name: string;
  summary: string;
  member: string;
  memberSummary: string;
}): Command =>
  defineCommand({
    name: spec.name,
    summary: spec.summary,
    plugins: [
      definePlugin({
        name: spec.member,
        summary: spec.memberSummary,
        run: () => {
          console.log(spec.member);
        },
      }),
    ],
  });

const flat = definePlugin({
  name: 'flat',
  summary: 'a flat plugin',
  run: () => {
    seen.push('flat');
    console.log('flat');
  },
});

const planHost = definePlugin({
  name: 'plan',
  summary: 'the plan host',
  run: () => {
    console.log('plan-host');
  },
});

const planRun = definePlugin({
  name: 'run',
  summary: 'the plan runner',
  run: () => {
    console.log('plan-run');
  },
});

/** A plugin that RUNS unless the help token leads its argv — the
 *  bootstrap's promise: a help request never runs the command it
 *  names, so the token has to arrive where every dispatcher looks
 *  first. */
const runner = definePlugin({
  name: 'runner',
  summary: 'a plugin that runs unless help leads',
  run: (argv) => {
    console.log(argv[0] === '--help' ? 'runner-help' : 'runner-ran');
  },
});

/** The same rule for a MEMBER — the bootstrap hands the member's argv
 *  too, so the member is the one that must not run. */
const actor = definePlugin({
  name: 'act',
  summary: 'a member that runs unless help leads',
  run: (argv) => {
    console.log(argv[0] === '--help' ? 'act-help' : 'act-ran');
  },
});

const shop = defineCommand({
  name: 'shop',
  summary: 'a group with a picky member',
  plugins: [actor],
});

const db = singleMember({
  name: 'db',
  summary: 'the database plane',
  member: 'migrate',
  memberSummary: 'run the migrations',
});

const group = singleMember({
  name: 'group',
  summary: 'a group of things',
  member: 'member',
  memberSummary: 'a member',
});

/** The late-joining group — its member list is a RESOLVER, because the
 *  host loads external members after the tree is built. A snapshot
 *  taken at build time would hide them from their own group. */
const lateMembers: CommandPlugin[] = [];

const late = defineCommand({
  name: 'late',
  summary: 'a group whose members arrive late',
  plugins: () => lateMembers,
});

const cli = defineCommand({
  name: 'fixture',
  summary: 'the fixture CLI',
  version: '9.9.9',
  plugins: [flat, planHost, runner],
  commands: [
    db,
    group,
    shop,
    defineCommand({ name: 'plan', summary: 'the plan plane', plugins: [planRun] }),
    late,
  ],
  usageLines: ['', 'Doc nouns:'],
  examples: ['fixture flat'],
  prepare: async () => {
    // the late member joins AFTER the tree is built — the group must
    // still reach it
    lateMembers.push(
      definePlugin({
        name: 'joined',
        summary: 'a member that joined late',
        run: () => {
          console.log('joined');
        },
      })
    );
  },
});

await runCommand(cli, process.argv.slice(2), { mounted: true });
if (seen.length > 0) {
  // the plugin ran — nothing else to report
}
