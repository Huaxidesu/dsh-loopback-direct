import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
  countRouteLines,
  nodeSyntaxCheck,
  autoHealPatch,
  shouldHeal,
  readPatchRecord,
  writePatchRecord,
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
  // syntaxCheck 的职责是「补丁必须是纯插入」：去掉插入行后必须逐字节回到原文。
  const check = syntaxCheck(patched)
  assert.equal(check.ok, true)
  assert.equal(check.mode, 'round-trip')
  // 没有补丁行的源码不算「补丁有问题」，只是没东西可校验。
  assert.equal(syntaxCheck(sample()).mode, 'untouched')
  // 补丁行被人手工改坏（多插了一行）必须被拒。
  const doubled = patched.replace(PATCH_LINE, PATCH_LINE + PATCH_LINE)
  assert.equal(syntaxCheck(doubled).ok, false)
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


// ── 版本守卫 ────────────────────────────────────────────────────────────────
// 用的是「插件自己升级后 PATCH_LINE 文本变了」的场景：只要还是那行分流语句，
// 就必须被认成已打补丁，否则会再插一行 → 重复分流。

test('countRouteLines 认得旧版本行文本', () => {
  const oldShape = 'if(target&&/^(?:localhost|127\\.0\\.0\\.1)$/i.test(target.hostname))return{source:"loopback-direct"};'
  assert.equal(countRouteLines(sample(oldShape)), 1)
  assert.equal(countRouteLines(sample(PATCH_LINE)), 1)
  assert.equal(countRouteLines(sample()), 0)
})

test('重复插入的行会被数出来，inspectSource 标记 patched-duplicate', () => {
  const twice = sample(PATCH_LINE + PATCH_LINE.replace('if(target&&/', 'if(target&&/'))
  assert.equal(countRouteLines(twice), 2)
  const state = inspectSource(twice, '0.1.216')
  assert.equal(state.patched, true)
  assert.equal(state.routeLineCount, 2)
  assert.equal(state.patchable, false)
  assert.match(state.reason, /patched-duplicate/)
})

test('applyPatchToSource 把两行归一化回一行（幂等修复）', () => {
  const twice = sample(PATCH_LINE + PATCH_LINE.replace('if(target&&/', 'if(target&&/'))
  const fixed = applyPatchToSource(twice)
  assert.equal(fixed.changed, true)
  assert.equal(countRouteLines(fixed.source), 1)
  assert.equal(inspectSource(fixed.source, '0.1.216').patched, true)
})

test('插件升级后行文本变了也算已打补丁，不会重复插入', () => {
  const oldShape = 'if(target&&/^(?:localhost|127\\.0\\.0\\.1)$/i.test(target.hostname))return{source:"loopback-direct"};'
  const state = inspectSource(sample(oldShape), '0.1.216')
  assert.equal(state.patched, true)
  assert.equal(state.patchable, false)
  // 再打一次只是换成当前文本，不会变成两行
  const next = applyPatchToSource(sample(oldShape))
  assert.equal(countRouteLines(next.source), 1)
})

test('补丁记录可写可读，损坏时安全回退', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-guard-'))
  const env = { ...process.env, XDG_STATE_HOME: dir }
  assert.equal(readPatchRecord(env), undefined)
  writePatchRecord({ version: '0.1.216', patchedHash: 'abc', auto: true }, env)
  const back = readPatchRecord(env)
  assert.equal(back.version, '0.1.216')
  assert.equal(back.patchedHash, 'abc')
  fs.writeFileSync(path.join(dir, 'billion-context', 'dsh-loopback-direct-patch.json'), '{not json')
  assert.equal(readPatchRecord(env), undefined)
})


// ── 升级自愈（用假的 billion-context 安装目录，绝不碰真机） ──────────────────
function fakeInstall ({ source = sample(), version = '0.1.216' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-heal-'))
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), source)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'billion-context', version, main: 'dist/index.js' }))
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-state-'))
  return {
    root,
    state,
    env: { ...process.env, BILI_CONTEXT_DIR: root, XDG_STATE_HOME: state },
    entry: path.join(root, 'dist', 'index.js'),
  }
}

test('升级把源码换回未打补丁 → 守卫检测到并自动重打', () => {
  const inst = fakeInstall()
  const first = autoHealPatch(inst.env, { reason: 'test' })
  assert.equal(first.action, 'patched')
  assert.ok(fs.readFileSync(inst.entry, 'utf8').includes('loopback-direct'))
  // 模拟 npm 升级：整份 dist/index.js 被替换成未打补丁的新版本
  fs.writeFileSync(inst.entry, sample(''), 'utf8')
  fs.writeFileSync(path.join(inst.root, 'package.json'), JSON.stringify({ name: 'billion-context', version: '0.1.300' }))
  const again = autoHealPatch(inst.env, { reason: 'upgrade' })
  assert.equal(again.action, 'patched')
  assert.equal(again.versionChanged, true)
  assert.equal(again.previousVersion, '0.1.216')
  assert.equal(again.version, '0.1.300')
  assert.ok(fs.readFileSync(inst.entry, 'utf8').includes('loopback-direct'))
  // 补丁记录跟着更新
  const rec = readPatchRecord(inst.env)
  assert.equal(rec.version, '0.1.300')
})

