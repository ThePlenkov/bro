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
function isApprovalStripped(cp: number): boolean {
  if (cp === 0x061c) return true; // Arabic Letter Mark
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP, ZWNJ, ZWJ, LRM, RLM
  if (cp === 0x180e) return true; // Mongolian vowel separator (decision, see above)
  if (cp >= 0x202a && cp <= 0x202e) return true; // LRE, RLE, PDF, LRO, RLO
  if (cp === 0x2060) return true; // word joiner
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI, RLI, FSI, PDI
  if (cp === 0xfeff) return true; // zero width no-break space / BOM
  return false;
}

const isFinalByte = (cp: number): boolean => cp >= 0x40 && cp <= 0x7e;
const isIntermediateByte = (cp: number): boolean => cp >= 0x20 && cp <= 0x2f;
const isGenericFinalByte = (cp: number): boolean => cp >= 0x30 && cp <= 0x7e;

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

    switch (state) {
      case "ground": {
        if (cp === 0x1b) {
          state = "esc";
          break;
        }
        if (cp === 0x9b) {
          // 8-bit CSI introducer
          state = "csi";
          break;
        }
        if (cp === 0x90 || cp === 0x98 || cp === 0x9d || cp === 0x9e || cp === 0x9f) {
          // 8-bit DCS, SOS, OSC, PM, APC introducers
          state = "string";
          break;
        }
        if (cp >= 0x80 && cp <= 0x9f) {
          // 8-bit ST (0x9c) seen outside a string, and every other C1 control: drop
          break;
        }
        if (cp === 0x0d) {
          // CRLF collapses to LF (handled when the LF itself is reached); a lone CR is dropped
          break;
        }
        if (cp === 0x0a || cp === 0x09) {
          out += ch;
          break;
        }
        if (cp < 0x20) {
          // other C0 controls: drop
          break;
        }
        if (cp === 0x7f) {
          // DEL: drop
          break;
        }
        if (approval && isApprovalStripped(cp)) {
          break;
        }
        out += ch;
        break;
      }

      case "esc": {
        if (ch === "[") {
          state = "csi";
          break;
        }
        if (ch === "]" || ch === "P" || ch === "_" || ch === "^" || ch === "X") {
          // 7-bit OSC, DCS, APC, PM, SOS introducers
          state = "string";
          break;
        }
        if (ch === "\\") {
          // stray string terminator with no open string: drop, back to ground
          state = "ground";
          break;
        }
        if (isIntermediateByte(cp)) {
          state = "escIntermediate";
          break;
        }
        if (isGenericFinalByte(cp)) {
          // single-byte escape sequence (e.g. ESC 7, ESC c): fully consumed
          state = "ground";
          break;
        }
        // malformed (e.g. ESC followed by a control character): drop the lone ESC and
        // reprocess this character from ground
        state = "ground";
        i--;
        break;
      }

      case "escIntermediate": {
        if (isIntermediateByte(cp)) {
          break;
        }
        if (isGenericFinalByte(cp)) {
          state = "ground";
          break;
        }
        state = "ground";
        i--;
        break;
      }

      case "csi": {
        if (isFinalByte(cp)) {
          state = "ground";
        }
        // parameter and intermediate bytes (and anything else, for malformed input): keep consuming
        break;
      }

      case "string": {
        if (cp === 0x07) {
          // BEL terminator
          state = "ground";
          break;
        }
        if (cp === 0x9c) {
          // 8-bit ST terminator
          state = "ground";
          break;
        }
        if (cp === 0x1b) {
          state = "stringEsc";
          break;
        }
        break; // consume
      }

      case "stringEsc": {
        if (ch === "\\") {
          // 7-bit ST (ESC \) terminator
          state = "ground";
          break;
        }
        // not a valid terminator: the ESC is still inside the string; reprocess this
        // character as an ordinary string byte
        state = "string";
        i--;
        break;
      }
    }
  }

  // Any state other than "ground" at end of input means an unterminated sequence: everything
  // from its introducer onward has already been dropped (never appended to `out`), which is the
  // required behaviour.
  return out;
}
