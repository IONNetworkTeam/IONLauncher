/**
 * ION's extensions to the distribution index (the `ion` field on mod modules; see docs/distro.md):
 * mods downloaded from a GitHub repository's newest release, and mods players must download
 * themselves. These helpers are pure so they can be tested with `npm test`; the launch flow in
 * scripts/modsetup.js and the settings UI use them.
 */

/** First `.jar` that isn't a sources / dev / javadoc / api / shadow artifact. Same as the Manager's. */
const DEFAULT_ASSET_PATTERN = '^(?!.*(?:-sources|-dev|-javadoc|-api|-shadow)\\b).*\\.jar$'

function isGithubModule(raw){
    return raw?.ion?.source === 'github' && raw.ion.github != null
}

function isManualModule(raw){
    return raw?.ion?.download === 'manual' && raw.ion.manual != null
}

/** Tags end up in Maven ids and paths, which Helios splits on `:` and `@`. */
function safeTag(tag){
    return String(tag).replace(/[^A-Za-z0-9._+-]/g, '-')
}

function pickAsset(assets, pattern){
    let re
    try {
        re = new RegExp(pattern || DEFAULT_ASSET_PATTERN, 'i')
    } catch {
        re = new RegExp(DEFAULT_ASSET_PATTERN, 'i')
    }
    return (assets || []).find(a => re.test(a.name)) || null
}

/**
 * Point a GitHub module at a release. Returns true when the module changed.
 *
 * The id's version becomes the tag, so a new release lands at a new path under modstore and
 * stale copies never shadow it. MD5 is dropped: GitHub only publishes SHA-256 digests, which
 * modsetup.js checks instead.
 */
function applyRelease(raw, release){
    const asset = pickAsset(release.assets, raw.ion.github.assetPattern)
    if(asset == null) return false
    const [group, artifact] = raw.id.split(':')
    const id = `${group}:${artifact}:${safeTag(release.tag_name)}@jar`
    if(raw.id === id && raw.artifact.url === asset.browser_download_url) return false
    raw.id = id
    raw.artifact = { size: asset.size, url: asset.browser_download_url }
    raw.ion.github.tag = release.tag_name
    raw.ion.github.sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
    return true
}

/**
 * The copy of the index written for Helios' FullRepair child: manual mods without a local file
 * are left out, so the child never tries to download their web page. The input is not mutated.
 */
function pruneUnavailableManualModules(rawDistribution, serverId, unavailableIds){
    const skip = new Set(unavailableIds)
    return {
        ...rawDistribution,
        servers: rawDistribution.servers.map(s => s.id !== serverId ? s : { ...s, modules: s.modules.filter(m => !skip.has(m.id)) })
    }
}

module.exports = {
    DEFAULT_ASSET_PATTERN,
    isGithubModule,
    isManualModule,
    safeTag,
    pickAsset,
    applyRelease,
    pruneUnavailableManualModules
}
