/**
 * Action `board` — open the board pane (plugin pane open is a CLI call
 * like any other; the pane itself does the rendering).
 */
import { herdr } from './lib.ts';

const res = herdr<{ pane_id?: string }>([
  'plugin',
  'pane',
  'open',
  '--plugin',
  process.env.HERDR_PLUGIN_ID ?? 'bro.fleet',
  '--entrypoint',
  'board',
]);
console.log(`board → ${res.pane_id ?? 'opened'}`);
