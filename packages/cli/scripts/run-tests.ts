#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function isE2eTest(name: string): boolean {
  return name.endsWith('.e2e.test.ts')
}

function shouldInclude(name: string, wantE2e: boolean): boolean {
  if (!name.match(/\.test\.ts$/)) return false
  const isE2e = isE2eTest(name)
  if (wantE2e) return isE2e
  return !isE2e
}

function walk(dir: string, pattern: string): string[] {
  const results: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }
  const wantE2e = pattern.includes('.e2e')
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      results.push(...walk(full, pattern))
      continue
    }
    if (shouldInclude(entry, wantE2e)) results.push(full)
  }
  return results
}

const pattern = process.argv[2] || 'src/**/*.test.ts'

if (pattern.includes('.e2e')) {
  const pkgDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(pkgDir, '..', '..')
  const build = spawnSync('npx', ['nx', 'run', '@broject/bro:build'], {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: process.platform === 'win32',
  })
  if (build.status !== 0) {
    // Fallback: try building from package dir if nx not available in expected form
    const build2 = spawnSync(process.execPath, ['../node_modules/.bin/tsdown', 'src/index.ts'], {
      stdio: 'inherit',
      cwd: join(pkgDir, '..'),
      shell: process.platform === 'win32',
    })
    if (build2.status !== 0 && build.status !== null) {
      // continue anyway; tests will fail clearly if dist missing
    }
  }
}

const files = walk('src', pattern).sort()

if (files.length === 0 && pattern.includes('.e2e')) {
  console.error('No E2E test files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
