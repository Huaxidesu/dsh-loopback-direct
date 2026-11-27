/**
 * dsh-loopback-direct — Host half.
 *
 * 职责：
 *  1. 状态路由：/plugins/dsh-loopback-direct/status（诊断和升级监护）
 *  2. 动作路由：/plugins/dsh-loopback-direct/action（patch / revert / verify）
 *  3. 更新检查：/plugins/dsh-loopback-direct/release（只读）
 *
 * ★ 本插件不参与运行时转发：真正的分流由 billion-context 转发器自己完成。
 *   我们只负责「发现 → 打补丁 → 让转发器确认 → 可回滚」这一整套可维护流程。
 * ★ 不强制依赖任何宿主服务；webServer 缺失时插件照常加载，只是没有 HTTP 面。
 */

export const inject = []

import fs from 'node:fs'

import {
  diagnose,
  locateForwarderEntry,
  applyPatchOnDisk,
  rollbackOnDisk,
  inspectSource,
  readVersion,
  readLastProxyDecision,
  readProxyDecisionForPort,
  isDirectSource,
  probeThroughForwarder,
  readVerifyRecord,
  writeVerifyRecord,
  readPatchRecord,
  writePatchRecord,
  autoHealPatch,
  shouldHeal,
  PATCH_LINE,
  stateDir,
} from './lib/core.js'
import { createReleaseChecker, describeRelease } from './lib/release.js'

const NAME = 'dsh-loopback-direct'
const STATUS_PATH = `/plugins/${NAME}/status`
const ACTION_PATH = `/plugins/${NAME}/action`
const RELEASE_PATH = `/plugins/${NAME}/release`
const runningVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const KNOWN_VERSION_NOTE = '0.1.216 已实测；其它版本请先看 status 的 patchable 字段'
/** 版本守卫的巡检间隔：billion-context 在会话中途被升级也能在半分钟内自愈。 */
const HEAL_INTERVAL_MS = 30 * 1000

/**
 * 版本守卫状态（模块级，供 status 展示）。
 *  - lastHeal : 最近一次自愈结果
 *  - healedCount : 本进程启动以来自动重新打补丁的次数
 */
const guard = { lastHeal: undefined, lastAt: 0, healedCount: 0 }
const statCache = new Map()

/**
 * 跑一次版本守卫：billion-context 被升级 → dist/index.js 换成未打补丁的新源码 → 自动重新打。
 * 幂等、静默、不抛；真要改盘时把结果记进 guard.lastHeal 给 UI 看。
 */
function runGuard (reason) {
  let look
  try {
    look = shouldHeal(process.env, statCache)
  } catch (error) {
    return { action: 'blocked', reason: 'guard-error', error: String(error && error.message ? error.message : error) }
  }
  if (!look.needed) {
    if (look.reason === 'already-patched') {
      statCache.set(look.entry, look.signature)
      const report = diagnose(process.env)
      guard.lastHeal = {
        action: 'already',
        version: report.install && report.install.version,
        at: new Date().toISOString(),
        reason: 'already-patched',
      }
      guard.lastAt = Date.now()
    }
    return guard.lastHeal
  }
  const result = autoHealPatch(process.env, { reason })
  if (result.action === 'patched') {
    guard.healedCount += 1
    if (look.entry) statCache.delete(look.entry)
  }
  guard.lastHeal = { ...result, at: new Date().toISOString() }
  guard.lastAt = Date.now()
  if (result.action === 'patched' || result.action === 'already') {
    console.log(`[${NAME}] 版本守卫：billion-context ${result.version ?? '?'} ${result.action === 'patched' ? '已自动重新打补丁' : '补丁就位'}${result.versionChanged ? `（上一次是 ${result.previousVersion}）` : ''}`)
  } else {
    console.warn(`[${NAME}] 版本守卫：无法自动打补丁（${result.reason}${result.error ? `: ${result.error}` : ''}），请在设置页手动处理`)
  }
  return guard.lastHeal
}

/** 只允许本机回环访问，避免把补丁管理暴露到局域网。 */
function requireLoopback (req, res) {
  const remote = req.socket && req.socket.remoteAddress
  const address = typeof remote === 'string' ? remote.replace(/^::ffff:/, '') : ''
  if (address === '127.0.0.1' || address === '::1' || address === 'localhost') return true
  sendJson(res, 403, { error: 'loopback only' })
  return false
}

