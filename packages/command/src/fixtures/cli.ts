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
import { defineCommand, definePlugin, runCommand, type CommandPlugin } from '../index.ts';

const seen: string[] = [];

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

function oneMemberCommand(spec: {
  name: string;
  summary: string;
  memberName: string;
  memberSummary: string;
  run: () => void;
}): ReturnType<typeof defineCommand> {
  return defineCommand({
    name: spec.name,
    summary: spec.summary,
    plugins: [definePlugin({ name: spec.memberName, summary: spec.memberSummary, run: spec.run })],
  });
}

const db = oneMemberCommand({
  name: 'db',
  summary: 'the database plane',
  memberName: 'migrate',
  memberSummary: 'run the migrations',
  run: () => {
    console.log('migrate');
  },
});

const group = oneMemberCommand({
  name: 'group',
  summary: 'a group of things',
  memberName: 'member',
  memberSummary: 'a member',
  run: () => {
    console.log('member');
  },
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
  plugins: [flat, planHost],
  commands: [
    db,
    group,
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
