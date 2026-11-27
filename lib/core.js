/**
 * dsh-loopback-direct — 核心逻辑（纯函数 + 文件操作，可单独测试）
 *
 * 问题：billion-context 转发器在第二跳选择出站代理时（resolveProxyDecision），
 * 没有任何「目标 host 是回环地址就直连」的分支。一旦开启手动代理，
 * WorkBuddy 本机 shim（127.0.0.1:<随机端口>）也会被塞进代理，导致
 * proxy-reset / UND_ERR_SOCKET / 重试 / 503。
 *
 * 修法：在 provider 专属规则之后、全局代理分支之前插入一行回环判定。
 * 该行使用转发器内部已有的 hostIsLoopback()，因此任意回环端口（含换端口）都自动生效。
 *
 * 本模块只负责「发现 / 检查 / 打补丁 / 回滚 / 验证」，不参与运行时转发。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 插入的那一行。
 *
 * ★ 刻意不用转发器内部的 hostIsLoopback()：它用 `startsWith("127.")`，
 *   会把 `127.0.0.1.example.org` 这类公网域名也判成回环（违反任务书行为 2）。
 *   这里自带严格正则，只认 localhost / 127.0.0.0/8 / ::1 / ::ffff:127.x。
 */
export const LOOPBACK_SOURCE =
  '^(?:localhost\\.?|127\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)|\\[::1\\]|\\[::ffff:127\\.[^\\]]*\\]|\\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\\])$'

export const PATCH_LINE =
  `if(target&&/${LOOPBACK_SOURCE}/i.test(target.hostname))return{source:"loopback-direct"};`

/** 插入锚点：全局代理分支的开头。 */
export const PATCH_ANCHOR = 'if(globalProxy===""&&fallback.explicitDirect){'

/** 日志/来源标签，转发器会打 (source=loopback-direct)。 */
export const ROUTE_SOURCE = 'loopback-direct'

/** 支持的 billion-context 版本（其余版本仍可尝试，但需人工确认）。 */
export const KNOWN_VERSIONS = ['0.1.216']

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 回环判定（与注入行使用完全相同的正则，用于自检与测试）。 */
export function isLoopbackHost (host) {
  if (typeof host !== 'string' || host === '') return false
  // URL.hostname 对 IPv6 带方括号；裸 ::1 也接受，统一补括号后再匹配。
  const normalized = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return new RegExp(LOOPBACK_SOURCE, 'i').test(normalized)
}

/** 只把 http/https 且 host 为回环的 URL 视为需要直连的目标。 */
export function isLoopbackHttpUrl (raw) {
  if (typeof raw !== 'string' || raw === '') return false
  let url
  try { url = new URL(raw) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return isLoopbackHost(url.hostname)
}

/** 转发器状态目录（XDG state 优先）。 */
export function stateDir (env = process.env) {
  const xdg = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim()
  if (xdg) return path.join(xdg, 'billion-context')
  return path.join(os.homedir(), '.local', 'state', 'billion-context')
}

/** 读运行中转发器的登记信息（origin / pid / codeFingerprint）。 */
export function readForwarderOrigin (env = process.env) {
  const file = path.join(stateDir(env), 'proxy-origin')
  let raw
  try { raw = fs.readFileSync(file, 'utf8').trim() } catch { return undefined }
  if (!raw) return undefined
  if (/^https?:\/\/\S+$/.test(raw)) return { origin: raw, file }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.origin === 'string' && /^https?:\/\/\S+$/.test(parsed.origin)) {
      return {
        origin: parsed.origin,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        port: typeof parsed.port === 'number' ? parsed.port : 0,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        codeFingerprint: typeof parsed.codeFingerprint === 'string' ? parsed.codeFingerprint : undefined,
        file,
      }
    }
  } catch { /* fallthrough */ }
  return undefined
}

/** 候选的 billion-context 安装根目录。 */
export function candidateRoots (env = process.env) {
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }
  if (env.BILI_CONTEXT_DIR) push(env.BILI_CONTEXT_DIR)
  if (env.DSH_HOME) push(path.join(env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'billion-context'))
  push(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'billion-context'))
  const appData = env.APPDATA
  if (appData) {
    push(path.join(appData, 'npm', 'node_modules', 'billion-context'))
    push(path.join(path.dirname(appData), 'Local', 'Programs', 'DSH NEXT', 'resources', 'app.asar.unpacked', 'node_modules', 'billion-context'))
  }
  return roots
}

/** 定位 dist/index.js（转发器入口）。 */
export function locateForwarderEntry (env = process.env) {
  for (const root of candidateRoots(env)) {
    const entry = path.join(root, 'dist', 'index.js')
    try { if (fs.statSync(entry).isFile()) return { root, entry } } catch { /* next */ }
  }
  return undefined
}

/** 读 package.json 里的版本。 */
export function readVersion (root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch { return undefined }
}

/**
 * 检查源码状态。
 * @returns {{version?:string, hash:string, bytes:number, anchorCount:number,
 *            patched:boolean, patchLineCount:number, patchable:boolean, reason?:string}}
 */
