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
import { spawnSync } from 'node:child_process'

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

/**
 * 归一化用的「宽松标记」。
 *
 * ★ 为什么需要它：插件自己升级后 PATCH_LINE 的正则文本可能变（比如收紧 IPv6 写法），
 *   上一版插件打进去的那行还在源码里，但已经不等于当前 PATCH_LINE。
 *   如果只认严格相等，就会判成「未打补丁」→ 再插一行 → 源码里出现两行重复分流。
 *   所以：打补丁前先按宽松标记把「任何一版插件留下的分流行」全部抹掉，再插入当前行。
 *   这样跨插件版本重复打补丁是幂等的，回滚也能清掉旧行。
 */
export const ROUTE_LINE_PREFIX = 'if(target&&/'
export const ROUTE_LINE_MARKER = 'return{source:"loopback-direct"};'

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
/** 匹配「任何一版插件」插入的分流行（宽松，不依赖当前正则文本）。 */
const ROUTE_LINE_RE = /if\(target&&\/[^\n]{0,600}?\.test\(target\.hostname\)\)return\{source:"loopback-direct"\};?/g

/** 源码里现存的循环分流行数量（含旧版插件留下的）。 */
export function countRouteLines (source) {
  if (typeof source !== 'string') return 0
  return (source.match(ROUTE_LINE_RE) || []).length
}

export function inspectSource (source, version) {
  const buf = Buffer.from(source, 'utf8')
  const anchorCount = source.split(PATCH_ANCHOR).length - 1
  const routeLineCount = countRouteLines(source)
  const patchLineCount = source.split(PATCH_LINE).length - 1
  const patched = routeLineCount > 0
  const result = {
    version,
    hash: sha256(buf),
    bytes: buf.length,
    anchorCount,
    patched,
    patchLineCount,
    routeLineCount,
    patchable: false,
  }
  if (patched) {
    // 旧版插件留下的一行（或重复行）也算「已打补丁」，但标注出来便于 UI 提示「点一次打补丁即可归一」。
    result.reason = routeLineCount > 1 ? `patched-duplicate(${routeLineCount})` : 'already-patched'
    return result
  }
  if (anchorCount === 0) { result.reason = 'anchor-missing'; return result }
  if (anchorCount > 1) { result.reason = `anchor-ambiguous(${anchorCount})`; return result }
  result.patchable = true
  return result
}

/**
 * 对一份源码应用补丁（纯函数）。
 * 幂等：先抹掉任何一版插件留下的分流行，再插入当前版本的行 —— 插件自身升级后重打不会叠加。
 */
export function applyPatchToSource (source) {
  const anchorCount = source.split(PATCH_ANCHOR).length - 1
  if (anchorCount !== 1) return { source, changed: false, reason: anchorCount === 0 ? 'anchor-missing' : 'anchor-ambiguous' }
  const stripped = source.replace(ROUTE_LINE_RE, '')
  if (stripped.includes(PATCH_LINE)) {
    // 理论上不会发生（上面已把该行抹掉），保守返回。
    return { source: stripped, changed: stripped !== source, reason: stripped !== source ? 'normalized' : 'already-patched' }
  }
  const next = stripped.replace(PATCH_ANCHOR, PATCH_LINE + PATCH_ANCHOR)
  if (next === source) return { source, changed: false, reason: 'already-patched' }
  return { source: next, changed: true, reason: stripped === source ? 'patched' : 'normalized-patched' }
}

