---
name: spec
version: 1
fields:
  id: { required: true, type: string }
  title: { required: true, type: string }
  status: { required: true, type: string, enum: [draft, active, deprecated, removed] }
  area: { type: string }
  owns: { type: list }
  aliases: { type: list }
  parent: { type: string }
  superseded-by: { type: string }
---

# {{id}} — {{title}}

## Problem

## Design

## Requirements

## Verify