function sendJson (res, status, body) {
  const text = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJsonBody (req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function logFile () {
  return `${stateDir(process.env)}${process.platform === 'win32' ? '\\' : '/'}bili.log`
}

/** 转发器当前的宿主连接端口（带 5s 缓存，避免每次刷新都打转发器）。 */
let upstreamCache = { at: 0, port: undefined, mode: undefined, origin: undefined }
async function currentUpstream (origin) {
  const now = Date.now()
  if (upstreamCache.origin === origin && now - upstreamCache.at < 5000) return upstreamCache
  let port
  let mode
  try {
    const response = await fetch(`${origin}/__bili/upstream`, { signal: AbortSignal.timeout(3000) })
    const body = await response.json()
    mode = typeof body.mode === 'string' ? body.mode : undefined
    if (typeof body.connectionUrl === 'string' && body.connectionUrl) {
      port = Number(new URL(body.connectionUrl).port) || undefined
    }
  } catch { /* 拿不到就退化为未知 */ }
  upstreamCache = { at: now, port, mode, origin }
  return upstreamCache
}

/**
 * 本轮守卫结果与磁盘记录的二选一。
 *
 * 本轮守卫没跑（被关掉，或这一轮什么也不用做）时，用记录里那次自愈的信息，
 * 但只在「记录里的版本就是当前磁盘版本」时才认，否则会显示过期的提示。
 */
function currentHeal (heal, patchRecord) {
  if (heal !== undefined && heal.action === 'patched') return heal
  if (heal !== undefined && heal.action === 'blocked') return heal
  if (patchRecord === undefined || patchRecord === null) return heal ?? null
  if (typeof patchRecord.lastHealTo !== 'string' || patchRecord.lastHealTo !== patchRecord.version) return heal ?? null
  if (patchRecord.version !== readVersion(locateForwarderEntry(process.env)?.root ?? '')) return heal ?? null
  return {
    action: 'patched',
    version: patchRecord.version,
    versionChanged: patchRecord.lastHealFrom !== undefined && patchRecord.lastHealFrom !== patchRecord.version,
    previousVersion: patchRecord.lastHealFrom,
    at: patchRecord.lastHealAt,
    reason: patchRecord.lastHealReason,
    from: 'record',
  }
}

/** 完整状态：诊断 + 该回环端口的最近决策 + 上一次真实验证的结论。 */
export async function buildStatus () {
  // 每次取状态先跑一遍版本守卫：这是最可靠的时机 —— 用户打开设置页、刷新、点任何按钮都会经过这里。
  // 想只看诊断不自动修复就设 DSH_LOOPBACK_DIRECT_NO_AUTOHEAL=1。
  const autoHeal = process.env.DSH_LOOPBACK_DIRECT_NO_AUTOHEAL !== '1'
  const heal = autoHeal ? runGuard('status') : undefined
  const report = diagnose(process.env)
  const inst = report.install
  const running = report.forwarder !== undefined
  const patched = Boolean(inst && inst.patched)
  const record = readVerifyRecord()
  const patchRecord = readPatchRecord()
  const fingerprint = running ? report.forwarder.codeFingerprint : undefined
  // 当前真实的回环端口：验证记录只有对得上这个端口才算数（shim 换端口后必须重验）。
  const live = running ? await currentUpstream(report.forwarder.origin.replace(/\/+$/, '')) : { port: undefined, mode: undefined }
  const livePort = live.port
  const recordPort = record && Number.isInteger(record.port) ? record.port : undefined
  const portMatches = recordPort !== undefined && (livePort === undefined || recordPort === livePort)
  const decision = (portMatches ? readProxyDecisionForPort(logFile(), recordPort) : undefined)
    ?? (livePort !== undefined ? readProxyDecisionForPort(logFile(), livePort) : undefined)
    ?? readLastProxyDecision(logFile())
  // 「分流已启用」只能由一次真实两跳探测确认，且必须同时满足：
  // 探测真的到达了上游、该端口出站决策是直连、记录写在当前这份运行代码上、端口还是当前端口。
  const confirmed = patched && running &&
    record !== undefined && record.ok === true && record.confirmed === true &&
    typeof fingerprint === 'string' && record.fingerprint === fingerprint &&
    portMatches &&
    // 代理模式变了，上一次的验证证据就不再代表当前状态。
    (live.mode === undefined || record.mode === undefined || record.mode === live.mode)
  // 刚自愈过（版本变了、补丁重打）。只有补丁后的磁盘代码与运行中实例不一致时才真的要重启：
  // 模拟/重灌同版本时磁盘内容可能和运行中实例完全相同，这时重启没有意义。
  const healedNow = heal !== undefined && heal.action === 'patched'
  // 注意顺序：守卫先跑、写入了新记录，diagnose 读到的已经是「修复后」的状态，
  // 所以版本是否变过必须从这一轮守卫的结果里取，不能只看 diagnose。
  const versionChanged = Boolean(inst && inst.versionChanged) || (heal !== undefined && heal.versionChanged === true)
  // 守卫先跑并写入新记录，diagnose 读到的 previousVersion 已经是「本轮刚写的」，
  // 所以只要本轮真的重打过，就必须用守卫自己抓到的升级前版本。
  const previousVersion = (heal !== undefined && heal.versionChanged === true)
    ? heal.previousVersion
    : ((inst && inst.previousVersion) ?? (heal !== undefined ? heal.previousVersion : undefined))
  return {
    ok: true,
    plugin: NAME,
    knownVersionNote: KNOWN_VERSION_NOTE,
    forwarder: report.forwarder ?? null,
    install: inst ?? null,
    lastDecision: decision ?? null,
    verify: record ?? null,
    patchRecord: patchRecord ?? null,
    guard: {
      enabled: autoHeal,
      // 本轮跑出来的结果优先；进程刚起来还没有结果时，回退到磁盘上记着的那次自愈，
      // 这样重启后用户仍然能看到「升级后补丁已自动补回」。
      last: currentHeal(heal, patchRecord),
      healedCount: guard.healedCount,
      lastAt: guard.lastAt ? new Date(guard.lastAt).toISOString() : null,
    },
    livePort: livePort ?? null,
    liveMode: live.mode ?? null,
    flags: {
      running,
      patched,
      patchable: Boolean(inst && inst.patchable),
      restartPending: Boolean(inst && inst.entryFingerprintMatchesRunning === false),
      healedNow,
      versionChanged,
      previousVersion: previousVersion ?? null,
      verified: Boolean(record && record.ok === true && record.confirmed === true),
      portMatches,
      modeMatches: live.mode === undefined || record === undefined || record.mode === undefined || record.mode === live.mode,
      confirmed,
    },
    logFile: logFile(),
  }
}

function registerStatusRoute (ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!requireLoopback(req, res)) return
      try {
        sendJson(res, 200, await buildStatus())
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }), `${NAME}: status route`)
}

