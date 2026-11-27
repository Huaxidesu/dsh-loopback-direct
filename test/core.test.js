import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PATCH_LINE,
  PATCH_ANCHOR,
  isLoopbackHost,
  isLoopbackHttpUrl,
  inspectSource,
  applyPatchToSource,
  removePatchFromSource,
  syntaxCheck,
  readLastProxyDecision,
  readProxyDecisionForPort,
  parseProxyDecisionLine,
  isDirectSource,
} from '../lib/core.js'

/** 构造一份和真实 dist/index.js 同形的最小样本。 */
const sample = (extra = '') =>
  'function resolveProxyDecision(routes,globalProxy,upstreamUrl,fallback={}){' +
  'const target=targetUrl(upstreamUrl);let bestKey="";' +
  'if(bestKey){const routeProxy=routes[bestKey].proxy;if(routeProxy!==void 0){' +
  'if(!routeProxy.trim())return{source:"provider-direct"};return{proxy:parsed.url,source:"provider"}}}' +
  'if(globalProxy===""&&fallback.explicitDirect){return{source:"direct"}}' +
  'const explicit=parseHttpProxy(globalProxy,fallback.biliPort)?.url;' +
  'if(explicit)return{proxy:explicit,source:fallback.globalSource??"global"};' +
  'return autoDetectProxy(target,fallback)}' + extra

test('回环判定覆盖 localhost / 127.0.0.0/8 / ::1', () => {
  for (const host of ['localhost', 'localhost.', '127.0.0.1', '127.12.34.56', '::1', '[::1]', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1']) {
    assert.equal(isLoopbackHost(host), true, host)
  }
  // 任务书只要求 localhost / 127.0.0.0/8 / ::1；0.0.0.0 不是回环目标，按规范拒绝。
  assert.equal(isLoopbackHost('0.0.0.0'), false)
})

test('回环判定不把相似公网域名或私有网段当回环', () => {
  for (const host of ['127.0.0.1.example.org', 'localhost.example.org', 'models.example', '192.168.1.20', '10.0.0.5', '172.16.0.1', '128.0.0.1', 'notlocalhost']) {
    assert.equal(isLoopbackHost(host), false, host)
  }
})

test('只有 http/https 的回环 URL 才算回环目标', () => {
  assert.equal(isLoopbackHttpUrl('http://127.0.0.1:51023/v1'), true)
  assert.equal(isLoopbackHttpUrl('https://LOCALHOST:8000'), true)
  assert.equal(isLoopbackHttpUrl('http://[::1]:8000'), true)
  assert.equal(isLoopbackHttpUrl('ftp://localhost'), false)
  assert.equal(isLoopbackHttpUrl('invalid'), false)
  assert.equal(isLoopbackHttpUrl(''), false)
  assert.equal(isLoopbackHttpUrl('http://192.168.1.20:8000'), false)
})

test('未打补丁的源码可识别且可打补丁', () => {
  const state = inspectSource(sample(), '0.1.216')
  assert.equal(state.patched, false)
  assert.equal(state.anchorCount, 1)
  assert.equal(state.patchable, true)
})

test('打补丁把回环判定插到全局代理分支之前', () => {
  const { source, changed } = applyPatchToSource(sample())
  assert.equal(changed, true)
  assert.equal(source.includes(PATCH_LINE), true)
  const patchAt = source.indexOf(PATCH_LINE)
  const anchorAt = source.indexOf(PATCH_ANCHOR)
  assert.ok(patchAt >= 0 && patchAt < anchorAt, '回环判定必须在全局代理分支之前')
  // provider 专属分支仍然更早
  assert.ok(source.indexOf('source:"provider-direct"') < patchAt)
})

test('打补丁是幂等的', () => {
  const once = applyPatchToSource(sample())
  const twice = applyPatchToSource(once.source)
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'already-patched')
  assert.equal(twice.source, once.source)
})

test('锚点缺失或重复时拒绝打补丁', () => {
  const missing = inspectSource('function f(){return 1}', '0.1.216')
  assert.equal(missing.patchable, false)
  assert.equal(missing.reason, 'anchor-missing')
  const dup = inspectSource(sample(PATCH_ANCHOR), '0.1.216')
  assert.equal(dup.patchable, false)
  assert.equal(dup.reason, 'anchor-ambiguous(2)')
})

