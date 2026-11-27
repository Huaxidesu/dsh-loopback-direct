// Release metadata comes from one public repository. The DSH plugin manager owns installation and rollback.
export const RELEASE_REPO = 'https://github.com/Huaxidesu/dsh-loopback-direct'
export const RELEASES_URL = `${RELEASE_REPO}/releases`
const API = 'https://api.github.com/repos/Huaxidesu/dsh-loopback-direct'
const PACKAGE = 'dsh-loopback-direct'
const OFFLINE_ZIP = `${PACKAGE}-offline.zip`
const COMMIT = /^[0-9a-f]{40}$/i
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const OPTIONS = {
  accept: 'application/vnd.github+json',
  'user-agent': PACKAGE,
  'x-github-api-version': '2022-11-28',
}

function parseVersion (value) {
  if (typeof value !== 'string' || value.length > 256) return undefined
  const match = VERSION.exec(value)
  if (match?.[0] !== value) return undefined
  const parts = match.slice(1, 4).map(Number)
  const prerelease = match[4]
  if (!parts.every(Number.isSafeInteger)) return undefined
  if (prerelease?.split('.').some(part => /^0[0-9]+$/.test(part))) return undefined
  return { parts, prerelease, build: match[5] }
}

function isNewerStable (latest, installed) {
  for (let i = 0; i < latest.parts.length; i++) {
    if (latest.parts[i] !== installed.parts[i]) return latest.parts[i] > installed.parts[i]
  }
  return installed.prerelease !== undefined
}

function validSha (value) {
  return typeof value === 'string' && value.length === 40 && COMMIT.test(value)
}

function invalidRelease () {
  return { status: 'unavailable', reason: 'invalid-release' }
}

function httpFailure (response) {
  const limited = response.status === 429 || (response.status === 403 && (
    response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
  return { status: 'unavailable', reason: limited ? 'rate-limit' : 'http', httpStatus: limited ? undefined : response.status }
}

async function lookupRelease (fetchImpl) {
  const signal = AbortSignal.timeout(8000)
  const get = (path) => fetchImpl(`${API}${path}`, { headers: OPTIONS, signal, redirect: 'error' })
  try {
    const response = await get('/releases/latest')
    if (response.status === 404) return { status: 'no-release' }
    if (!response.ok) {
      const { status, reason, httpStatus } = httpFailure(response)
      return httpStatus === undefined ? { status, reason } : { status, reason, httpStatus }
    }
    const release = await response.json()
    const tag = release?.tag_name
    const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : undefined
    const parsed = parseVersion(version)
    if (release?.draft !== false || release?.prerelease !== false || !parsed || parsed.prerelease || parsed.build) {
      return invalidRelease()
    }

    const zipUrl = `${RELEASES_URL}/download/${tag}/${OFFLINE_ZIP}`
    const hasZip = Array.isArray(release.assets) && release.assets.some(asset => (
      asset?.name === OFFLINE_ZIP && asset.state === 'uploaded' && asset.browser_download_url === zipUrl
    ))
    const downloads = hasZip ? { zipUrl } : {}

    let ref = await get(`/git/ref/tags/${tag}`)
    const seen = new Set()
    for (let depth = 0; depth < 5; depth++) {
      if (ref.status === 404) return invalidRelease()
      if (!ref.ok) {
        const { status, reason, httpStatus } = httpFailure(ref)
        return httpStatus === undefined ? { status, reason } : { status, reason, httpStatus }
      }
      const object = (await ref.json())?.object
      if (!validSha(object?.sha)) return invalidRelease()
      const sha = object.sha.toLowerCase()
      if (object.type === 'commit') {
        return { status: 'release', latest: { version, url: `${RELEASES_URL}/tag/${tag}`, commit: sha, ...downloads } }
      }
      if (object.type !== 'tag' || seen.has(sha) || depth === 4) return invalidRelease()
      seen.add(sha)
      ref = await get(`/git/tags/${sha}`)
    }
    return invalidRelease()
  } catch (error) {
    if (signal.aborted) return { status: 'unavailable', reason: 'timeout' }
    return error instanceof SyntaxError ? invalidRelease() : { status: 'unavailable', reason: 'network' }
  }
}

export function createReleaseChecker ({ fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  let cached
  let expires = 0
  let pending
  return function checkRelease () {
    if (pending) return pending
    if (cached && now() < expires) return Promise.resolve(cached)
    pending = lookupRelease(fetchImpl).then(result => {
      cached = result
      expires = now() + (result.status === 'unavailable' ? 15_000 : 60_000)
      return result
    }).finally(() => { pending = undefined })
    return pending
  }
}

// Keep the repository path's casing as saved by pnpm because DSH compares those paths verbatim.
function officialGitPath (bundle) {
  if (bundle?.update !== 'git' || typeof bundle.source !== 'string') return undefined
  const source = bundle.source.trim()
  const idx = source.indexOf('#')
  if (idx === -1 || !validSha(source.slice(idx + 1))) return undefined
  const repository = source.slice(0, idx)
  const match = /^(?:github:|(?:git\+)?https?:\/\/github\.com\/|(?:git\+)?ssh:\/\/git@github\.com\/|git@github\.com:)(huaxidesu\/dsh-loopback-direct)(?:\.git)?\/?$/i.exec(repository)
  return match?.[0] === repository ? match[1] : undefined
}

export function describeRelease (result, bundle, runningVersion) {
  const installed = bundle?.name === PACKAGE && bundle?.installed === true ? bundle : undefined
  const installedVersion = installed?.version ?? runningVersion
  const gitPath = officialGitPath(installed)
  const base = {
    installedVersion,
    installMode: installed ? (gitPath ? 'git' : 'manual') : 'unknown',
    releasesUrl: RELEASES_URL,
  }
  if (result.status !== 'release') return { ...base, ...result }
  const { version, commit, url, zipUrl } = result.latest
  const latest = zipUrl === undefined ? { version, url } : { version, url, zipUrl }
  const parsed = parseVersion(installedVersion)
  if (!parsed) return { ...base, status: 'unknown-version', latest }
  if (!isNewerStable(parseVersion(version), parsed)) return { ...base, status: 'current', latest }
  const target = gitPath ? { packageName: PACKAGE, version, spec: `git+https://github.com/${gitPath}.git#${commit}` } : undefined
  return { ...base, status: 'available', latest, target }
}