function registerReleaseRoute (ctx) {
  const checkRelease = createReleaseChecker()
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RELEASE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!requireLoopback(req, res)) return
      const installedBundle = async () => {
        try {
          const bundles = await ctx.get('pluginManager')?.listBundles()
          return bundles?.find(bundle => bundle.name === NAME && bundle.installed)
        } catch {
          // Release discovery also works on hosts that cannot inventory the current installation.
          return undefined
        }
      }
      const [release, bundle] = await Promise.all([checkRelease(), installedBundle()])
      return sendJson(res, 200, describeRelease(release, bundle, runningVersion))
    },
  }), `${NAME}: release route`)
}

function registerActionRoute (ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (!requireLoopback(req, res)) return
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendJson(res, 400, { error: String(error && error.message ? error.message : error) })
      }
      const action = body && typeof body.action === 'string' ? body.action : ''
      try {
        if (action === 'patch') return sendJson(res, 200, doPatch())
        if (action === 'revert') return sendJson(res, 200, doRevert())
        if (action === 'verify') return sendJson(res, 200, await doVerify())
        return sendJson(res, 400, { error: 'action must be patch, revert or verify' })
      } catch (error) {
        sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
      }
    },
  }), `${NAME}: action route`)
}

function doPatch () {
  const located = locateForwarderEntry(process.env)
  if (!located) return { ok: false, reason: 'install-not-found' }
  const source = fs.readFileSync(located.entry, 'utf8')
  const state = inspectSource(source, readVersion(located.root))
  // 已打过但行数异常（多行/旧版正则）→ 归一化一次，不留重复分流。
  if (state.patched && state.routeLineCount === 1 && source.includes(PATCH_LINE)) {
    runGuard('manual-nudge')
    return { ok: true, changed: false, reason: 'already-patched', routeLineCount: state.routeLineCount }
  }
  if (!state.patched && !state.patchable) return { ok: false, reason: state.reason }
  const result = autoHealPatch(process.env, { reason: 'manual', force: true })
  if (result.action === 'blocked' || result.action === 'not-found') {
    return { ok: false, reason: result.reason ?? result.action, version: result.version }
  }
  runGuard('manual-after')
  return {
    ok: true,
    changed: result.action === 'patched',
    reason: result.action === 'patched' ? (state.patched ? 'normalized' : 'patched') : 'already-patched',
    before: result.before,
    after: result.after,
    backup: result.backup,
    version: result.version,
    versionChanged: result.versionChanged,
    previousVersion: result.previousVersion,
    routeLineCount: result.routeLineCount,
    restartRequired: result.action === 'patched',
  }
}

