/**
 * dsh-loopback-direct — Client half.
 *
 * 在「设置」里加一个「回环直连」分区，显示转发器/补丁/确认状态，
 * 并提供打补丁、回滚、验证三个按钮。
 *
 * ★ 交付门槛熔断：UI 里任何异常都只影响本分区，绝不抛出到宿主渲染树。
 */
window.__ModuleLoader__.load({
  id: 'dsh-loopback-direct',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const NS = 'loopbackDirect'
    const STATUS_URL = '/plugins/dsh-loopback-direct/status'
    const ACTION_URL = '/plugins/dsh-loopback-direct/action'
    const RELEASE_URL = '/plugins/dsh-loopback-direct/release'
    const RELEASES_PAGE = 'https://github.com/Huaxidesu/dsh-loopback-direct/releases'

    const zh = {
      nav: '回环直连',
      title: '回环直连',
      subtitle: '本机模型不走代理',
      intro: 'WorkBuddy 等本机模型绑在 127.0.0.1 上，端口每次启动随机。开启手动代理后，billion-context 转发器的第二跳会把这些回环请求也塞进代理，表现为 proxy-reset / UND_ERR_SOCKET / 503。本插件给转发器补上「回环地址默认直连」这一条。',
      forwarder: '转发器',
      install: '安装位置',
      version: '版本',
      status: '状态',
      running: '运行中',
      notRunning: '未启动',
      patched: '已打补丁',
      notPatched: '未打补丁',
      patchable: '可以打补丁',
      notPatchable: '不能打补丁',
      restartPending: '改完需要重启 DSH',
      confirmed: '分流已启用',
      notConfirmed: '尚未拿到转发器确认',
      lastDecision: '最近一次出站决策',
      none: '无',
      patch: '打补丁',
      revert: '回滚',
      verify: '验证',
      patching: '正在打补丁…',
      reverting: '正在回滚…',
      verifying: '正在验证…',
      refresh: '刷新',
      verifyResult: '验证结果',
      reached: '请求到达上游',
      proxyFailure: '被塞进代理（proxy-reset）',
      unreachable: '连不上',
      hintRestart: '转发器是独立进程，改完磁盘必须重启 DSH 才生效。',
      hintNoForwarder: '转发器没启动过，先启动 DSH。',
      hintNoInstall: '没找到 billion-context 安装目录，可用 BILI_CONTEXT_DIR 指定。',
      hintConfirmed: '已验证：回环请求直达上游（未经过代理）。',
      unknownVersion: '未列入已验证版本，请先点「验证」。',
      cli: '命令行：node cli.js status | patch | revert | verify',
      upgraded: '插件已升级，补丁已自动重打',
      hintUpgraded: 'billion-context 已从 {from} 升级到 {to}，回环分流已自动补回。因为转发器是独立进程，需要重启 DSH 才生效。',
      hintGuardBlocked: '已升级到 {to}，但新版本的补丁锚点变了，自动重打被拦下（{reason}）。请等插件适配后再试。',
      guard: '升级监护',
      guardOn: '已开启（每次打开本页都会检查）',
      healedTimes: '已自动重打 {n} 次',
      releaseTab: '回环直连更新',
      releaseSettings: '在左侧「插件 → 回环直连更新」查看本插件的新版本。',
      releaseIntro: '查看回环直连在 GitHub 上发布的正式版本。',
      installedVersion: '已安装版本',
      latestVersion: '最新正式版',
      releaseChecking: '正在检查更新…',
      releaseCheckAgain: '重新检查',
      releaseReady: '有新版本',
      releaseCurrent: '已是最新正式版或更高版本',
      releaseNone: '暂未发布正式版',
      releaseUnavailable: '暂时无法读取 GitHub Release，请稍后重试。',
      releaseRateLimit: 'GitHub 暂时限制了检查次数，请稍后重试。',
      releaseUnknownVersion: '无法识别已安装的版本。',
      releaseManual: '这份安装需要手动换包。打开发布页获取离线包，或按发布说明通过 Git 安装一次，以后可在此处直接更新。',
      releaseSourceUnknown: '无法确认当前安装来源。可从发布页查看安装和更新说明。',
      releaseNoAccess: '当前客户端没有更新插件的权限。',
      releaseUpdate: '更新…',
      releaseNotes: '查看发布说明',
      releaseZip: '下载离线安装包（ZIP）',
      releaseZipHint: '可以把 ZIP 发给另一台机器。解压后按内附说明安装。',
    }

    const en = {
      nav: 'Loopback Direct',
      title: 'Loopback Direct',
      subtitle: 'Local models bypass the proxy',
      intro: 'Local model servers such as WorkBuddy bind to 127.0.0.1 on a random port. With a manual proxy enabled, the billion-context forwarder\'s second hop also pushes those loopback requests into the proxy, surfacing as proxy-reset / UND_ERR_SOCKET / 503. This plugin adds the missing "loopback is always direct" rule.',
      forwarder: 'Forwarder',
      install: 'Install',
      version: 'Version',
      status: 'Status',
      running: 'Running',
      notRunning: 'Not started',
      patched: 'Patched',
      notPatched: 'Not patched',
      patchable: 'Patchable',
      notPatchable: 'Not patchable',
      restartPending: 'Restart DSH to apply',
      confirmed: 'Split routing active',
      notConfirmed: 'Not yet confirmed by the forwarder',
      lastDecision: 'Last egress decision',
      none: 'none',
      patch: 'Patch',
      revert: 'Revert',
      verify: 'Verify',
      patching: 'Patching…',
      reverting: 'Reverting…',
      verifying: 'Verifying…',
      refresh: 'Refresh',
      verifyResult: 'Verification',
      reached: 'Reached upstream',
      proxyFailure: 'Pushed into the proxy (proxy-reset)',
      unreachable: 'Unreachable',
      hintRestart: 'The forwarder is a separate process; a disk change needs a DSH restart.',
      hintNoForwarder: 'The forwarder has not started yet. Start DSH first.',
      hintNoInstall: 'billion-context install not found; set BILI_CONTEXT_DIR.',
      hintConfirmed: 'Verified: loopback requests reach the upstream directly, without the proxy.',
      unknownVersion: 'Not a verified version; run Verify first.',
      cli: 'CLI: node cli.js status | patch | revert | verify',
      upgraded: 'Forwarder upgraded, patch re-applied',
      hintUpgraded: 'billion-context was upgraded from {from} to {to}. The loopback routing was re-applied automatically. The forwarder is a separate process, so restart DSH for it to take effect.',
      hintGuardBlocked: 'Upgraded to {to}, but the patch anchor changed so auto re-patching was refused ({reason}). Wait for a plugin update that supports this version.',
      guard: 'Upgrade guard',
      guardOn: 'Enabled (checked every time this page opens)',
      healedTimes: 'Auto re-patched {n} time(s)',
      releaseTab: 'Loopback Direct updates',
      releaseSettings: 'Find new versions of this plugin under Plugins → Loopback Direct updates.',
      releaseIntro: 'Check GitHub for stable Loopback Direct releases.',
      installedVersion: 'Installed version',
      latestVersion: 'Latest stable release',
      releaseChecking: 'Checking for updates…',
      releaseCheckAgain: 'Check again',
      releaseReady: 'Update available',
      releaseCurrent: 'At or above the latest stable release',
      releaseNone: 'No stable releases yet',
      releaseUnavailable: 'Unable to read GitHub releases. Try again later.',
      releaseRateLimit: 'GitHub is temporarily limiting update checks. Try again later.',
      releaseUnknownVersion: 'Unable to identify the installed version.',
      releaseManual: 'This installation is updated manually. Get the offline package from GitHub, or switch to a Git installation once to update here in the future.',
      releaseSourceUnknown: 'Unable to confirm the installation source. See GitHub for installation and update instructions.',
      releaseNoAccess: 'This client does not have permission to update plugins.',
      releaseUpdate: 'Update…',
      releaseNotes: 'View release notes',
      releaseZip: 'Download the offline ZIP',
      releaseZipHint: 'To install on another computer, extract the ZIP and follow the included guide.',
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 2px' },
      intro: { fontSize: '13px', lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      row: { display: 'flex', alignItems: 'baseline', gap: '10px', fontSize: '13px', flexWrap: 'wrap' },
      key: { color: 'var(--dsw-alias-label-secondary)', minWidth: '92px' },
      val: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
      badge: (tone) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '12px',
        padding: '2px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: tone === 'ok'
          ? 'var(--dsw-alias-state-success-primary)'
          : tone === 'warn'
            ? 'var(--dsw-alias-state-warn-primary)'
            : tone === 'bad'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
      }),
      btn: (primary, disabled = false) => ({
        appearance: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        fontSize: '13px',
        padding: '6px 14px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
      }),
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
    }

    function Row({ label, children }) {
      return h('div', { style: S.row }, h('span', { style: S.key }, label), h('span', { style: S.val }, children))
    }

    function Badge({ tone, children }) {
      return h('span', { style: S.badge(tone) }, children)
    }

    function Section({ api, t }) {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [verify, setVerify] = useState(null)

      const load = useCallback(async () => {
        try {
          const next = await api.status()
          setStatus(next)
          setError('')
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        }
      }, [api])

      useEffect(() => { load() }, [load])

      const run = useCallback(async (action) => {
        setBusy(action)
        setError('')
        try {
          const result = await api.action(action)
          if (action === 'verify') setVerify(result)
          else setVerify(null)
          await load()
        } catch (err) {
          setError(String(err && err.message ? err.message : err))
        } finally {
          setBusy('')
        }
      }, [api, load])

      if (error && status === null) {
        return h('div', { style: S.wrap },
          h('div', { style: S.intro }, t('intro')),
          h('div', { style: S.err }, error))
      }
      if (status === null) {
        return h('div', { style: S.wrap }, h('div', { style: S.intro }, t('intro')))
      }

      const f = status.flags || {}
      const inst = status.install
      const decision = status.lastDecision

      // 升级守护的结论优先显示：用户最关心的是「升级后还能不能直连」。
      const guardLast = status.guard && status.guard.last
      const healed = Boolean(guardLast && guardLast.action === 'patched')
      const guardBlocked = Boolean(guardLast && guardLast.action === 'blocked')
      const fmtHint = (text, vars) => Object.keys(vars).reduce((acc, key) => acc.split(`{${key}}`).join(String(vars[key] ?? '?')), text)

      const hints = []
      if (healed) {
        hints.push(fmtHint(t('hintUpgraded'), { from: guardLast.previousVersion || '?', to: guardLast.version || '?' }))
      } else if (guardBlocked && f.versionChanged) {
        hints.push(fmtHint(t('hintGuardBlocked'), { to: guardLast.version || '?', reason: guardLast.reason || '?' }))
      }
      if (!f.running) hints.push(t('hintNoForwarder'))
      if (!inst || !inst.found) hints.push(t('hintNoInstall'))
      if (f.restartPending) hints.push(t('hintRestart'))
      if (f.confirmed) hints.push(t('hintConfirmed'))
      if (inst && inst.found && inst.knownVersion === false) hints.push(t('unknownVersion'))

      return h('div', { style: S.wrap },
        h('div', { style: S.intro }, t('intro')),

        h('div', { style: S.card },
          h('div', { style: S.row },
            h(Badge, { tone: f.confirmed ? 'ok' : f.patched ? 'warn' : 'bad' },
              f.confirmed ? t('confirmed') : t('notConfirmed')),
            healed ? h(Badge, { tone: 'warn' }, t('upgraded')) : null),
          h(Row, { label: t('forwarder') },
            status.forwarder
              ? `${status.forwarder.origin}${status.forwarder.pid ? `  pid=${status.forwarder.pid}` : ''}`
              : t('notRunning')),
          inst && inst.found ? h(Row, { label: t('install') }, inst.root) : null,
          inst && inst.found ? h(Row, { label: t('version') }, `${inst.version || '?'}${inst.knownVersion ? '' : ' (?)'}`) : null,
          h(Row, { label: t('status') },
            h(Badge, { tone: f.patched ? 'ok' : f.patchable ? 'warn' : 'bad' },
              f.patched ? t('patched') : f.patchable ? t('patchable') : t('notPatchable'))),
          f.restartPending ? h('div', null, h(Badge, { tone: 'warn' }, t('restartPending'))) : null,
          status.guard
            ? h(Row, { label: t('guard') },
                `${status.guard.enabled ? t('guardOn') : 'off'}${status.guard.healedCount ? `  \u00b7  ${fmtHint(t('healedTimes'), { n: status.guard.healedCount })}` : ''}`)
            : null,
          h(Row, { label: t('lastDecision') },
            decision ? `${decision.host}  ${decision.via}  (source=${decision.source})` : t('none')),

          h('div', { style: S.actions },
            h('button', {
              style: S.btn(!f.patched),
              disabled: Boolean(busy) || f.patched || !f.patchable,
              onClick: () => run('patch'),
            }, busy === 'patch' ? t('patching') : t('patch')),
            h('button', {
              style: S.btn(false),
              disabled: Boolean(busy) || !f.patched,
              onClick: () => run('revert'),
            }, busy === 'revert' ? t('reverting') : t('revert')),
            h('button', {
              style: S.btn(false),
              disabled: Boolean(busy) || !f.running,
              onClick: () => run('verify'),
            }, busy === 'verify' ? t('verifying') : t('verify')),
            h('button', { style: S.btn(false), disabled: Boolean(busy), onClick: load }, t('refresh'))),

          hints.length > 0 ? h('div', { style: S.hint }, hints.join(' ')) : null,
          error ? h('div', { style: S.err }, error) : null),

        verify ? h('div', { style: S.card },
          h('div', { style: S.row }, h('strong', { style: S.val }, t('verifyResult'))),
          verify.ok === false
            ? h('div', { style: S.err }, `${verify.reason}${verify.error ? `: ${verify.error}` : ''}`)
            : h('div', { style: S.wrap },
              verify.upstream
                ? h(Row, { label: 'mode' }, `${verify.upstream.mode}  source=${verify.upstream.source}  proxy=${verify.upstream.proxy || 'null'}`)
                : null,
              verify.probe
                ? h(Row, { label: 'probe' },
                  `${verify.probe.verdict}  status=${verify.probe.status ?? '-'}  ${verify.probe.ms}ms`)
                : null,
              verify.probe
                ? h(Row, { label: 'target' }, verify.probe.target)
                : null,
              verify.lastDecision
                ? h(Row, { label: t('lastDecision') }, `${verify.lastDecision.host}  ${verify.lastDecision.via}  (source=${verify.lastDecision.source})`)
                : null,
              h(Row, { label: t('confirmed') },
                h(Badge, { tone: verify.confirmed ? 'ok' : 'warn' },
                  verify.confirmed ? t('confirmed') : t('notConfirmed'))))
        ) : null,

        h('div', { style: S.hint }, t('releaseSettings')),
        h('div', { style: S.hint }, t('cli')))
    }

    function ReleaseTab({ api, t, update, useRemoteAccess }) {
      const canUpdate = useRemoteAccess('pluginManager/updateBundle')
      const [info, setInfo] = useState(null)
      const [attempt, setAttempt] = useState(0)

      useEffect(() => {
        const controller = new AbortController()
        api.release(controller.signal).then(
          result => { if (!controller.signal.aborted) setInfo(result) },
          () => { if (!controller.signal.aborted) setInfo({ status: 'unavailable' }) },
        )
        return () => controller.abort()
      }, [api, attempt])

      const available = info?.status === 'available'
      const message = {
        available: 'releaseReady',
        current: 'releaseCurrent',
        'no-release': 'releaseNone',
        'unknown-version': 'releaseUnknownVersion',
        unavailable: info?.reason === 'rate-limit' ? 'releaseRateLimit' : 'releaseUnavailable',
      }[info?.status] ?? (info === null ? 'releaseChecking' : 'releaseUnavailable')
      const hint = available && (info.installMode === 'manual'
        ? 'releaseManual'
        : !info.target ? 'releaseSourceUnknown' : !canUpdate ? 'releaseNoAccess' : null)
      const releaseNotes = info?.latest?.url ?? RELEASES_PAGE

      return h('div', { style: { ...S.wrap, maxWidth: '640px' } },
        h('div', { style: S.intro }, t('releaseIntro')),
        h('div', { style: S.card },
          h(Row, { label: t('installedVersion') }, info?.installedVersion ?? '—'),
          h(Row, { label: t('latestVersion') }, info?.latest?.version ?? '—'),
          h('div', { role: 'status', style: S.intro }, t(message)),
          hint ? h('div', { style: S.hint }, t(hint)) : null,
          h('div', { style: { ...S.actions, alignItems: 'center' } },
            available && info.target && canUpdate
              ? h('button', { type: 'button', style: S.btn(true), onClick: () => update(info.target) }, t('releaseUpdate'))
              : null,
            h('button', {
              type: 'button', style: S.btn(false, info === null), disabled: info === null,
              onClick: () => { setInfo(null); setAttempt(value => value + 1) },
            }, t('releaseCheckAgain')),
            h('a', {
              href: releaseNotes, target: '_blank', rel: 'noopener noreferrer',
              style: { color: 'var(--dsw-alias-brand-primary)', fontSize: '13px' },
            }, t('releaseNotes'))),
          info?.latest?.zipUrl
            ? h('div', { style: S.hint },
              h('a', {
                href: info.latest.zipUrl, target: '_blank', rel: 'noopener noreferrer',
                style: { color: 'var(--dsw-alias-brand-primary)' },
              }, t('releaseZip')), ' · ', t('releaseZipHint'))
            : null))
    }

    function createApi() {
      return {
        async release(signal) {
          const response = await fetch(RELEASE_URL, { credentials: 'same-origin', signal })
          if (!response.ok) throw new Error(`release ${response.status}`)
          return response.json()
        },
        async status() {
          const response = await fetch(STATUS_URL, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`status ${response.status}`)
          return response.json()
        },
        async action(action) {
          const response = await fetch(ACTION_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          if (!response.ok) {
            const text = await response.text().catch(() => '')
            throw new Error(`action ${action} failed: ${response.status} ${text.slice(0, 200)}`)
          }
          return response.json()
        },
      }
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      let t = (key) => zh[key] || key
      try {
        if (ctx.locale !== undefined) {
          const locale = ctx.locale
          ctx.effect(() => locale.register(NS, { zh, en }), 'loopback-direct: dictionaries')
          const bound = locale.bind(NS)
          t = (key) => bound(key)
        } else if (typeof navigator !== 'undefined' && !navigator.language.startsWith('zh')) {
          t = (key) => en[key] || key
        }
      } catch {
        // 语言注册失败不影响主功能
      }
      const api = createApi()
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-loopback-direct',
          order: 61,
          label: () => t('nav'),
        }, () => h(Section, { api, t })))
      } catch {
        // slots 不可用时静默降级，CLI 仍然可用
      }
      ctx.slots.inject('plugins.tab', () => ctx.slots.register({
        name: 'plugins.tab',
        id: 'dsh-loopback-direct.updates',
        order: 20,
        label: () => t('releaseTab'),
      }, ({ update, useRemoteAccess }) => h(ReleaseTab, { api, t, update, useRemoteAccess })))
    }

    return { apply, inject }
  },
})
