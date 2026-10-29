#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

function walk(dir, pattern) {
  const results = []
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) {
          results.push(...walk(full, pattern))
        } else if (entry.match(/\.test\.ts$/)) {
          if (pattern.includes('.e2e')) {
            if (entry.endsWith('.e2e.test.ts')) results.push(full)
          } else {
            if (!entry.endsWith('.e2e.test.ts')) results.push(full)
          }
        }
      } catch {}
    }
  } catch {}
  return results
}

const pattern = process.argv[2] || 'src/**/*.test.ts'
const files = walk('src', pattern).sort()

if (files.length === 0 && pattern.includes('.e2e')) {
  console.error('No E2E test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
