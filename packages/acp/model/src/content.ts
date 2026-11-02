// Helpers for turning ACP content blocks into sanitised, renderer-independent text.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import { sanitise } from "./sanitiser.ts";

/**
 * Decision (task 3.2): a message or thought chunk's `content` is usually a text block, but the
 * ACP v1 `ContentBlock` union also allows image, audio, resource link and embedded resource
 * blocks. Rather than dropping these silently, the reducer represents them as a short, sanitised
 * bracketed placeholder appended to the accumulated text (e.g. "[image: image/png]"), so the
 * renderer shows that something arrived even though Phase 0 does not render the payload itself.
 */
export function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return sanitise(block.text);
    case "image":
      return block.mimeType ? `[image: ${sanitise(block.mimeType)}]` : "[image]";
    case "audio":
      return block.mimeType ? `[audio: ${sanitise(block.mimeType)}]` : "[audio]";
    case "resource_link":
      return `[resource: ${sanitise(block.name)}]`;
    case "resource":
      return "[embedded resource]";
    default:
      return "[unknown content]";
  }
}
