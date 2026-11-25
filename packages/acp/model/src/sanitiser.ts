// Output sanitiser (design D3, spec `model-sanitiser`).
//
// Removes every terminal control sequence from agent- or daemon-supplied text before it is
// stored in the model, so nothing that reaches native scrollback can write the clipboard, set a
// hyperlink or window title, change terminal modes, or otherwise control the terminal.
//
// Implemented as a single-pass state machine over Unicode code points (not UTF-16 code units),
// so astral characters (including most emoji) are never split. No regular expressions: escape
// sequences nest and terminate in enough different ways (7-bit ESC-prefixed, 8-bit C1, BEL or ST
// terminated, unterminated) that a scanner is the only way to handle all of them deterministically.

/** Sanitisation mode. "approval" additionally strips deceptive Unicode for text shown for approval
 *  (permission prompt titles, commands, paths), so the text presented is the text executed. */
export type SanitiseMode = "default" | "approval";

type State = "ground" | "esc" | "escIntermediate" | "csi" | "string" | "stringEsc";

/**
 * Bidirectional override/isolate and zero-width code points stripped only in "approval" mode.
 *
 * Beyond the set the spec lists explicitly (U+202A-U+202E, U+2066-U+2069, U+200E, U+200F,
 * U+061C, U+200B-U+200D, U+2060, U+FEFF), two extra decisions were made here (see
 * docs/phase-0-notes/acp-model.md for the reasoning):
 *   - U+180E (Mongolian vowel separator) is treated as a zero-width formatting character and
 *     stripped in approval mode, since modern Unicode classifies it outside White_Space and it
 *     renders invisibly in most fonts.
 *   - U+00AD (soft hyphen) is deliberately left untouched in both modes: it has a visible effect
 *     only at a line break and does not reorder or hide arbitrary characters the way bidi
 *     overrides and zero-width joiners do, so it is not treated as a spoofing vector.
 */
/** Stripped ranges (inclusive code-point bounds), in the same order as the spec comment:
 *  ALM, Mongolian vowel separator, ZWSP-RLM, bidi embeddings/overrides, word joiner,
 *  bidi isolates, BOM. */
const APPROVAL_STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c], // Arabic Letter Mark
  [0x180e, 0x180e], // Mongolian vowel separator (decision, see above)
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
  [0x2060, 0x2060], // word joiner
  [0x2066, 0x2069], // LRI, RLI, FSI, PDI
  [0xfeff, 0xfeff], // zero width no-break space / BOM
];

function isApprovalStripped(cp: number): boolean {
  return APPROVAL_STRIPPED_RANGES.some(([low, high]) => cp >= low && cp <= high);
}

const isFinalByte = (cp: number): boolean => cp >= 0x40 && cp <= 0x7e;
const isIntermediateByte = (cp: number): boolean => cp >= 0x20 && cp <= 0x2f;
const isGenericFinalByte = (cp: number): boolean => cp >= 0x30 && cp <= 0x7e;

// -- The scanner, one step function per state --------------------------------------------------
//
// A step consumes a code point and reports the transition: `state` is the next state,
// `reprocess` re-reads the same code point in it (the old `i--`), `emit` appends it to the
// output. `approval` is only consulted by the ground state.

interface Step {
  readonly state: State;
  readonly reprocess?: boolean;
  readonly emit?: boolean;
}

const GROUND: Step = { state: "ground" };
const EMIT: Step = { state: "ground", emit: true };
const CSI: Step = { state: "csi" };
const STRING: Step = { state: "string" };
const REPROCESS_FROM_GROUND: Step = { state: "ground", reprocess: true };
const REPROCESS_IN_STRING: Step = { state: "string", reprocess: true };

/** 8-bit DCS, SOS, OSC, PM, APC introducers. */
const C1_STRING_INTRODUCERS: ReadonlySet<number> = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);

/** 7-bit OSC, DCS, APC, PM, SOS introducers (the character after ESC). */
const ESC_STRING_INTRODUCERS: ReadonlySet<number> = new Set([0x5d, 0x50, 0x5f, 0x5e, 0x58]); // ] P _ ^ X

/** Ground-state classification, in priority order; anything unlisted reaches the
 *  approval-strip check / emit below. */