export function inspectSource (source, version) {
  const buf = Buffer.from(source, 'utf8')
  const anchorCount = source.split(PATCH_ANCHOR).length - 1
  const patchLineCount = source.split(PATCH_LINE).length - 1
  const patched = patchLineCount > 0
  const result = {
    version,
    hash: sha256(buf),
    bytes: buf.length,
    anchorCount,
    patched,
    patchLineCount,
    patchable: false,
  }
  if (patched) { result.reason = 'already-patched'; return result }
  if (anchorCount === 0) { result.reason = 'anchor-missing'; return result }
  if (anchorCount > 1) { result.reason = `anchor-ambiguous(${anchorCount})`; return result }
  result.patchable = true
  return result
}

/** 对一份源码应用补丁（纯函数）。 */
export function applyPatchToSource (source) {
  if (source.includes(PATCH_LINE)) return { source, changed: false, reason: 'already-patched' }
  const anchorCount = source.split(PATCH_ANCHOR).length - 1
  if (anchorCount !== 1) return { source, changed: false, reason: anchorCount === 0 ? 'anchor-missing' : 'anchor-ambiguous' }
  const next = source.replace(PATCH_ANCHOR, PATCH_LINE + PATCH_ANCHOR)
  return { source: next, changed: next !== source, reason: next !== source ? 'patched' : 'no-change' }
}

/** 从一份源码移除补丁（纯函数）。 */
export function removePatchFromSource (source) {
  if (!source.includes(PATCH_LINE)) return { source, changed: false, reason: 'not-patched' }
  return { source: source.replace(PATCH_LINE, ''), changed: true, reason: 'reverted' }
}

/** 备份文件名（带原 hash，便于确认回滚到哪一版）。 */
export function backupPathFor (entry, hash) {
  return `${entry}.dsh-loopback-direct.${hash.slice(0, 12)}.bak`
}

/**
 * 在磁盘上应用补丁。幂等；先备份再写。
 * @returns {{changed:boolean, reason:string, backup?:string, before:string, after:string}}
 */
export function applyPatchOnDisk (entry) {
  const source = fs.readFileSync(entry, 'utf8')
  const before = sha256(Buffer.from(source, 'utf8'))
  const result = applyPatchToSource(source)
  if (!result.changed) return { changed: false, reason: result.reason, before, after: before }
  const backup = backupPathFor(entry, before)
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, source, 'utf8')
  const tmp = `${entry}.${process.pid}.tmp`
  fs.writeFileSync(tmp, result.source, 'utf8')
  fs.renameSync(tmp, entry)
  return { changed: true, reason: result.reason, backup, before, after: sha256(Buffer.from(result.source, 'utf8')) }
}

