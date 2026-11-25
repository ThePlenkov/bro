/**
 * The pane's syntax palette — one `SyntaxStyle` so every markdown
 * and code renderable in the tree speaks the same colors.
 */

import type { NativeResourceOwner } from '@opentui/core';
import { SyntaxStyle } from '@opentui/core';
import { theme } from '../session/src/index.ts';

/** The markdown/code/diff style derived from the palette. */
export function syntaxStyle(owner: NativeResourceOwner): SyntaxStyle {
  return SyntaxStyle.fromStyles(
    {
      'markup.heading': { fg: theme.emph, bold: true },
      'markup.bold': { fg: theme.emph },
      'markup.italic': { fg: theme.muted },
      'markup.raw': { fg: theme.success },
      'markup.quote': { fg: theme.muted },
      'markup.link': { fg: theme.cyan, underline: true },
      'markup.list': { fg: theme.peach },
      keyword: { fg: theme.cyan },
      string: { fg: theme.success },
      comment: { fg: theme.muted },
      number: { fg: theme.warning },
      'diff.plus': { fg: theme.success },
      'diff.minus': { fg: theme.error },
      'diff.delta': { fg: theme.info },
    },
    owner
  );
}
