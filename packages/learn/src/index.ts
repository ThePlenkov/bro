export {
  CONFIDENCES,
  deriveConfidence,
  EVIDENCE_KINDS,
  HOOK_EVENTS,
  isLesson,
  LESSON_SOURCES,
  lessonId,
  lessonProblems,
} from './lesson.ts'
export type {
  Confidence,
  Evidence,
  EvidenceKind,
  HookEvent,
  Lesson,
  LessonSource,
  LessonTrigger,
  TriggerMatch,
} from './lesson.ts'
export {
  deleteLesson,
  getLesson,
  KV_PREFIX,
  lessonIds,
  LessonStoreError,
  listLessons,
  putLesson,
  withStoreLock,
} from './store.ts'
export type { LessonListing, SkippedEntry } from './store.ts'
export { matchKeys, matchPath, parseTraceLine, triggerMatches } from './match.ts'
export type { MatchContext, TraceEntry } from './match.ts'
export { DEFAULT_LEARN_CONFIG, learnSection } from './config.ts'
export type { LearnConfig } from './config.ts'
export { learnConnector } from './connector.ts'
// shared injection-plane state — the fired set, session trace tail, and
// session-context text are the same files/reads guards run on (spec:
// bro-nkn6 — no second dedup plane)
export {
  firedCounts,
  firedFile,
  hooksDir,
  previousTraceFile,
  readTraceTail,
  recordFired,
  relativize,
  safeId,
  sessionContextText,
  traceFile,
  TRACE_TAIL_LINES,
} from './connector.ts'
export { applyCapture, captureLessons, CAPTURE_SOURCES, planCapture } from './capture.ts'
export type {
  CaptureCandidate,
  CaptureMerge,
  CaptureOptions,
  CapturePlan,
  CaptureReport,
  CaptureSkip,
  CaptureSource,
  CaptureWrite,
} from './capture.ts'
export {
  probeQuestion,
  probeTerms,
  probeTrigger,
  rankLessons,
  recordProbeAnswer,
  resolveSessionId,
} from './probe.ts'
export type {
  ProbeHit,
  ProbeQuery,
  ProbeQueryOptions,
  RecordProbeOptions,
  RecordProbeResult,
} from './probe.ts'
