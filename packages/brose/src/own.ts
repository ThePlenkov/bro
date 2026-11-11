/** Injection-safe keyed read — `obj[key]` on outside data reaches the
 *  prototype chain (`{{__proto__}}` in a template, a `constructor`
 *  frontmatter key); the descriptor reads own properties only. This is
 *  THE way this package reads computed keys. */
export const ownValue = <T>(obj: object, key: PropertyKey): T | undefined =>
  Object.getOwnPropertyDescriptor(obj, key)?.value as T | undefined;
