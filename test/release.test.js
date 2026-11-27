import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'
import { createReleaseChecker, describeRelease } from '../lib/release.js'

const name = 'dsh-loopback-direct'
const origin = 'https://github.com/Huaxidesu/dsh-loopback-direct'
const api = 'https://api.github.com/repos/Huaxidesu/dsh-loopback-direct'
const commit = 'a'.repeat(40)
const oldCommit = 'b'.repeat(40)
const tagObject = 'c'.repeat(40)
const tag = 'v1.10.0'
const release = { tag_name: tag, draft: false, prerelease: false, html_url: 'https://somewhere.invalid/' }
const result = { status: 'release', latest: { version: '1.10.0', url: `${origin}/releases/tag/${tag}`, commit } }
const gitBundle = { name, installed: true, update: 'git', version: '1.9.0', source: `github:Huaxidesu/dsh-loopback-direct#${oldCommit}` }
const getLatest = '/releases/latest'
const getRef = `/git/ref/tags/${tag}`
const commitRef = { object: { type: 'commit', sha: commit } }
const zipName = 'dsh-loopback-direct-offline.zip'
const zipUrl = `${origin}/releases/download/${tag}/${zipName}`

await test('offers the offline ZIP only when the same release has the expected asset', async () => {
  for (const [assets, expected] of [
    [[{ name: zipName, state: 'uploaded', browser_download_url: zipUrl }], zipUrl],
    [[{ name: zipName, state: 'uploaded', browser_download_url: zipUrl.replace(tag, 'v1.11.0') }], undefined],
    [[{ name: zipName, state: 'uploaded', browser_download_url: 'https://somewhere.invalid/offline.zip' }], undefined],
    [[{ name: zipName, state: 'new', browser_download_url: zipUrl }], undefined],
    [[], undefined],
  ]) {
    const { check } = fixture(new Map([[getLatest, { ...release, assets }], [getRef, commitRef]]))
    const checked = await check()
    assert.equal(checked.status, 'release')
    assert.equal(describeRelease(checked, gitBundle, '1.9.0').latest.zipUrl, expected)
  }
})

function fixture (replies, options = {}) {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url, init })
    const reply = replies.get(url.slice(api.length))
    assert.ok(url.startsWith(`${api}/`) && reply !== undefined, `unexpected fetch ${url}`)
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply() : Response.json(reply)
  }
  return { seen, check: createReleaseChecker({ fetchImpl, ...options }) }
}

await test('uses the stable release tag, including annotated tags, to pin a full Git commit', async () => {
  const { check, seen } = fixture(new Map([
    [getLatest, release], [getRef, { object: { type: 'tag', sha: tagObject, url: 'https://somewhere.invalid/' } }],
    [`/git/tags/${tagObject}`, commitRef],
  ]))
  assert.deepEqual(await check(), result)
  assert.deepEqual(seen.map(call => call.url), [getLatest, getRef, `/git/tags/${tagObject}`].map(path => api + path))
  assert.ok(seen.every(({ init }) => init.redirect === 'error' && init.signal instanceof AbortSignal))
})

await test('deduplicates concurrent checks and rechecks after the cache expires', async () => {
  let clock = 0
  const { check, seen } = fixture(new Map([[getLatest, release], [getRef, commitRef]]), { now: () => clock })
  assert.deepEqual(await Promise.all([check(), check(), check()]), [result, result, result])
  clock += 1000
  assert.deepEqual(await check(), result)
  assert.equal(seen.length, 2)
  clock += 60_001
  assert.deepEqual(await check(), result)
  assert.equal(seen.length, 4)
})

await test('distinguishes no published release, throttling, and network failures', async () => {
  for (const [reply, expected] of [
    [() => new Response(null, { status: 404 }), { status: 'no-release' }],
    [() => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), { status: 'unavailable', reason: 'rate-limit' }],
    [new TypeError('network failure with private detail'), { status: 'unavailable', reason: 'network' }],
  ]) {
    const { check, seen } = fixture(new Map([[getLatest, reply]]))
    assert.deepEqual(await check(), expected)
    assert.deepEqual(await check(), expected)
    assert.equal(seen.length, 1)
  }
})

