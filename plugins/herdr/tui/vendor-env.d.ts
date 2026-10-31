/** Ambient Bun surface so the vendored acp-tui sources typecheck under
 *  this tsconfig — they run under Bun, which supplies both at runtime.
 *  (Not `bun-types`: its globals redeclare `ReadableStream` and collide
 *  with `node:stream/web` across the packages this tsconfig reaches.) */
// biome-ignore lint/suspicious/noExplicitAny: ambient shim over Bun's whole surface
declare const Bun: any;

declare module 'bun:ffi' {
  // biome-ignore lint/suspicious/noExplicitAny: ambient shim over Bun's ffi surface
  export const dlopen: any;
  // biome-ignore lint/suspicious/noExplicitAny: ambient shim over Bun's ffi surface
  export const FFIType: any;
  // biome-ignore lint/suspicious/noExplicitAny: ambient shim over Bun's ffi surface
  export const read: any;
  export class Pointer {}
}