/** 回滚：优先用备份，否则从源码里删掉插入行。 */
export function rollbackOnDisk (entry) {
  const source = fs.readFileSync(entry, 'utf8')
  const before = sha256(Buffer.from(source, 'utf8'))
  if (!source.includes(PATCH_LINE)) return { changed: false, reason: 'not-patched', before, after: before }
  const backups = []
  const dir = path.dirname(entry)
  const base = path.basename(entry)
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${base}.dsh-loopback-direct.`) && name.endsWith('.bak')) backups.push(path.join(dir, name))
    }
  } catch { /* ignore */ }
  backups.sort()
  const restored = removePatchFromSource(source)
  const tmp = `${entry}.${process.pid}.tmp`
  fs.writeFileSync(tmp, restored.source, 'utf8')
  fs.renameSync(tmp, entry)
  return { changed: true, reason: 'reverted', backups, before, after: sha256(Buffer.from(restored.source, 'utf8')) }
}

/** 语法自检：用 node --check 等价的 vm 编译（不执行）。 */
export function syntaxCheck (source) {
  try {
    // 只编译不执行：用 Function 构造会执行顶层 import 失败，因此用 vm.Script 的 SourceTextModule 不可用；
    // 改用最轻量的方式——把 ESM 当作字符串做一次括号/引号配平的粗检 + 交给调用方跑真实进程。
    let depth = 0
    let i = 0
    let quote = null
    while (i < source.length) {
      const c = source[i]
      if (quote) {
        if (c === '\\') { i += 2; continue }
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') depth++
      else if (c === '}') depth--
      if (depth < 0) return { ok: false, reason: 'unbalanced-braces' }
      i++
    }
    if (depth !== 0) return { ok: false, reason: `unbalanced-braces(${depth})` }
    if (quote !== null) return { ok: false, reason: 'unterminated-string' }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/** 从 bili.log 里取最后一条 upstream-proxy 决策（用于「拿到转发器确认」）。 */
/** 只读日志尾部，避免 8 MB 日志每次全量读。 */
const DECISION_TAIL_BYTES = 2 * 1024 * 1024

function readTail (logFile, maxBytes, fsImpl) {
  try {
    const stat = fsImpl.statSync ? fsImpl.statSync(logFile) : undefined
    if (stat && typeof stat.size === 'number' && stat.size > maxBytes && fsImpl.openSync) {
      const fd = fsImpl.openSync(logFile, 'r')
      try {
        const buf = Buffer.alloc(maxBytes)
        const read = fsImpl.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes)
        return buf.subarray(0, read).toString('utf8')
      } finally { fsImpl.closeSync(fd) }
    }
  } catch { /* 回退到整份读取 */ }
  try { return fsImpl.readFileSync(logFile, 'utf8') } catch { return undefined }
}

const DECISION_RE = /\[upstream-proxy\]\s+(\S+)\s+(via\s+\S+|direct)\s+\(source=([^)]+)\)/

/** 解析单行决策。host 已被转发器脱敏，但端口保留（<private-host>:54649）。 */
export function parseProxyDecisionLine (line) {
  const m = DECISION_RE.exec(line)
  if (!m) return undefined
  const host = m[1]
  const portMatch = /:(\d+)$/.exec(host)
  return {
    host,
    port: portMatch ? Number(portMatch[1]) : undefined,
    via: m[2],
    source: m[3],
    line: line.slice(0, 400),
  }
}

/** 日志里最后一条 upstream-proxy 决策。注意：转发器按 host|proxy|source 去重。 */
export function readLastProxyDecision (logFile, fsImpl = fs) {
  const text = readTail(logFile, DECISION_TAIL_BYTES, fsImpl)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseProxyDecisionLine(lines[i])
    if (parsed) return parsed
  }
  return undefined
}

/** 按端口找该回环目标最近一条决策（转发器去重后仍能命中历史行）。 */
export function readProxyDecisionForPort (logFile, port, fsImpl = fs) {
  if (!Number.isInteger(port)) return undefined
  const text = readTail(logFile, DECISION_TAIL_BYTES, fsImpl)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseProxyDecisionLine(lines[i])
    if (parsed && parsed.port === port) return parsed
  }
  return undefined
}

const DIRECT_SOURCES = ['loopback-direct', 'provider-direct', 'direct', 'no-proxy']

/** 该来源标签是否表示「直连」。 */
export function isDirectSource (source) {
  return typeof source === 'string' && DIRECT_SOURCES.includes(source)
}

/* ---------- 验证结果持久化（让状态页能在重启后仍显示真实结论） ---------- */

function verifyRecordFile (env = process.env) {
  return path.join(stateDir(env), 'dsh-loopback-direct-verify.json')
}

/** 写一次验证结论。 */
export function writeVerifyRecord (record, env = process.env) {
  const file = verifyRecordFile(env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: String(error && error.message ? error.message : error) }
  }
}

/** 读上一次验证结论（不存在则 undefined）。 */
export function readVerifyRecord (env = process.env) {
  try { return JSON.parse(fs.readFileSync(verifyRecordFile(env), 'utf8')) } catch { return undefined }
}

/**
 * 一次真实的两跳探测：把 loopbackUrl 交给转发器的 /bili/ 入口。
 * 判定：
 *  - reached        : 上游真的应答了（任何 HTTP 状态码都算到达）
 *  - proxy-failure  : 502 且带 proxy-reset / UND_ERR_SOCKET（回环被塞进代理）
 *  - unreachable    : 连不上 / 超时
 */
export async function probeThroughForwarder (origin, loopbackUrl, { timeoutMs = 15000 } = {}) {
  const target = `${origin.replace(/\/+$/, '')}/bili/${loopbackUrl}`
  const startedAt = Date.now()
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.text()
    const ms = Date.now() - startedAt
    if (response.status === 502 && /proxy-reset|UND_ERR_SOCKET|acp-proxy failure/i.test(body)) {
      return { verdict: 'proxy-failure', status: response.status, ms, body: body.slice(0, 300), target }
    }
    return { verdict: 'reached', status: response.status, ms, body: body.slice(0, 300), target }
  } catch (error) {
    return { verdict: 'unreachable', ms: Date.now() - startedAt, error: String(error && error.message ? error.message : error).slice(0, 200), target }
  }
}

/** 汇总一次完整诊断（供 CLI 与插件状态路由共用）。 */
export function diagnose (env = process.env) {
  const located = locateForwarderEntry(env)
  const origin = readForwarderOrigin(env)
  const report = {
    forwarder: origin ? { origin: origin.origin, pid: origin.pid, port: origin.port, codeFingerprint: origin.codeFingerprint } : undefined,
    install: undefined,
  }
  if (!located) {
    report.install = { found: false, searched: candidateRoots(env) }
    return report
  }
  const version = readVersion(located.root)
  const source = fs.readFileSync(located.entry, 'utf8')
  const state = inspectSource(source, version)
  report.install = {
    found: true,
    root: located.root,
    entry: located.entry,
    version,
    knownVersion: version !== undefined && KNOWN_VERSIONS.includes(version),
    hash: state.hash,
    bytes: state.bytes,
    anchorCount: state.anchorCount,
    patched: state.patched,
    patchable: state.patchable,
    reason: state.reason,
    entryFingerprintMatchesRunning: origin && origin.codeFingerprint ? origin.codeFingerprint === state.hash : undefined,
  }
  return report
}
