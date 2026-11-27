#!/usr/bin/env node
/**
 * dsh-loopback-direct CLI
 *
 *   status     查看转发器安装、补丁状态、运行实例
 *   patch      打补丁（自动备份）
 *   revert     回滚
 *   verify     通过真实转发器做一次两跳探测（不依赖本进程的网络环境）
 *   watch      持续观察 bili.log 的 [upstream-proxy] 决策
 *
 * 全部操作都是幂等的；不带参数时等价于 status。
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  diagnose,
  locateForwarderEntry,
  applyPatchOnDisk,
  rollbackOnDisk,
  inspectSource,
  readVersion,
  readForwarderOrigin,
  readLastProxyDecision,
  readProxyDecisionForPort,
  isDirectSource,
  probeThroughForwarder,
  writeVerifyRecord,
  readVerifyRecord,
  stateDir,
} from './lib/core.js'

const C = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
  ok: (s) => `\u001b[32m${s}\u001b[0m`,
  warn: (s) => `\u001b[33m${s}\u001b[0m`,
  bad: (s) => `\u001b[31m${s}\u001b[0m`,
  cyan: (s) => `\u001b[36m${s}\u001b[0m`,
}

const out = (line = '') => process.stdout.write(`${line}\n`)

function logFile () {
  return path.join(stateDir(process.env), 'bili.log')
}

function printDiagnose () {
  const report = diagnose(process.env)
  out(C.bold('billion-context 转发器'))
  if (report.forwarder) {
    out(`  运行实例   ${C.cyan(report.forwarder.origin)}  pid=${report.forwarder.pid || '?'}`)
    if (report.forwarder.codeFingerprint) {
      out(`  入口指纹   ${report.forwarder.codeFingerprint.slice(0, 16)}…`)
    }
  } else {
    out(`  运行实例   ${C.dim('未找到 proxy-origin 登记（转发器没启动过？）')}`)
  }
  out()
  out(C.bold('安装位置'))
  const inst = report.install
  if (!inst || !inst.found) {
    out(`  ${C.bad('未找到 billion-context 安装')}`)
    if (inst && inst.searched) {
      for (const p of inst.searched) out(C.dim(`  试过 ${p}`))
    }
    out()
    out(`可用 ${C.cyan('BILI_CONTEXT_DIR')} 环境变量指向 billion-context 包目录。`)
    return report
  }
  out(`  根目录     ${inst.root}`)
  out(`  入口       ${inst.entry}`)
  out(`  版本       ${inst.version || C.dim('未知')}${inst.knownVersion ? C.ok(' (已验证)') : C.warn(' (未列入已验证版本，请先看 status 与 verify)')}`)
  out(`  大小       ${inst.bytes} 字节`)
  out()
  out(C.bold('补丁状态'))
  if (inst.patched) {
    out(`  ${C.ok('已打补丁')} — 目标为回环地址时返回 source=loopback-direct`)
  } else if (inst.patchable) {
    out(`  ${C.warn('未打补丁')} — 可以打（锚点唯一）`)
  } else {
    out(`  ${C.bad('不能打补丁')} — ${inst.reason}`)
  }
  if (inst.entryFingerprintMatchesRunning === false) {
    out(`  ${C.warn('注意')} 磁盘入口与运行中实例指纹不一致：改完需要重启 DSH 才生效`)
  } else if (inst.entryFingerprintMatchesRunning === true) {
    out(`  ${C.dim('磁盘入口与运行中实例一致')}`)
  }
  return report
}

function cmdStatus () {
  const report = printDiagnose()
  const log = logFile()
  out()
  out(C.bold('最近一次出站决策'))
  const decision = readLastProxyDecision(log)
  if (!decision) {
    out(C.dim(`  ${log} 里还没有 [upstream-proxy] 记录`))
  } else {
    out(`  ${decision.host}  ${decision.via}  ${C.cyan(`source=${decision.source}`)}`)
  }
  out()
  out(C.dim(`日志：${log}`))
  return report
}

function cmdPatch () {
  const located = locateForwarderEntry(process.env)
  if (!located) {
    out(C.bad('未找到 billion-context 安装；可用 BILI_CONTEXT_DIR 指定'))
    process.exitCode = 2
    return
  }
  const source = fs.readFileSync(located.entry, 'utf8')
  const version = readVersion(located.root)
  const state = inspectSource(source, version)
  if (state.patched) {
    out(C.ok(`已经是打好的状态（${state.patchLineCount} 处注入）`))
    return
  }
  if (!state.patchable) {
    out(C.bad(`不能打补丁：${state.reason}`))
    out(C.dim('版本可能已变化，请把新版 dist/index.js 的 resolveProxyDecision 交给维护者确认锚点。'))
    process.exitCode = 3
    return
  }
  const result = applyPatchOnDisk(located.entry)
  out(C.ok(`已打补丁 ${located.entry}`))
  out(`  原 hash   ${result.before}`)
  out(`  新 hash   ${result.after}`)
  if (result.backup) out(`  备份      ${result.backup}`)
  out()
  out(C.warn('重启 DSH 后生效。重启后请跑：dsh-loopback-direct verify'))
}

function cmdRevert () {
  const located = locateForwarderEntry(process.env)
  if (!located) {
    out(C.bad('未找到 billion-context 安装；可用 BILI_CONTEXT_DIR 指定'))
    process.exitCode = 2
    return
  }
  const result = rollbackOnDisk(located.entry)
  if (!result.changed) {
    out(C.dim('本来就没有打补丁，无需回滚'))
    return
  }
  out(C.ok(`已回滚 ${located.entry}`))
  out(`  回滚前   ${result.before}`)
  out(`  回滚后   ${result.after}`)
  for (const b of result.backups || []) out(C.dim(`  可用备份 ${b}`))
  out()
  out(C.warn('重启 DSH 后恢复宿主原行为。'))
}

async function cmdVerify () {
  const report = diagnose(process.env)
  const inst = report.install
  const forwarder = report.forwarder
  if (!inst || !inst.found) {
    out(C.bad('未找到 billion-context 安装'))
    process.exitCode = 2
    return
  }
  if (!forwarder) {
    out(C.bad('没有运行中的转发器（proxy-origin 缺失）'))
    process.exitCode = 2
    return
  }
  const origin = forwarder.origin.replace(/\/+$/, '')
  out(C.bold(`验证 ${origin}`))
  out(`  补丁状态  ${inst.patched ? C.ok('已打补丁') : C.warn('未打补丁')}`)
  out()

  // 1) 读转发器自己的配置与决策面
  let upstream
  try {
    const response = await fetch(`${origin}/__bili/upstream`, { signal: AbortSignal.timeout(8000) })
    upstream = await response.json()
    out(`  转发器模式 ${upstream.mode}  source=${upstream.source}  proxy=${upstream.proxy ?? 'null'}`)
    if (upstream.connectionUrl) out(`  宿主连接   ${upstream.connectionUrl}`)
  } catch (error) {
    out(C.bad(`  读 /__bili/upstream 失败：${error.message}`))
    process.exitCode = 4
    return
  }
  out()

  // 2) 从宿主连接 URL 里取出真实的回环目标（WorkBuddy shim 的随机端口）
  let loopbackUrl
  if (typeof upstream.connectionUrl === 'string' && upstream.connectionUrl) {
    try {
      const url = new URL(upstream.connectionUrl)
      loopbackUrl = `${url.origin}/v1/models`
    } catch { /* ignore */ }
  }
  if (!loopbackUrl) {
    loopbackUrl = 'http://127.0.0.1:1/v1/models'
    out(C.warn('  拿不到宿主连接 URL，改用占位目标（只能验证分流决策，不能验证送达）'))
  }
  out(`  探测目标   ${loopbackUrl}`)

  // 3) 走真实 /bili/ 入口（两跳）
  const probe = await probeThroughForwarder(origin, loopbackUrl, { timeoutMs: 20000 })
  out(`  结果       ${probe.verdict}  status=${probe.status ?? '-'}  ${probe.ms}ms`)
  if (probe.body) out(C.dim(`  body       ${probe.body.replace(/\s+/g, ' ').slice(0, 160)}`))
  if (probe.error) out(C.dim(`  error      ${probe.error}`))
  out()

  // 4) 转发器自己的日志证据（按该回环端口取，日志按 host|proxy|source 去重过）
  let probePort
  try { probePort = Number(new URL(loopbackUrl).port) || undefined } catch { /* ignore */ }
  const decision = (probePort !== undefined ? readProxyDecisionForPort(logFile(), probePort) : undefined) ?? readLastProxyDecision(logFile())
  if (decision) {
    out(`  转发器日志 ${decision.host}  ${decision.via}  ${C.cyan(`source=${decision.source}`)}`)
  } else {
    out(C.dim('  转发器日志里没有 [upstream-proxy] 记录'))
  }
  out()

  // 5) 判定
  const loopbackTarget = new URL(loopbackUrl)
  const isLoop = /^(localhost|127\.)/.test(loopbackTarget.hostname)
  if (!isLoop) {
    out(C.dim('  目标不是回环地址，本次只验证远端路径'))
    return
  }
  if (inst.patched) {
    // 判定依据是行为：未打补丁 + 挂代理时回环请求必被塞进代理并 proxy-reset（实测 7.1s 502）；
    // 打补丁后同一请求直接到达上游（实测 401，5~40ms）。日志行仅作佐证。
    const mode = typeof upstream.mode === 'string' ? upstream.mode : undefined
    const confirmed = probe.verdict === 'reached'
    writeVerifyRecord({
      ok: true,
      confirmed,
      mode,
      viaProxy: mode !== undefined && mode !== 'direct',
      port: probePort,
      target: loopbackUrl,
      verdict: probe.verdict,
      status: probe.status,
      ms: probe.ms,
      fingerprint: forwarder.codeFingerprint,
      decision: decision ?? null,
      at: new Date().toISOString(),
    })
    if (confirmed) {
      out(C.ok('✔ 分流已启用：回环目标直连，转发器已确认'))
      return
    }
    if (probe.verdict === 'reached') {
      out(C.warn(`△ 请求到达了上游，但转发器来源标签是 ${decision ? decision.source : '未知'}；重启后再看一次`))
      process.exitCode = 5
      return
    }
    out(C.bad(`✘ 已打补丁但回环目标仍未送达（${probe.verdict}）— 可能需要重启 DSH`))
    process.exitCode = 6
    return
  }
  if (probe.verdict === 'proxy-failure') {
    out(C.bad('✘ 未打补丁，且回环目标被塞进代理（proxy-reset / UND_ERR_SOCKET）— 这就是要修的问题'))
    out(C.dim('  运行 dsh-loopback-direct patch 后重启 DSH'))
    process.exitCode = 7
    return
  }
  if (probe.verdict === 'reached') {
    out(C.ok('✔ 未打补丁但当前没开手动代理，回环本来就直连；开手动代理后才会暴露问题'))
    return
  }
  out(C.warn(`△ 未打补丁，探测结果为 ${probe.verdict}`))
  process.exitCode = 5
}

