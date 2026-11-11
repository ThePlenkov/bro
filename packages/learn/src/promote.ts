/**
 * Promote — graduate a stored lesson into a rule-edit bead (spec:
 * specs/sessions/bro-f4ot.1-learn.md §promote). The lesson stays in
 * the store and keeps firing until the rule lands — the gap between
 * "we know" and "the rule is written" is exactly where repeats
 * happen — then goes quiet.
 *
 * promote does NOT edit skills or AGENTS.md itself: it opens a bead
 * carrying the lesson, its trigger, its evidence, and the proposed
 * rule text; the edit lands through the normal spec/PR path. The
 * lesson records `promotedTo` — the bead id — so a second promote is
 * idempotent instead of double-filing.
 *
 * bd has no transactions (retro.ts recordRetro precedent): the bead
 * is created first, the lesson marked second, and a mark failure
 * compensates by closing the orphan bead — a retry then files a
 * fresh bead rather than pointing at a phantom.
 */
import { taskStore, type TaskRow } from '@broject/core';
import type { Lesson } from './lesson.ts';
import { getLesson, LessonStoreError, putLesson, withStoreLock } from './store.ts';

export interface PromoteResult {
  /** the rule-edit bead the lesson points at */
  beadId: string;
  /** the lesson as stored after the promote (promotedTo set on a fresh
   *  promote; unchanged on an idempotent re-run) */
  lesson: Lesson;
  /** true when the lesson already carried promotedTo — no bead was
   *  created this call */
  alreadyPromoted: boolean;
}

/** Title-safe one-line shorten — same 72-char convention retro uses. */
const shorten = (text: string): string =>
  text.length > 72 ? `${text.slice(0, 71)}…` : text;

/** The bead body — everything the rule edit needs without re-reading
 *  the store: the rule, when it fires, where it was learned, and the
 *  routing note (skills/rules are the durable sinks; the store stays
 *  the fallback). */
function promoteDescription(lesson: Lesson): string {
  const t = lesson.trigger;
  const lines: string[] = [
    '## Lesson',
    '',
    lesson.lesson,
    '',
    '## Trigger',
    '',
    `on: ${t.on.join(', ')}`,
  ];
  if (t.match !== undefined) {
    lines.push('', 'match:');
    for (const [k, v] of Object.entries(t.match)) {
      lines.push(`  ${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
    }
  }
  if (t.budget !== undefined) {
    lines.push(`budget: ${t.budget}`);
  }
  lines.push('', '## Evidence', '');
  for (const e of lesson.evidence) {
    lines.push(`- ${e.kind}: ${e.ref}`);
  }
  lines.push(
    '',
    `confidence: ${lesson.confidence} · source: ${lesson.source} · captured: ${lesson.createdAt}`,
    '',
    '## Route',
    '',
    'Promoted from the learn store (`bro self learn promote`) — the edit',
    'lands through the normal spec/PR path: write the rule where it',
    'belongs (skills/ or rules files for scoped-durable knowledge,',
    'learn store for conditioned knowledge — see skills/learn). The',
    'lesson keeps firing until the rule lands, then goes quiet.',
    '',
    `lesson: ${lesson.id}`
  );
  return lines.join('\n');
}

/**
 * Open the rule-edit bead for `id` and mark the lesson `promotedTo`.
 * Idempotent: a lesson that already carries `promotedTo` returns that
 * bead id with `alreadyPromoted: true` and writes nothing. The whole
 * read-mark-write runs under the learn store lock — two concurrent
 * promotes must not both file a bead.
 */
export function promoteLesson(id: string, cwd?: string): PromoteResult {
  return withStoreLock(cwd, () => {
    const lesson = getLesson(id, cwd);
    if (lesson === null) {
      throw new LessonStoreError(`no lesson ${id}`);
    }
    if (lesson.promotedTo !== undefined) {
      return { beadId: lesson.promotedTo, lesson, alreadyPromoted: true };
    }
    const store = taskStore(cwd);
    const bead = store.create<TaskRow>({
      title: `learn promote ${lesson.id}: ${shorten(lesson.lesson)}`,
      labels: ['learn'],
      description: promoteDescription(lesson),
    });
    const marked: Lesson = {
      ...lesson,
      promotedTo: bead.id,
      updatedAt: new Date().toISOString(),
    };
    try {
      putLesson(marked, cwd);
    } catch (err) {
      // the bead exists but the mark didn't land — close it so a retry
      // files fresh instead of leaving an unmarked orphan pointing
      // nowhere. Best-effort: the original error is the verdict.
      try {
        store.close(bead.id, 'promote failed — lesson not marked');
      } catch {
        // compensation is advisory — the putLesson error still throws
      }
      throw err;
    }
    return { beadId: bead.id, lesson: marked, alreadyPromoted: false };
  });
}
