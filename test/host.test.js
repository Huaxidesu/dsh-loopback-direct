import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { apply, inject } from '../index.js'
import { PATCH_ANCHOR, PATCH_LINE, inspectSource, readVerifyRecord, stateDir } from '../lib/core.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-host-'))
const dist = path.join(temp, 'fake-package', 'dist')
const fixtureEnv = {
  BILI_CONTEXT_DIR: path.dirname(dist),
  XDG_STATE_HOME: path.join(temp, 'state'),
  DSH_LOOPBACK_DIRECT_NO_AUTOHEAL: '1',
}
const priorEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]))
Object.assign(process.env, fixtureEnv)

const pluginPath = '/plugins/dsh-loopback-direct'
const routes = new Map()
const ctx = {
  inject (deps, fn) {
    assert.deepEqual(deps, ['webServer'])
    fn(ctx)
  },
  effect (fn) { return fn() },
  webServer: {
    register (route) {
      assert.equal(route.kind, 'exact')
      assert.ok(!routes.has(route.path))
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
}

let server
try {
  apply(ctx)
  assert.deepEqual(inject, [])
  assert.deepEqual([...routes.keys()].sort(), ['action', 'release', 'status'].map(key => `${pluginPath}/${key}`))

  fs.mkdirSync(dist, { recursive: true })
  fs.mkdirSync(stateDir(), { recursive: true })
  const version = '0.1.216'
  const source = `function decision (target, globalProxy, fallback) {${PATCH_LINE}${PATCH_ANCHOR}}}`
  fs.writeFileSync(path.join(dist, 'index.js'), source)
  fs.writeFileSync(path.join(path.dirname(dist), 'package.json'), JSON.stringify({ version }))
  const target = 'http://127.0.0.1:47199'
  server = http.createServer((req, res) => {
    if (req.url === '/__bili/upstream') {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ mode: 'direct', connectionUrl: `${target}/v1/chat/completions` }))
    }
    if (req.url === `/bili/${target}/v1/models`) {
      res.writeHead(401)
      return res.end('upstream authentication required')
    }
    const route = routes.get(req.url)
    if (!route) { res.writeHead(404); return res.end() }
    Promise.resolve(route.handler(req, res)).catch(error => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  fs.writeFileSync(path.join(stateDir(), 'proxy-origin'), JSON.stringify({
    origin, codeFingerprint: inspectSource(source, version).hash,
  }))
  const get = (url, init) => fetch(`${origin}${pluginPath}/${url}`, { ...init, signal: AbortSignal.timeout(5000) })
  const action = (name) => get('action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name }),
  })

  let response = await get('status')
  assert.equal(response.status, 200)
  const status = await response.json()
  assert.equal(status.plugin, 'dsh-loopback-direct')
  assert.equal(status.install.root, fixtureEnv.BILI_CONTEXT_DIR)
  assert.equal(status.flags.patched, true)
  assert.equal(status.flags.restartPending, false)
  assert.equal(status.flags.confirmed, false)
  assert.equal((await get('status', { method: 'POST' })).status, 405)
  assert.equal((await get('action')).status, 405)
  assert.equal((await get('release', { method: 'POST' })).status, 405)
  assert.equal((await get('unknown')).status, 404)

  response = await action('unknown')
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /patch, revert or verify/)
  response = await action('verify')
  assert.equal(response.status, 200)
  const verification = await response.json()
  assert.equal(verification.ok, true)
  assert.equal(verification.probe.status, 401)
  assert.equal(verification.probe.verdict, 'reached')
  assert.equal(verification.confirmed, true)
  assert.equal(readVerifyRecord().port, 47199)
  assert.equal((await (await get('status')).json()).flags.confirmed, true)
  console.log('host wiring ok: status, release, actions, and isolated verification')
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