function cmdWatch () {
  const log = logFile()
  out(C.dim(`观察 ${log}（Ctrl+C 结束）`))
  let offset = 0
  try { offset = fs.statSync(log).size } catch { /* ignore */ }
  setInterval(() => {
    let size
    try { size = fs.statSync(log).size } catch { return }
    if (size <= offset) return
    let chunk = ''
    try {
      const fd = fs.openSync(log, 'r')
      const buf = Buffer.alloc(size - offset)
      fs.readSync(fd, buf, 0, buf.length, offset)
      fs.closeSync(fd)
      chunk = buf.toString('utf8')
    } catch { return }
    offset = size
    for (const line of chunk.split('\n')) {
      if (line.includes('[upstream-proxy]')) out(line.slice(line.indexOf('[upstream-proxy]')))
    }
  }, 1000).unref?.()
  // 保持进程存活
  setInterval(() => {}, 1 << 30)
}

const commands = {
  status: cmdStatus,
  patch: cmdPatch,
  revert: cmdRevert,
  verify: cmdVerify,
  watch: cmdWatch,
}

const name = process.argv[2] || 'status'
const command = commands[name]
if (!command) {
  out(`未知命令 ${name}`)
  out(`可用：${Object.keys(commands).join(' / ')}`)
  process.exitCode = 1
} else {
  await command()
}