function doRevert () {
  const located = locateForwarderEntry(process.env)
  if (!located) return { ok: false, reason: 'install-not-found' }
  const result = rollbackOnDisk(located.entry)
  // 用户主动回滚 = 明确不要补丁：清掉记录，否则版本守卫会在下一次 status 里又打回去。
  if (result.changed) {
    writePatchRecord({
      version: readVersion(located.root),
      patchedHash: undefined,
      at: new Date().toISOString(),
      auto: false,
      reason: 'user-reverted',
    })
    guard.lastHeal = { action: 'reverted', at: new Date().toISOString() }
    guard.lastAt = Date.now()
    statCache.delete(located.entry)
  }
  return { ok: true, changed: result.changed, reason: result.reason, before: result.before, after: result.after, backups: result.backups, restartRequired: result.changed }
}

async function doVerify () {
  const report = diagnose(process.env)
  const inst = report.install
  const forwarder = report.forwarder
  if (!inst || !inst.found) return { ok: false, reason: 'install-not-found' }
  if (!forwarder) return { ok: false, reason: 'forwarder-not-running' }
  const origin = forwarder.origin.replace(/\/+$/, '')
  let upstream
  try {
    const response = await fetch(`${origin}/__bili/upstream`, { signal: AbortSignal.timeout(8000) })
    upstream = await response.json()
  } catch (error) {
    return { ok: false, reason: 'upstream-endpoint-failed', error: String(error && error.message ? error.message : error) }
  }
  let target
  if (typeof upstream.connectionUrl === 'string' && upstream.connectionUrl) {
    try { target = `${new URL(upstream.connectionUrl).origin}/v1/models` } catch { /* ignore */ }
  }
  if (!target) return { ok: false, reason: 'no-loopback-target', upstream }
  const probe = await probeThroughForwarder(origin, target, { timeoutMs: 20000 })
  let port
  try { port = Number(new URL(target).port) || undefined } catch { /* ignore */ }
  const mode = typeof upstream.mode === 'string' ? upstream.mode : undefined
  // 该回环端口自己的最近一条决策（转发器按 host|proxy|source 去重，不能取最后一行）。
  const decision = (port !== undefined ? readProxyDecisionForPort(logFile(), port) : undefined) ?? readLastProxyDecision(logFile())
  // 判定依据是可观测行为，不是日志行：
  //   转发器不挂代理（direct）时，回环目标本来就直连，到达即通过。
  //   转发器挂了代理（manual / config / auto）时，未打补丁的回环请求必定被塞进代理
  //   并从代理拿回 proxy-reset / UND_ERR_SOCKET（实测 7.1s 502）；只有分流生效才会
  //   直接到达上游（实测 401，5~40ms）。所以「挂了代理仍到达」就是分流的直接证据。
  //   日志里的 [upstream-proxy] 只作展示与佐证（转发器按 host|proxy|source 去重，不可作唯一依据）。
  const viaProxy = mode !== undefined && mode !== 'direct'
  // 磁盘上必须确实处于「已打补丁」状态，否则运行中的转发器可能是残留在内存里的旧补丁版。
  const patchedOnDisk = inst?.patched === true
  const confirmed = probe.verdict === 'reached' && patchedOnDisk
  const record = {
    ok: true,
    confirmed,
    patched: patchedOnDisk,
    mode,
    viaProxy,
    port,
    target,
    verdict: probe.verdict,
    status: probe.status,
    ms: probe.ms,
    fingerprint: forwarder.codeFingerprint,
    decision: decision ?? null,
    at: new Date().toISOString(),
  }
  writeVerifyRecord(record)
  return {
    ok: true,
    upstream: { mode: upstream.mode, source: upstream.source, proxy: upstream.proxy ?? null, connectionUrl: upstream.connectionUrl ?? null },
    probe,
    lastDecision: decision ?? null,
    patched: patchedOnDisk,
    confirmed,
  }
}

/** Cordis 插件入口。 */
export function apply (ctx) {
  ctx.inject(['webServer'], (serverCtx) => {
    registerStatusRoute(serverCtx)
    registerActionRoute(serverCtx)
    registerReleaseRoute(serverCtx)
  })
  // 没有 webServer 也不报错：CLI 仍然可用。
}

export default apply
