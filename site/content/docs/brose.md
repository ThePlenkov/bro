---

title: Brose — markdown template engine
description: Generic frontmatter + section templates for markdown — parse, render, validate, create. Knows templates, not specs.
---

`@broject/brose` is the generic markdown template engine at the bottom
of bro's spec stack. It deliberately knows **templates, not specs** —
a `.spec.md` file is just a markdown file that happens to match a spec
template. Spec semantics live one layer up in
[brotocol](/docs/brotocol).

```text
bro spec        (facade)
└── @broject/brotocol   filetree protocol + the spec templates
    └── @broject/brose      this package — templates only
```

## Install

```sh
npm i @broject/brose        # library
npx @broject/brose --help   # CLI, no install
```

## CLI

The `brose` bin is intentionally thin — two verbs only. `parse`/`render`
stay SDK operations, not commands.

| Command                                             | What it does                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `brose new --template <name@version> --out <path>`  | Generate a document from a template — refuses to overwrite without `--force`; unset required fields come from `--set key=value` |
| `brose validate <file> [--template <name@version>]` | Check a document against its declared (or a given) template — exits 1 on errors, prints `path:line: rule: message`              |

`--templates-dir <dir>` extends the template lookup;
`<cwd>/.brose/templates/` is auto-prepended when it exists.

```sh
npx @broject/brose new --template brotocol/spec@1 \
  --set template=brotocol/spec@1 --set id=BRO-2 \
  --set title="Demo spec" --out demo.spec.md
```

## Templates are markdown files

A template is a declarative document schema: frontmatter declares the
field schema, the template's own headings declare the required
sections (same levels, in order).

```md
---

name: note
version: 1
fields:
title: { required: true, type: string }
status: { type: string, enum: [draft, active] }
---

# {{title}}

## Context

## Decisions
```

Documents bind themselves with `template: note@1` in frontmatter.

## Versions and template drift

Templates are addressed as `name@version`; the registry can hold
several versions side by side. A document pinning `note@1` while the
registry holds `note@2` still validates **against `@1`** — and gets a
`template-outdated` warning. That warning is the third drift axis
(beside code drift and spec-ahead drift): the mechanical trigger for
migrating a document forward instead of silently breaking it.

## SDK

```ts
import { parse, render, validate, create, createRegistry } from '@broject/brose';

const registry = createRegistry({ dirs: ['.brose/templates'] });
const doc = parse(file); // { frontmatter, sections, body }
const diags = validate(file); // Diagnostic[] — never throws
const text = create('note@1', { title: 'Hi' });
```

| Function         | Returns                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `parse`          | Frontmatter object + heading/section tree with byte positions (splice-friendly) |
| `render`         | Markdown text — `{{key}}` string interpolation, not an AST serializer           |
| `validate`       | `Diagnostic[]` — errors and warnings with file/line, never throws               |
| `create`         | New document text from a template + values                                      |
| `createRegistry` | Template registry over a set of template dirs                                   |

The parser rides `markdown-it`'s token stream, so fenced code blocks
can't fake headings, and line ranges are exact — edits stay
byte-stable where untouched (frontmatter, `bro:` comment blocks,
formatting all survive).

## Dependencies

`markdown-it`, `zod`, and `node:*` — zero `@broject/*`. The engine is
usable in any project that wants templated markdown, whether or not
bro is installed.