await test('rejects prereleases, malformed tags, unsafe refs, and annotated tag cycles', async () => {
  for (const invalid of [
    { ...release, prerelease: true }, { ...release, draft: true }, { ...release, tag_name: 'v1.10.0-rc.1' },
    { ...release, tag_name: '../v1.10.0' }, { ...release, tag_name: 'v1.010.0' },
  ]) {
    const { check, seen } = fixture(new Map([[getLatest, invalid]]))
    assert.deepEqual(await check(), { status: 'unavailable', reason: 'invalid-release' })
    assert.equal(seen.length, 1)
  }
  const invalidRef = fixture(new Map([[getLatest, release], [getRef, { object: { type: 'commit', sha: '../example' } }]]))
  assert.deepEqual(await invalidRef.check(), { status: 'unavailable', reason: 'invalid-release' })
  const cycle = { object: { type: 'tag', sha: tagObject } }
  const cyclicRef = fixture(new Map([[getLatest, release], [getRef, cycle], [`/git/tags/${tagObject}`, cycle]]))
  assert.deepEqual(await cyclicRef.check(), { status: 'unavailable', reason: 'invalid-release' })
  assert.equal(cyclicRef.seen.length, 3)
})

await test('compares numeric versions and accepts a stable upgrade from a prerelease', () => {
  const expected = { packageName: name, version: '1.10.0', spec: `git+${origin}.git#${commit}` }
  const available = describeRelease(result, gitBundle, '1.8.0')
  assert.equal(available.status, 'available')
  assert.equal(available.installedVersion, '1.9.0')
  assert.deepEqual(available.target, expected)
  assert.deepEqual(available.latest, { version: '1.10.0', url: `${origin}/releases/tag/${tag}` })
  assert.equal(describeRelease(result, { ...gitBundle, version: '1.10.0-rc.1' }, '1.9.0').status, 'available')
  for (const version of ['1.10.0', '1.10.0+desktop', '1.11.0']) {
    const info = describeRelease(result, { ...gitBundle, version }, '1.9.0')
    assert.equal(info.status, 'current')
    assert.equal(info.target, undefined)
  }
  assert.equal(describeRelease(result, { ...gitBundle, version: 'x' }, '1.9.0').status, 'unknown-version')
})

await test('only opens native updates for pinned copies of the official repository root', () => {
  const supported = { ...gitBundle, source: `git+ssh://git@github.com/huaxidesu/DSH-Loopback-Direct.git#${oldCommit}` }
  const info = describeRelease(result, supported, '1.9.0')
  assert.equal(info.installMode, 'git')
  assert.equal(info.target.spec, `git+https://github.com/huaxidesu/DSH-Loopback-Direct.git#${commit}`)
  for (const bundle of [
    { ...gitBundle, update: undefined, source: 'link:D:/plugin' },
    { ...gitBundle, update: undefined, source: 'file:D:/offline.tgz' },
    { ...gitBundle, update: 'registry', source: `${name}@1.9.0` },
    { ...gitBundle, source: `github:another/${name}#${oldCommit}` },
    { ...gitBundle, source: `${gitBundle.source}&path:plugins/loopback` },
    { ...gitBundle, source: `https://github.com@elsewhere.invalid/Huaxidesu/${name}.git#${oldCommit}` },
    { ...gitBundle, source: `${origin}.git#v1.9.0` },
  ]) {
    const check = describeRelease(result, bundle, '1.9.0')
    assert.equal(check.status, 'available')
    assert.equal(check.installMode, 'manual')
    assert.equal(check.target, undefined)
  }
  assert.equal(describeRelease(result, undefined, '1.9.0').installMode, 'unknown')
})

await test('exposes a loopback-only, read-only release route through the host entry', async () => {
  const routes = new Map()
  const ctx = {
    inject (keys, run) { if (keys.includes('webServer')) run(ctx) },
    effect (run) { return run() },
    get (key) {
      assert.equal(key, 'pluginManager')
      return { async listBundles () { return [{ name: 'unrelated' }, gitBundle] } }
    },
    webServer: { register (route) { routes.set(route.path, route); return () => {} } },
  }
  apply(ctx)
  const route = routes.get(`/plugins/${name}/release`)
  assert.equal(route?.kind, 'exact')
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url === api + getLatest) return Response.json(release)
    assert.equal(url, api + getRef)
    return Response.json(commitRef)
  }
  const request = async (remoteAddress, method) => {
    const response = {}
    await route.handler({ method, socket: { remoteAddress } }, {
      writeHead: (status) => { response.status = status },
      end: (body) => { response.body = JSON.parse(body) },
    })
    return response
  }
  try {
    assert.equal((await request('192.0.2.5', 'GET')).status, 403)
    assert.equal((await request('127.0.0.1', 'POST')).status, 405)
    assert.deepEqual(calls, [])
    const response = await request('::ffff:127.0.0.1', 'GET')
    assert.equal(response.status, 200)
    assert.equal(response.body.status, 'available')
    assert.equal(response.body.installedVersion, gitBundle.version)
    assert.equal(response.body.target.spec, `git+${origin}.git#${commit}`)
    assert.equal(calls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
