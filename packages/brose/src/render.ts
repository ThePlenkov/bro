/**
 * Render — `{{key}}` string interpolation into the template body. Not
 * an md serializer: markdown-it has none by design (md→tokens only),
 * and re-serializing docs would churn git diffs.
 */
import type { Template } from './template.ts';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function render(template: Template | string, values: Record<string, unknown> = {}): string {
  const body = typeof template === 'string' ? template : template.body;
  return body.replace(PLACEHOLDER, (_m, key: string) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
