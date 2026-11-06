/** Untrusted-text sanitizers for pane-bound output — both the report
 *  argvs and anything printed into the pane. */

/** Strip C0/C1 control bytes from untrusted text — a bead title is
 *  operator input, and an embedded ESC written to the pane is terminal
 *  injection (clear-screen, title-set, worse). */
export function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}