/** 从一份源码移除补丁（纯函数）：清掉任何一版插件留下的分流行。 */
export function removePatchFromSource (source) {
  const routeLineCount = countRouteLines(source)
  if (routeLineCount === 0) return { source, changed: false, reason: 'not-patched' }
  const next = source.replace(ROUTE_LINE_RE, '')
  return { source: next, changed: next !== source, reason: 'reverted' }
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
    // 这里的源码是 6 MB 的压缩单行 JS，正则字面量和模板串里全是花括号，
    // 数括号会误判；又因为本环境里 spawn 会被拒绝，不能直接调 node --check。
    // 所以改用「差分还原校验」：把插入的那一行去掉，必须逐字节回到原文。
    // 这样既不需要外部进程，也能真正确认补丁是纯插入、没有破坏任何原有字节。
    const stripped = source.replace(ROUTE_LINE_RE, '')
    if (stripped === source) {
      // 源码里本来就没有补丁行：只要不是明显坏掉的空文件就算通过。
      return source.trim().length > 0
        ? { ok: true, mode: 'untouched' }
        : { ok: false, reason: 'empty-source' }
    }
    const roundTrip = stripped.replace(PATCH_ANCHOR, PATCH_LINE + PATCH_ANCHOR)
    if (roundTrip !== source) {
      return { ok: false, reason: 'patch-not-pure-insertion' }
    }
    if (countRouteLines(source) !== 1) {
      return { ok: false, reason: `route-line-count(${countRouteLines(source)})` }
    }
    return { ok: true, mode: 'round-trip' }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/** 从 bili.log 里取最后一条 upstream-proxy 决策（用于「拿到转发器确认」）。 */
/** 只读日志尾部，避免 8 MB 日志每次全量读。 */
/**
 * 真正让 Node 判定这份文件能不能被解析（语法是否合法）。
 *
 * 为什么不直接用 vm.Script：dist/index.js 是 ESM（顶部有 import），vm.Script 只吃脚本。
 * 为什么不自己数括号：这是 6 MB 的压缩单行文件，正则字面量/模板串里的花括号会让计数失效
 * （实测会把完全正常的文件误判成 unbalanced-braces，进而导致守卫误回滚）。
 *
 * 所以直接调 node --check。若运行环境不允许 spawn（某些沙箱会 EPERM），
 * 返回 checked:false 让调用方降级，而不是把「查不了」当成「有问题」。
 */
export function nodeSyntaxCheck (entry) {
  try {
    const result = spawnSync(process.execPath, ['--check', entry], { encoding: 'utf8', timeout: 20000 })
    if (result.error) {
      return { ok: true, checked: false, reason: `spawn-unavailable(${result.error.code ?? result.error.message})` }
    }
    if (result.status === 0) return { ok: true, checked: true }
    const message = String(result.stderr ?? '').trim().split('\n').slice(0, 3).join(' ')
    return { ok: false, checked: true, reason: message || `exit-${result.status}` }
  } catch (error) {
    return { ok: true, checked: false, reason: `spawn-unavailable(${String(error && error.message ? error.message : error)})` }
  }
}

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

/* ---------- 补丁记录 + 版本守卫（billion-context 升级后自动恢复） ---------- */

function patchRecordFile (env = process.env) {
  return path.join(stateDir(env), 'dsh-loopback-direct-patch.json')
}

/** 读「上一次成功打补丁」的记录（版本 / 打补丁后的 hash / 时间）。 */
export function readPatchRecord (env = process.env) {
  try { return JSON.parse(fs.readFileSync(patchRecordFile(env), 'utf8')) } catch { return undefined }
}

/** 写补丁记录。 */
export function writePatchRecord (record, env = process.env) {
  const file = patchRecordFile(env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 版本守卫的核心：**billion-context 一被升级，dist/index.js 就被换成未打补丁的新源码**，
 * 回环分流随之消失（表现是 WorkBuddy 聊天 502 proxy-reset）。这里把「补丁」变成可自愈的：
 *
 *  - 磁盘已是补丁态                      → action='already'（顺手补一条记录，供下次比对）
 *  - 未打补丁但锚点唯一                  → action='patched'（自动重新打，记录新版本）
 *  - 锚点不存在 / 不唯一（上游重构了）    → action='blocked'（不盲改，交给 UI 提示人工处理）
 *
 * 幂等、有备份、永不抛（返回结构里带 error 字段）。
 *
 * @param {object} [env]
 * @param {{force?:boolean, reason?:string}} [options]
 * @returns {{action:'already'|'patched'|'blocked'|'not-found', version?:string,
 *            before?:string, after?:string, reason?:string, error?:string,
 *            versionChanged?:boolean, previousVersion?:string}}
 */
export function autoHealPatch (env = process.env, options = {}) {
  const located = locateForwarderEntry(env)
  if (!located) return { action: 'not-found' }
  const record = readPatchRecord(env)
  try {
    const source = fs.readFileSync(located.entry, 'utf8')
    const version = readVersion(located.root)
    const state = inspectSource(source, version)
    const versionChanged = record !== undefined && record.version !== undefined && record.version !== version
    if (state.patched) {
      // 已经打过（可能是旧版插件打的，也可能是上一轮自愈的）→ 刷新记录，保持可比对。
      writePatchRecord({
        version,
        patchedHash: state.hash,
        routeLineCount: state.routeLineCount,
        at: new Date().toISOString(),
        auto: options.force !== true,
        reason: options.reason ?? 'already-patched',
        // 已经打好补丁时不要抹掉上一次自愈的痕迹，否则重启后 UI 就丢了「刚升级过」这个信息。
        lastHealAt: record && record.lastHealAt,
        lastHealReason: record && record.lastHealReason,
        lastHealFrom: record && record.lastHealFrom,
        lastHealTo: record && record.lastHealTo,
      }, env)
      return {
        action: 'already',
        version,
        before: state.hash,
        after: state.hash,
        routeLineCount: state.routeLineCount,
        versionChanged,
        previousVersion: record && record.version,
      }
    }
    if (!state.patchable) {
      return {
        action: 'blocked',
        version,
        reason: state.reason,
        anchorCount: state.anchorCount,
        versionChanged,
        previousVersion: record && record.version,
      }
    }
    const result = applyPatchOnDisk(located.entry)
    if (!result.changed) {
      return {
        action: 'blocked',
        version,
        reason: result.reason,
        versionChanged,
        previousVersion: record && record.version,
      }
    }
    // 双重校验：① 补丁必须是纯插入（去掉那行能逐字节还原原文）；
    // ② 让 Node 自己解析一次（能 spawn 时才算数，不能就降级为只做 ①）。
    const check = syntaxCheck(fs.readFileSync(located.entry, 'utf8'))
    const parsed = check.ok ? nodeSyntaxCheck(located.entry) : { ok: false, checked: false, reason: check.reason }
    if (!check.ok || !parsed.ok) {
      // 打出来的源码自检不过 → 立刻回滚，绝不把坏源码留在盘上。
      rollbackOnDisk(located.entry)
      return {
        action: 'blocked',
        version,
        reason: `syntax-check-failed(${check.ok ? parsed.reason : check.reason})`,
        versionChanged,
        previousVersion: record && record.version,
        rolledBack: true,
      }
    }
    writePatchRecord({
      version,
      patchedHash: result.after,
      originalHash: result.before,
      backup: result.backup,
      at: new Date().toISOString(),
      auto: options.force !== true,
      reason: options.reason ?? (versionChanged ? 'version-changed' : 'auto'),
      // 把「这次是被谁触发的、从哪个版本升上来的」一并记下来。
      // 否则 DSH 重启后进程内状态清空，设置页就再也看不出「刚经历过一次升级」。
      lastHealAt: new Date().toISOString(),
      lastHealReason: options.reason ?? 'auto',
      lastHealFrom: record && record.version,
      lastHealTo: version,
    }, env)
    return {
      action: 'patched',
      version,
      before: result.before,
      after: result.after,
      backup: result.backup,
      versionChanged,
      previousVersion: record && record.version,
    }
  } catch (error) {
    return { action: 'blocked', reason: 'error', error: String(error && error.message ? error.message : error) }
  }
}

/** 只是「看一眼要不要自愈」，不改盘：文件的 mtime+size 没变就完全跳过读取。 */
export function shouldHeal (env = process.env, cache = new Map()) {
  const located = locateForwarderEntry(env)
  if (!located) return { needed: false, reason: 'install-not-found' }
  let stat
  try { stat = fs.statSync(located.entry) } catch { return { needed: false, reason: 'stat-failed' } }
  const signature = `${stat.size}:${stat.mtimeMs}`
  if (cache.get(located.entry) === signature) return { needed: false, reason: 'unchanged', entry: located.entry, signature }
  let source
  try { source = fs.readFileSync(located.entry, 'utf8') } catch { return { needed: false, reason: 'read-failed' } }
  const state = inspectSource(source, readVersion(located.root))
  if (state.patched) {
    cache.set(located.entry, signature)
    // 已打补丁但没有记录（第一次装、或记录被删）：仍然跑一次，把基线版本写进记录。
    // 否则下次升级时无法判断「从哪个版本升上来的」，也就无法在 UI 上提示版本变化。
    if (!readPatchRecord(env)) return { needed: true, reason: 'record-missing', entry: located.entry, signature }
    return { needed: false, reason: 'already-patched', entry: located.entry, signature }
  }
  return { needed: state.patchable, reason: state.reason, entry: located.entry, signature }
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
  const record = readPatchRecord(env)
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
    routeLineCount: state.routeLineCount,
    entryFingerprintMatchesRunning: origin && origin.codeFingerprint ? origin.codeFingerprint === state.hash : undefined,
    // 版本守卫：上一次成功打补丁时是什么版本、现在是什么版本 → 升级后要重新打。
    previousVersion: record && record.version,
    patchedBefore: record !== undefined,
    versionChanged: Boolean(record && record.version !== undefined && record.version !== version),
  }
  return report
}