const GROUND_TRANSITIONS: readonly { readonly test: (cp: number) => boolean; readonly step: Step }[] = [
  { test: (cp) => cp === 0x1b, step: { state: "esc" } },
  { test: (cp) => cp === 0x9b, step: CSI }, // 8-bit CSI introducer
  { test: (cp) => C1_STRING_INTRODUCERS.has(cp), step: STRING },
  // 8-bit ST (0x9c) seen outside a string, and every other C1 control: drop
  { test: (cp) => cp >= 0x80 && cp <= 0x9f, step: GROUND },
  // CRLF collapses to LF (handled when the LF itself is reached); a lone CR is dropped
  { test: (cp) => cp === 0x0d, step: GROUND },
  { test: (cp) => cp === 0x0a || cp === 0x09, step: EMIT },
  { test: (cp) => cp < 0x20, step: GROUND }, // other C0 controls: drop
  { test: (cp) => cp === 0x7f, step: GROUND }, // DEL: drop
];

function groundStep(cp: number, approval: boolean): Step {
  for (const { test, step } of GROUND_TRANSITIONS) {
    if (test(cp)) return step;
  }
  if (approval && isApprovalStripped(cp)) return GROUND;
  return EMIT;
}

/** Esc-state transitions, in priority order; an unmatched code point is malformed input
 *  (e.g. ESC followed by a control character): the lone ESC is dropped and the character
 *  is reprocessed from ground. */
const ESC_TRANSITIONS: readonly { readonly test: (cp: number) => boolean; readonly step: Step }[] = [
  { test: (cp) => cp === 0x5b, step: CSI }, // '['
  { test: (cp) => ESC_STRING_INTRODUCERS.has(cp), step: STRING },
  { test: (cp) => cp === 0x5c, step: GROUND }, // stray '\\' terminator, no open string
  { test: isIntermediateByte, step: { state: "escIntermediate" } },
  // single-byte escape sequence (e.g. ESC 7, ESC c): fully consumed
  { test: isGenericFinalByte, step: GROUND },
];

function escStep(cp: number): Step {
  for (const { test, step } of ESC_TRANSITIONS) {
    if (test(cp)) return step;
  }
  return REPROCESS_FROM_GROUND;
}

function escIntermediateStep(cp: number): Step {
  if (isIntermediateByte(cp)) return { state: "escIntermediate" };
  if (isGenericFinalByte(cp)) return GROUND;
  return REPROCESS_FROM_GROUND;
}

function csiStep(cp: number): Step {
  // parameter and intermediate bytes (and anything else, for malformed input): keep consuming
  return isFinalByte(cp) ? GROUND : CSI;
}

function stringStep(cp: number): Step {
  if (cp === 0x07) return GROUND; // BEL terminator
  if (cp === 0x9c) return GROUND; // 8-bit ST terminator
  if (cp === 0x1b) return { state: "stringEsc" };
  return STRING; // consume
}

function stringEscStep(cp: number): Step {
  // 7-bit ST (ESC \) terminator
  if (cp === 0x5c) return GROUND;
  // not a valid terminator: the ESC is still inside the string; reprocess this
  // character as an ordinary string byte
  return REPROCESS_IN_STRING;
}

const STEP_TABLE: Record<State, (cp: number, approval: boolean) => Step> = {
  ground: groundStep,
  esc: escStep,
  escIntermediate: escIntermediateStep,
  csi: csiStep,
  string: stringStep,
  stringEsc: stringEscStep,
};

/**
 * Sanitise a string for safe rendering. Pure and idempotent: sanitise(sanitise(x)) === sanitise(x)
 * for every input and mode (spec "Sanitisation is pure and idempotent").
 */
export function sanitise(input: string, mode: SanitiseMode = "default"): string {
  const approval = mode === "approval";
  const chars = Array.from(input);
  let out = "";
  let state: State = "ground";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const cp = ch.codePointAt(0) as number;
    const step: Step = STEP_TABLE[state](cp, approval);
    state = step.state;
    if (step.reprocess) {
      i--;
    } else if (step.emit) {
      out += ch;
    }
  }

  // Any state other than "ground" at end of input means an unterminated sequence: everything
  // from its introducer onward has already been dropped (never appended to `out`), which is the
  // required behaviour.
  return out;
}
