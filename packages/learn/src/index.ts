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
export { matchPath, parseTraceLine, triggerMatches } from './match.ts'
export type { MatchContext, TraceEntry } from './match.ts'
export { DEFAULT_LEARN_CONFIG, learnSection } from './config.ts'
export type { LearnConfig } from './config.ts'
export { learnConnector } from './connector.ts'
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
