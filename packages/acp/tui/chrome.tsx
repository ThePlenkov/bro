/**
 * The pane's chrome — the bars that never scroll: the header's
 * name/worktree/agent/LED line, the footer's key hints + toast,
 * and the composer's strip (permission bar, input, queue line).
 */

import { TextAttributes } from '@opentui/core';
import { Show } from 'solid-js';
import { ledColor, type PaneMeta, theme } from '../session/src/index.ts';
import { livePermissionLine, liveQueueLine } from './live.ts';
import type { ComposerProps } from './pane-model.ts';

/** The header bar — the pane's name, its worktree + agent, and the
 *  LED chip it reports upstream. Slim, surface-backed, one line. */
export function HeaderBar(props: { meta: PaneMeta }) {
  const slug = () => {
    const w = props.meta.worktree;
    return w === '' ? '…' : (w.split('/').filter(Boolean).pop() ?? w);
  };
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      minHeight={1}
      backgroundColor={theme.surface}
      flexShrink={0}
    >
      <text fg={theme.accent} attributes={TextAttributes.BOLD} content=" bro: session" />
      <text fg={theme.muted} content={` — ${slug()}`} />
      <Show when={props.meta.agent !== ''}>
        <text fg={theme.muted} content={` · ${props.meta.agent}`} />
      </Show>
      <box flexGrow={1} />
      <text fg={ledColor(props.meta.led)} content="● " />
      <text
        fg={theme.muted}
        content={`${props.meta.led}${props.meta.mode !== '' ? ` · ${props.meta.mode}` : ''} `}
      />
    </box>
  );
}

/** The footer — the key hints, dim, one line; a toast ('copied')
 *  replaces them while it's set. Their bottom-right `path:branch`
 *  status maps to the worktree slug. */
export function FooterBar(props: { toast: () => string; meta: PaneMeta }) {
  const slug = () => {
    const w = props.meta.worktree;
    return w === '' ? '' : (w.split('/').filter(Boolean).pop() ?? w);
  };
  return (
    <box
      flexDirection="row"
      width="100%"
      height={1}
      minHeight={1}
      flexShrink={0}
      backgroundColor={theme.base}
    >
      <Show
        when={props.toast() === ''}
        fallback={<text fg={theme.accent} content={`  ${props.toast()}`} />}
      >
        <text
          fg={theme.muted}
          content="j/k select+peek · Enter/Space/c fold · a expand-all · z collapse-all · Ctrl+C copy row"
        />
      </Show>
      <box flexGrow={1} />
      <text fg={theme.muted} content={slug()} />
    </box>
  );
}

/**
 * The composer's strip — the permission bar, the input line and the
 * queue's line. Pinned above the header, so it never scrolls away:
 * the human must always see what their words are waiting for.
 */
export function ComposerBar(props: ComposerProps) {
  const ask = () => props.permission();
  const queueLine = () => liveQueueLine(props.queue());
  return (
    <box flexDirection="column" width="100%" flexShrink={0} backgroundColor={theme.surface}>
      <Show when={ask() !== undefined}>
        <box flexDirection="row" width="100%" height={1} minHeight={1} flexShrink={0}>
          <text fg={theme.warning} content={livePermissionLine(ask())} />
        </box>
      </Show>
      <box flexDirection="row" width="100%" height={1} minHeight={1} flexShrink={0}>
        <text
          fg={props.composing() ? theme.peach : theme.muted}
          content={props.composing() ? '› ' : '· '}
        />
        <input
          ref={el => props.onInput?.(el)}
          focused={props.composing()}
          onSubmit={props.onSubmit}
          placeholder={props.placeholder ?? 'press i to write a prompt…'}
          flexGrow={1}
          backgroundColor={theme.surface}
          focusedBackgroundColor={theme.surface}
          textColor={theme.text}
          focusedTextColor={theme.text}
          placeholderColor={theme.muted}
        />
      </box>
      <Show when={queueLine() !== ''}>
        <box flexDirection="row" width="100%" height={1} minHeight={1} flexShrink={0}>
          <text fg={theme.info} content={queueLine()} />
        </box>
      </Show>
    </box>
  );
}
