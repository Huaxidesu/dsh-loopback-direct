/**
 * 用假的 Cordis ctx 验证 Host 侧接线（不需要重启 DSH）。
 * 检查：apply 不抛、两条路由都注册、路由行为正确。
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { apply, inject } from '../index.js'

const routes = []
const effects = []

const ctx = {
  inject (deps, fn) {
    assert.deepEqual(deps, ['webServer'], 'inject 必须是 webServer')
    fn(serverCtx)
  },
  effect (fn, label) {
    effects.push(label)
    return fn()
  },
  webServer: undefined,
}

const serverCtx = {
  effect (fn, label) {
    effects.push(label)
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register (route) {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)

assert.equal(inject.length, 0, 'inject 导出应为空数组（不强制依赖宿主服务）')
assert.equal(routes.length, 2, '应注册两条路由')
assert.equal(routes[0].path, '/plugins/dsh-loopback-direct/status')
assert.equal(routes[1].path, '/plugins/dsh-loopback-direct/action')
assert.equal(routes[0].kind, 'exact')
assert.equal(routes[1].kind, 'exact')
assert.ok(effects.length >= 2, '应有 effect 包裹')

/** 起一个真 HTTP server，把路由挂上去，用真请求验证。 */
const server = http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0]
  const route = routes.find((r) => r.path === path)
  if (!route) { res.writeHead(404); res.end('nope'); return }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500); res.end(String(error))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`

// 1) status
let response = await fetch(`${base}/plugins/dsh-loopback-direct/status`)
assert.equal(response.status, 200)
const status = await response.json()
assert.equal(status.ok, true)
assert.equal(status.plugin, 'dsh-loopback-direct')
assert.ok(status.install, 'status 必须带 install')
assert.ok(status.install.found, '本机应能找到 billion-context 安装')
assert.equal(typeof status.install.patchable, 'boolean')
assert.ok(status.flags, 'status 必须带 flags')
for (const key of ['running', 'patched', 'patchable', 'restartPending', 'confirmed']) {
  assert.equal(typeof status.flags[key], 'boolean', `flags.${key} 必须是 boolean`)
}

// 2) 方法闸
response = await fetch(`${base}/plugins/dsh-loopback-direct/status`, { method: 'POST' })
assert.equal(response.status, 405)
response = await fetch(`${base}/plugins/dsh-loopback-direct/action`)
assert.equal(response.status, 405)

// 3) 非法 action
response = await fetch(`${base}/plugins/dsh-loopback-direct/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'nope' }),
})
assert.equal(response.status, 400)
const bad = await response.json()
assert.match(bad.error, /patch, revert or verify/)

// 4) 未知路径
response = await fetch(`${base}/plugins/dsh-loopback-direct/nothing`)
assert.equal(response.status, 404)

// 5) verify（真实跑一次：本机转发器在跑，会走真实 /bili/ 两跳）
response = await fetch(`${base}/plugins/dsh-loopback-direct/action`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'verify' }),
})
assert.equal(response.status, 200)
const verified = await response.json()
assert.equal(verified.ok, true, `verify 应成功：${JSON.stringify(verified).slice(0, 300)}`)
assert.ok(verified.probe, 'verify 必须带 probe')
assert.ok(['reached', 'proxy-failure', 'unreachable'].includes(verified.probe.verdict), verified.probe.verdict)
assert.equal(typeof verified.confirmed, 'boolean')
console.log('verify:', JSON.stringify({
  upstream: verified.upstream,
  verdict: verified.probe.verdict,
  status: verified.probe.status,
  ms: verified.probe.ms,
  decision: verified.lastDecision && verified.lastDecision.source,
  confirmed: verified.confirmed,
}))

server.close()
console.log('host wiring ok: 2 routes, status/action/verify 全部符合预期')
