# @broject/brose

Brose — a generic markdown **template engine**. It knows templates, not
specs: a `.spec.md` file is just an md file that matches a spec
template. `parse`/`render`/`validate`/`create` over frontmatter +
section structure, a `name@version` template registry, and a thin
`brose` CLI.

## CLI

```sh
brose new --template <name@version> --out <path> [--set key=value ...] [--force] [--templates-dir <dir>]
brose validate <file> [--template <name@version>] [--templates-dir <dir>]
```

`brose validate` exits 1 on errors and prints `error`/`warn` lines as
`path:line: rule: message`. `<cwd>/.brose/templates/` is auto-prepended
to the lookup dirs when present.

## Templates are md files

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

A doc binds itself with `template: note@1` frontmatter; the template's
own headings are the doc's required sections (same levels, in order).
A doc pinning `note@1` while the registry holds `note@2` still validates
against `@1` — with a `template-outdated` advisory.

## API

```ts
import { parse, render, validate, create, createRegistry } from '@broject/brose';

const registry = createRegistry({ dirs: ['.brose/templates'] });
const doc = parse(file); // { frontmatter, sections, body }
const diags = validate(file); // Diagnostic[] — never throws
const text = create('note@1', { title: 'Hi' });
```
