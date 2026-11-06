// A missing feed is normal before the first stable release. Confirm that exact
// condition through GitHub; don't hide a broken published feed or network error.
async function hasNoPublishedRelease(feedURL, { fetcher = fetch, signal } = {}) {
  try {
    const url = new URL(feedURL)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return false
    const match = /^\/([\w.-]+)\/([\w.-]+)\/releases\/latest\/download\/appcast-(?:arm64|x64)\.xml$/.exec(url.pathname)
    if (!match) return false
    const repository = `${match[1]}/${match[2]}`
    const api = `https://api.github.com/repos/${repository}`
    const timeout = AbortSignal.timeout(6000)
    const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'pdfer-updater' } }
    const feed = await fetcher(feedURL, { method: 'HEAD', signal: options.signal, headers: { 'User-Agent': 'pdfer-updater' } })
    if (feed.status !== 404) return false
    const latest = await fetcher(`${api}/releases/latest`, options)
    if (latest.status !== 404) return false
    const response = await fetcher(api, options)
    if (!response.ok) return false
    const information = await response.json()
    return information.private === false && typeof information.full_name === 'string'
      && information.full_name.toLowerCase() === repository.toLowerCase()
  } catch { return false }
}

module.exports = { hasNoPublishedRelease }
