/** Judge-turn wire markers — shared between the writer side
 *  (providers' `TYPED_PREAMBLE`, which stamps judge prompts into the
 *  session) and the reader side (session-view verdict logic, which
 *  detects them). One constant for both directions: the preamble's
 *  first line is built FROM this mark and detection checks for it —
 *  the two literals cannot drift apart. */

/** The prompt-side marker — carried inside TYPED_PREAMBLE's first
 *  line (`You are a <MARK>. …`). A journaled prompt row whose text
 *  contains it marks that turn judge-labelled. */
export const JUDGE_PROMPT_MARK = 'System One decision endpoint';
