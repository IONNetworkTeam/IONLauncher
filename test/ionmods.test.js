const test = require('node:test')
const assert = require('node:assert/strict')
const IonMods = require('../app/assets/js/ionmods')

function githubModule(){
    return {
        id: 'ion.github.IONNetworkTeam:IONMod:v1.4.0@jar',
        name: 'ION Mod',
        type: 'FabricMod',
        artifact: { size: 4321, MD5: 'abc', url: 'https://github.com/IONNetworkTeam/IONMod/releases/download/v1.4.0/ionmod-1.4.0.jar' },
        ion: { source: 'github', download: 'direct', projectUrl: 'https://github.com/IONNetworkTeam/IONMod', github: { repo: 'IONNetworkTeam/IONMod', assetPattern: null, prerelease: false, tag: 'v1.4.0', sha256: 'def' } }
    }
}

function asset(name, extra = {}){
    return { name, size: 100, browser_download_url: `https://github.com/o/r/releases/download/v2/${name}`, digest: null, ...extra }
}

test('classifies modules by their ion field', () => {
    assert.equal(IonMods.isGithubModule(githubModule()), true)
    assert.equal(IonMods.isManualModule(githubModule()), false)
    assert.equal(IonMods.isManualModule({ ion: { download: 'manual', manual: { pageUrl: 'https://x', fileName: 'x.jar' } } }), true)
    assert.equal(IonMods.isGithubModule({ id: 'a:b:c' }), false)
    assert.equal(IonMods.isManualModule(undefined), false)
})

test('pickAsset skips sources, dev, javadoc and api jars by default', () => {
    const assets = [asset('m-sources.jar'), asset('m-dev.jar'), asset('m-api.jar'), asset('m.jar'), asset('m.zip')]
    assert.equal(IonMods.pickAsset(assets).name, 'm.jar')
    assert.equal(IonMods.pickAsset([asset('m-sources.jar')]), null)
    assert.equal(IonMods.pickAsset(assets, 'api').name, 'm-api.jar')
    // An invalid custom pattern falls back to the default instead of crashing the launch.
    assert.equal(IonMods.pickAsset(assets, '(').name, 'm.jar')
})

test('applyRelease rewrites id, url, size and drops the stale MD5', () => {
    const raw = githubModule()
    const changed = IonMods.applyRelease(raw, { tag_name: 'v1.5.0', assets: [asset('ionmod-1.5.0.jar', { size: 5000, digest: 'sha256:0123' })] })
    assert.equal(changed, true)
    assert.equal(raw.id, 'ion.github.IONNetworkTeam:IONMod:v1.5.0@jar')
    assert.deepEqual(raw.artifact, { size: 5000, url: 'https://github.com/o/r/releases/download/v2/ionmod-1.5.0.jar' })
    assert.equal(raw.ion.github.tag, 'v1.5.0')
    assert.equal(raw.ion.github.sha256, '0123')
})

test('applyRelease keeps the module when the release is the embedded one or has no usable asset', () => {
    const raw = githubModule()
    assert.equal(IonMods.applyRelease(raw, { tag_name: 'v1.4.0', assets: [asset('ionmod-1.4.0.jar', { browser_download_url: raw.artifact.url })] }), false)
    assert.equal(raw.artifact.MD5, 'abc')
    assert.equal(IonMods.applyRelease(raw, { tag_name: 'v9', assets: [asset('ionmod-sources.jar')] }), false)
    assert.equal(raw.id, 'ion.github.IONNetworkTeam:IONMod:v1.4.0@jar')
})

test('safeTag keeps Maven ids parseable', () => {
    assert.equal(IonMods.safeTag('v1.2.3+build.4'), 'v1.2.3+build.4')
    assert.equal(IonMods.safeTag('release/2026 beta:1@x'), 'release-2026-beta-1-x')
})

test('pruneUnavailableManualModules removes only the given modules of the given server', () => {
    const distro = { version: '1.0.0', servers: [
        { id: 'smp', modules: [{ id: 'a:a:1@jar' }, { id: 'b:b:1@jar' }] },
        { id: 'other', modules: [{ id: 'a:a:1@jar' }] }
    ] }
    const pruned = IonMods.pruneUnavailableManualModules(distro, 'smp', ['a:a:1@jar'])
    assert.deepEqual(pruned.servers[0].modules.map(m => m.id), ['b:b:1@jar'])
    assert.deepEqual(pruned.servers[1].modules.map(m => m.id), ['a:a:1@jar'])
    assert.equal(distro.servers[0].modules.length, 2, 'input is not mutated')
})

function fakeGot(responses){
    const calls = []
    const fn = async (url, options) => {
        calls.push({ url, options })
        const next = responses.shift()
        return typeof next === 'function' ? next(url, options) : next
    }
    fn.calls = calls
    return fn
}

const release = { tag_name: 'v2', html_url: 'https://github.com/o/r/releases/tag/v2', draft: false, assets: [asset('r-2.jar')] }

test('fetchLatestRelease uses /releases/latest and slims the response', async () => {
    const request = fakeGot([{ statusCode: 200, headers: { etag: 'W/"1"' }, body: { ...release, extra: true } }])
    const result = await IonMods.fetchLatestRelease('o/r', false, null, request)
    assert.equal(request.calls[0].url, 'https://api.github.com/repos/o/r/releases/latest')
    assert.equal(result.release.tag_name, 'v2')
    assert.equal(result.release.extra, undefined)
    assert.deepEqual(result.release.assets[0], { name: 'r-2.jar', size: 100, browser_download_url: 'https://github.com/o/r/releases/download/v2/r-2.jar', digest: null })
    assert.equal(result.cache.etag, 'W/"1"')
})

test('fetchLatestRelease sends If-None-Match and reuses the cached release on 304', async () => {
    const cache = { etag: 'W/"1"', release }
    const request = fakeGot([{ statusCode: 304, headers: {}, body: '' }])
    const result = await IonMods.fetchLatestRelease('o/r', false, cache, request)
    assert.equal(request.calls[0].options.headers['If-None-Match'], 'W/"1"')
    assert.equal(result.release, release)
})

test('fetchLatestRelease picks the newest non-draft of /releases when pre-releases are allowed', async () => {
    const request = fakeGot([{ statusCode: 200, headers: {}, body: [{ ...release, tag_name: 'v3-draft', draft: true }, { ...release, tag_name: 'v3-beta', prerelease: true }] }])
    const result = await IonMods.fetchLatestRelease('o/r', true, null, request)
    assert.match(request.calls[0].url, /\/releases\?per_page=10$/)
    assert.equal(result.release.tag_name, 'v3-beta')
})

test('fetchLatestRelease throws on other statuses', async () => {
    const request = fakeGot([{ statusCode: 403, headers: {}, body: {} }])
    await assert.rejects(IonMods.fetchLatestRelease('o/r', false, null, request), /403/)
})