test('回滚移除插入行并恢复原样', () => {
  const original = sample()
  const patched = applyPatchToSource(original).source
  const reverted = removePatchFromSource(patched)
  assert.equal(reverted.changed, true)
  assert.equal(reverted.source, original)
})

test('打补丁后的源码括号配平', () => {
  const patched = applyPatchToSource(sample()).source
  assert.deepEqual(syntaxCheck(patched), { ok: true })
  assert.equal(syntaxCheck('function f(){').ok, false)
  assert.equal(syntaxCheck('const a = "unterminated').ok, false)
})

test('解析 bili.log 的最后一条 upstream-proxy 决策', () => {
  const log = [
    '2026-11-27T15:35:32.281 [info] [v=0.1.216] [upstream-proxy] <private-host>:51023 via http://<private-host>:7890/ (source=web-manual)',
    '2026-11-27T15:35:39.453 [info] [v=0.1.216] [upstream-proxy] <private-host>:51023 direct (source=provider-direct)',
  ].join('\n')
  const fs = { readFileSync: () => log }
  const decision = readLastProxyDecision('ignored', fs)
  assert.equal(decision.host, '<private-host>:51023')
  assert.equal(decision.via, 'direct')
  assert.equal(decision.source, 'provider-direct')
})

test('日志解析兼容 loopback-direct 来源标签', () => {
  const log = '2026-11-27T15:35:39.453 [info] [v=0.1.216] [upstream-proxy] <private-host>:51023 direct (source=loopback-direct)\n'
  const fs = { readFileSync: () => log }
  assert.equal(readLastProxyDecision('ignored', fs).source, 'loopback-direct')
})

test('按端口取决策：跳过被去重掉的远端行', () => {
  const log = [
    '2026-11-27T15:57:13.509 [info] [v=0.1.216] [upstream-proxy] <private-host>:54649 direct (source=loopback-direct)',
    '2026-11-27T15:57:46.288 [info] [v=0.1.216] [upstream-proxy] <private-host> via http://<private-host>:7890/ (source=web-manual)',
  ].join('\n')
  const fs = { readFileSync: () => log }
  // 最后一条是远端（无端口），按端口能拿到本机那条
  assert.equal(readLastProxyDecision('ignored', fs).source, 'web-manual')
  const byPort = readProxyDecisionForPort('ignored', 54649, fs)
  assert.equal(byPort.source, 'loopback-direct')
  assert.equal(byPort.port, 54649)
  assert.equal(byPort.via, 'direct')
})

test('按端口取决策：端口不存在时返回 undefined', () => {
  const log = '2026-11-27T15:57:13.509 [info] [v=0.1.216] [upstream-proxy] <private-host>:54649 direct (source=loopback-direct)\n'
  const fs = { readFileSync: () => log }
  assert.equal(readProxyDecisionForPort('ignored', 51023, fs), undefined)
  assert.equal(readProxyDecisionForPort('ignored', undefined, fs), undefined)
})

test('解析单行决策并抽取端口（含远端无端口的情况）', () => {
  const local = parseProxyDecisionLine('x [upstream-proxy] <private-host>:54649 via http://<private-host>:7890/ (source=web-manual)')
  assert.deepEqual({ host: local.host, port: local.port, via: local.via, source: local.source },
    { host: '<private-host>:54649', port: 54649, via: 'via http://<private-host>:7890/', source: 'web-manual' })
  const remote = parseProxyDecisionLine('x [upstream-proxy] api.anthropic.com direct (source=direct)')
  assert.equal(remote.port, undefined)
  assert.equal(remote.source, 'direct')
  assert.equal(parseProxyDecisionLine('no decision here'), undefined)
})

test('直连来源标签判定', () => {
  for (const s of ['loopback-direct', 'provider-direct', 'direct', 'no-proxy']) assert.equal(isDirectSource(s), true, s)
  for (const s of ['web-manual', 'provider', 'global', 'auto', '', undefined]) assert.equal(isDirectSource(s), false, String(s))
})
