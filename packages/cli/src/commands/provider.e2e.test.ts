/** `bro provider` e2e — the real built CLI as a long-running child:
 *  the host listener binds, publishes provider.json under XDG state,
 *  guards + proxies /v1/*, and the token/url/env helpers resolve
 *  through the same file. No chdir — the child takes `cwd`; the
 *  parent only cleans up. */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_DIST, e2eEnv, initRepo, runCli, tmpDir } from './testrepo.ts'

/** Spawn `bro provider serve` and resolve once stdout reports the URL. */
function startProvider(
  cwd: string,
  env: Record<string, string>
): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST, 'provider', 'serve', '--port', '0'], {
      cwd,
      env: e2eEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    // every reject path kills the child — an orphaned listener outlives
    // the fixture its caller is about to rmSync
    function fail(e: Error): void {
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(e)
    }
    const timer = setTimeout(
      () =>
        fail(new Error(`provider serve never reported a URL — stdout: ${out} stderr: ${err}`)),
      15_000
    )
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString('utf8')
      const m = /bro provider — (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ child, url: m[1]! })
      }
    })
    child.stderr!.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    child.once('exit', (code) => {
      fail(new Error(`provider serve exited ${code} before binding — ${err}`))
    })
  })
}

async function stop(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('provider serve did not exit on SIGTERM')),
      10_000
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

describe('bro provider e2e', () => {
  test('host listener: binds, guards+proxies /v1/*, publishes provider.json; helpers resolve it', async () => {
    const stateDir = tmpDir('bro-provider-e2e-state-')
    const cwd = tmpDir('bro-provider-e2e-cwd-') // deliberately NOT a repo
    // a fake upstream asserts the credential swap end-to-end
    let gotHeaders: IncomingMessage['headers'] = {}
    let gotUrl = ''
    const upstream = createServer((req, res) => {
      gotHeaders = req.headers
      gotUrl = req.url ?? ''
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"id":"msg_e2e"}')
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`

    const env = {
      XDG_STATE_HOME: stateDir,
      BRO_PROVIDER_API_KEY: 'sk-e2e',
      BRO_PROVIDER_UPSTREAM: upstreamUrl,
    }
    const { child, url } = await startProvider(cwd, env)
    try {
      // discovery file — owner-only, carries the token helpers read
      const stateFile = join(stateDir, 'bro', 'provider.json')
      assert.equal(existsSync(stateFile), true)
      assert.equal(statSync(stateFile).mode & 0o077, 0)
      const st = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        pid: number
        url: string
        token: string
      }
      assert.equal(st.pid, child.pid)
      assert.equal(st.url, url)

      // thin host: index + health answer, facade planes don't exist
      assert.equal((await fetch(`${url}/api/v1/health`)).status, 200)
      assert.equal((await fetch(`${url}/api/v1/agents`)).status, 404)

      // /v1/* guarded: no token → 401; x-api-key → proxied to upstream
      const anon = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(anon.status, 401)
      const ok = await fetch(`${url}/v1/messages?x=1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': st.token,
          'anthropic-version': '2023-06-01',
        },
        body: '{"messages":[]}',
      })
      assert.equal(ok.status, 200)
      assert.deepEqual(await ok.json(), { id: 'msg_e2e' })
      assert.equal(gotUrl, '/v1/messages?x=1')
      assert.equal(gotHeaders['x-api-key'], 'sk-e2e')
      assert.equal(gotHeaders['anthropic-version'], '2023-06-01')

      // helpers resolve through the same state file — cwd is NOT a
      // repo, so the host listener is the only candidate
      const tok = runCli(['provider', 'token'], { cwd, env })
      assert.equal(tok.code, 0)
      assert.equal(tok.stdout.trim(), st.token)
      const urlOut = runCli(['provider', 'url'], { cwd, env })
      assert.equal(urlOut.stdout.trim(), url)
      // the apiKeyHelper path — ANTHROPIC_BASE_URL pins by exact match
      const pinned = runCli(['provider', 'token'], {
        cwd,
        env: { ...env, ANTHROPIC_BASE_URL: url },
      })
      assert.equal(pinned.stdout.trim(), st.token)
      // env --json prints the settings.json block verbatim
      const block = runCli(['provider', 'env', '--json'], { cwd, env })
      assert.deepEqual(JSON.parse(block.stdout), {
        env: { ANTHROPIC_BASE_URL: url },
        apiKeyHelper: 'bro provider token',
      })

      // a second listener refuses while the first is live
      const dup = runCli(['provider', 'serve', '--port', '0'], { cwd, env })
      assert.equal(dup.code, 1)
      assert.match(dup.stderr, /already serving/)

      await stop(child)
      // shutdown retracts the discovery file
      assert.equal(existsSync(stateFile), false)
      // and with nothing live, token fails closed — never a wrong key
      const dead = runCli(['provider', 'token'], { cwd, env })
      assert.equal(dead.code, 1)
      assert.match(dead.stderr, /no live provider/)
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL')
      }
      upstream.close()
    }
  })

  test('a repo serve with provider wired wins cwd-aware resolution; the env pin overrides it', async () => {
    const stateDir = tmpDir('bro-provider-repo-state-')
    const { root, main } = initRepo('bro-provider-repo-')
    try {
      // record a provider-wired repo serve for THIS pid — live enough
      // for the resolver, no server needed
      const serveState = join(main, '.git', 'bro')
      mkdirSync(serveState, { recursive: true })
      writeFileSync(
        join(serveState, 'serve.json'),
        JSON.stringify({
          pid: process.pid,
          url: 'http://127.0.0.1:9100',
          dir: main,
          startedAt: 't',
          token: 'repo-tok',
          provider: true,
        })
      )
      // no host listener live — the repo serve is the pick
      const env = { XDG_STATE_HOME: stateDir }
      const tok = runCli(['provider', 'token'], { cwd: main, env })
      assert.equal(tok.code, 0)
      assert.equal(tok.stdout.trim(), 'repo-tok')
      // the env pin names a different (live) listener → it wins
      const pinned = runCli(['provider', 'token'], {
        cwd: main,
        env: { ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9100' },
      })
      assert.equal(pinned.stdout.trim(), 'repo-tok')
      // …and names no listener → fail closed
      const miss = runCli(['provider', 'token'], {
        cwd: main,
        env: { ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:6666' },
      })
      assert.equal(miss.code, 1)
      assert.match(miss.stderr, /no live bro provider listener/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('serve refuses to start with no upstream credential', () => {
    const stateDir = tmpDir('bro-provider-nokey-')
    const cwd = tmpDir('bro-provider-nokey-cwd-')
    const r = runCli(['provider', 'serve', '--port', '0'], {
      cwd,
      env: { XDG_STATE_HOME: stateDir },
    })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /no upstream credential/)
  })
})
