const { readPublicKey } = require('./sparkle/keys.cjs')

function releaseSettings({ env = process.env, platform = process.platform, arch = process.arch, publicKey = readPublicKey(env) } = {}) {
  const repository = env.PDFER_RELEASE_REPOSITORY || env.GITHUB_REPOSITORY
  if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Release repository must be owner/repository.')
  const release = env.PDFER_RELEASE === '1'
  if (release && !repository) throw new Error('A release repository is required.')
  const [owner, repo] = (repository || '').split('/')
  const publish = repository && (release || env.PDFER_RELEASE_REPOSITORY)
    ? [{ provider: 'github', owner, repo, channel: `latest-${arch}`, releaseType: 'draft' }] : null
  const feedURL = env.PDFER_SPARKLE_FEED_URL || (publish ? `https://github.com/${repository}/releases/latest/download/appcast-${arch}.xml` : null)
  if (feedURL) {
    const url = new URL(feedURL)
    const localTest = !release && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if ((!localTest && url.protocol !== 'https:') || url.username || url.password) throw new Error('Sparkle feeds require HTTPS; local HTTP is allowed only for development tests.')
  }
  if (release && platform === 'darwin' && !publicKey) throw new Error('Generate the free Sparkle key with pnpm desktop:keys before publishing a Mac release.')
  const certificate = platform === 'darwin' ? env.CSC_LINK || env.MAC_CSC_LINK : platform === 'win32' ? env.CSC_LINK || env.WIN_CSC_LINK : null
  const appleCredentials = [env.APPLE_API_KEY, env.APPLE_API_KEY_ID, env.APPLE_API_ISSUER]
  const notarize = platform === 'darwin' && !!certificate && appleCredentials.every(Boolean)
  if (platform === 'darwin' && appleCredentials.some(Boolean) && !notarize) throw new Error('Optional notarization requires a Mac signing certificate and all three Apple API credentials.')
  if (env.PDFER_REQUIRE_OS_SIGNING === '1' && platform !== 'linux' && !certificate) throw new Error('OS signing was explicitly required, but no certificate was supplied.')
  return { release, repository, publish, publicKey, feedURL, notarize,
    osSigning: !!certificate, forceCodeSigning: platform !== 'linux' && (!!certificate || env.PDFER_REQUIRE_OS_SIGNING === '1'),
    sparkleEnabled: platform === 'darwin' && !!feedURL && !!publicKey }
}

module.exports = { releaseSettings }
