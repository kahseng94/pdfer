const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hasNoPublishedRelease } = require('../release-status.cjs')

const feedURL = 'https://github.com/example/pdfer/releases/latest/download/appcast-arm64.xml'
const repository = { full_name: 'example/pdfer', private: false }

test('identifies an existing public repository without a stable release', async () => {
  const requests = []
  const fetcher = async (url) => {
    requests.push(url)
    return url === feedURL || url.endsWith('/releases/latest') ? new Response(null, { status: 404 }) : Response.json(repository)
  }
  assert.equal(await hasNoPublishedRelease(feedURL, { fetcher }), true)
  assert.deepEqual(requests, [feedURL, 'https://api.github.com/repos/example/pdfer/releases/latest', 'https://api.github.com/repos/example/pdfer'])
})

test('does not hide a broken published feed, missing repository, or rate limit', async () => {
  for (const [latest, repo] of [[200, 200], [403, 200], [404, 404], [404, 403]]) {
    const fetcher = async (url) => url === feedURL ? new Response(null, { status: 404 })
      : url.endsWith('/releases/latest') ? new Response(null, { status: latest }) : Response.json(repository, { status: repo })
    assert.equal(await hasNoPublishedRelease(feedURL, { fetcher }), false)
  }
  assert.equal(await hasNoPublishedRelease(feedURL, { fetcher: async () => { throw new Error('offline') } }), false)
})

test('requires the configured repository to be public and match its API identity', async () => {
  for (const data of [{ ...repository, private: true }, { ...repository, full_name: 'someone/else' }, {}]) {
    assert.equal(await hasNoPublishedRelease(feedURL, { fetcher: async (url) => url === feedURL || url.endsWith('/releases/latest')
      ? new Response(null, { status: 404 }) : Response.json(data) }), false)
  }
})

test('existing or unreachable feeds stay under Sparkle validation and error handling', async () => {
  for (const status of [200, 403, 429, 500]) {
    const fetcher = async (url) => { assert.equal(url, feedURL); return new Response(null, { status }) }
    assert.equal(await hasNoPublishedRelease(feedURL, { fetcher }), false)
  }
})

test('does not query GitHub for custom feeds or unexpected URL forms', async () => {
  for (const url of ['http://127.0.0.1:1234/feed.xml', 'https://example.com/feed.xml',
    'https://user:password@github.com/example/pdfer/releases/latest/download/appcast-arm64.xml',
    'https://github.com/example/pdfer/releases/latest/download/other.xml', `${feedURL}?token=secret`]) {
    assert.equal(await hasNoPublishedRelease(url, { fetcher: () => assert.fail('Unexpected request') }), false)
  }
})