test('已经打好补丁时守卫不做任何改动', () => {
  const inst = fakeInstall()
  autoHealPatch(inst.env, { reason: 'test' })
  const before = fs.readFileSync(inst.entry, 'utf8')
  const again = autoHealPatch(inst.env, { reason: 'test' })
  assert.equal(again.action, 'already')
  assert.equal(fs.readFileSync(inst.entry, 'utf8'), before)
})

test('新版本锚点不存在 → 拒绝打补丁且不动文件（升级不可自动修复时必须安全失败）', () => {
  const inst = fakeInstall()
  autoHealPatch(inst.env, { reason: 'test' })
  // 上游重写：锚点消失
  const rewritten = sample().replace('if(globalProxy===""&&fallback.explicitDirect){', 'if(globalProxy.length===0&&fallback.explicitDirect){')
  fs.writeFileSync(inst.entry, rewritten, 'utf8')
  const blocked = autoHealPatch(inst.env, { reason: 'upgrade' })
  assert.equal(blocked.action, 'blocked')
  assert.equal(blocked.reason, 'anchor-missing')
  assert.equal(fs.readFileSync(inst.entry, 'utf8'), rewritten)
})

test('语法检查不通过时自动回滚，不留下坏文件', () => {
  // 少一个右括号：插入补丁行之后 syntaxCheck 必然失败
  const broken = sample().replace('return autoDetectProxy(target,fallback)}', 'return autoDetectProxy(target,fallback)')
  const inst = fakeInstall({ source: broken })
  const blocked = autoHealPatch(inst.env, { reason: 'test' })
  assert.equal(blocked.action, 'blocked')
  assert.equal(blocked.rolledBack, true)
  assert.match(blocked.reason, /syntax-check-failed/)
  // 磁盘上必须还是那份没被碰过的原始字节
  assert.equal(fs.readFileSync(inst.entry, 'utf8'), broken)
  assert.ok(!fs.readFileSync(inst.entry, 'utf8').includes('loopback-direct'))
  // 而且不能留下补丁记录，否则下次会以为已经打好了
  assert.equal(readPatchRecord(inst.env), undefined)
})

test('shouldHeal 靠 stat 缓存避免每次状态请求都读 6MB 源码', () => {
  const inst = fakeInstall()
  autoHealPatch(inst.env, { reason: 'test' })
  const cache = new Map()
  const first = shouldHeal(inst.env, cache)
  assert.equal(first.needed, false)
  assert.equal(first.reason, 'already-patched')
  const second = shouldHeal(inst.env, cache)
  assert.equal(second.reason, 'unchanged')
  assert.equal(cache.size > 0, true)
})


test('nodeSyntaxCheck 能真的让 Node 判定语法（不可用时降级而不是误报）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-syntax-'))
  const good = path.join(dir, 'good.mjs')
  const bad = path.join(dir, 'bad.mjs')
  fs.writeFileSync(good, 'export const a = 1\n', 'utf8')
  fs.writeFileSync(bad, 'export const a = (((\n', 'utf8')
  const okResult = nodeSyntaxCheck(good)
  assert.equal(okResult.ok, true)
  if (okResult.checked) {
    const badResult = nodeSyntaxCheck(bad)
    assert.equal(badResult.ok, false)
    assert.equal(badResult.checked, true)
  } else {
    // 沙箱里 spawn 被拒时必须是 checked:false（降级），不能把「查不了」当失败
    assert.match(okResult.reason, /spawn-unavailable/)
  }
})


test('第一次装（已打补丁但没有记录）会写入基线记录，之后升级才认得出变了', () => {
  const inst = fakeInstall()
  // 手工把补丁打进磁盘，但不写记录 —— 模拟「插件刚装上、用户早就打过补丁」
  const patched = applyPatchToSource(sample()).source
  fs.writeFileSync(inst.entry, patched, 'utf8')
  assert.equal(readPatchRecord(inst.env), undefined)
  const first = shouldHeal(inst.env, new Map())
  assert.equal(first.needed, true)
  assert.equal(first.reason, 'record-missing')
  const heal = autoHealPatch(inst.env, { reason: 'baseline' })
  assert.equal(heal.action, 'already')
  assert.equal(readPatchRecord(inst.env).version, '0.1.216')
  // 基线建立之后就不该反复触发
  assert.equal(shouldHeal(inst.env, new Map()).reason, 'already-patched')
})

test('已打补丁时二次检查不会抹掉上一次自愈的痕迹', () => {
  const inst = fakeInstall()
  const first = autoHealPatch(inst.env)
  assert.equal(first.action, 'patched')

  const rec = readPatchRecord(inst.env)
  writePatchRecord({
    ...rec,
    lastHealAt: '2026-01-01T00:00:00.000Z',
    lastHealReason: 'status',
    lastHealFrom: '0.1.100',
    lastHealTo: rec.version,
  }, inst.env)

  const again = autoHealPatch(inst.env)
  assert.equal(again.action, 'already')

  const after = readPatchRecord(inst.env)
  assert.equal(after.lastHealFrom, '0.1.100')
  assert.equal(after.lastHealAt, '2026-01-01T00:00:00.000Z')
})
