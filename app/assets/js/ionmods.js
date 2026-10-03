/**
 * ION's extensions to the distribution index (the `ion` field on mod modules; see docs/distro.md):
 * mods downloaded from a GitHub repository's newest release, and mods players must download
 * themselves. These helpers are pure so they can be tested with `npm test`; the launch flow in
 * scripts/modsetup.js and the settings UI use them.
 */
const got = require('got')
const fs = require('fs/promises')
const path = require('path')

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
    const sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
    // Rolling tags (latest, nightly) keep id and URL but re-upload the bytes: compare size and digest too.
    const same = raw.id === id && raw.artifact.url === asset.browser_download_url
        && raw.artifact.size === asset.size && (raw.ion.github.sha256 ?? null) === sha256
    if(same) return false
    raw.id = id
    raw.artifact = { size: asset.size, url: asset.browser_download_url }
    raw.ion.github.tag = release.tag_name
    raw.ion.github.sha256 = sha256
    return true
}

/**
 * The release to launch with: GitHub's answer when reachable, otherwise the release cached from
 * the previous launch (the jar the player already has), and only when there is no cache at all
 * does the error propagate so the caller can fall back to the index's embedded values.
 */
async function resolveGithubRelease(repo, prerelease, cache, request = got){
    try {
        return { ...await fetchLatestRelease(repo, prerelease, cache, request), fromCache: false }
    } catch(err) {
        if(cache?.release) return { release: cache.release, cache, fromCache: true, error: err }
        throw err
    }
}

/**
 * Files in the Downloads folder that may be `fileName`: the exact name, and the duplicates
 * browsers create when it already exists (`x (1).jar`, `x-1.jar`), newest duplicate first.
 */
function candidateDownloads(fileName, names){
    const base = fileName.replace(/\.jar$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^${base}(?: \\((\\d+)\\)|-(\\d+))?\\.jar$`, 'i')
    return names
        .map(name => { const m = re.exec(name); return m ? { name, n: Number(m[1] ?? m[2] ?? 0) } : null })
        .filter(Boolean)
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .map(c => c.name)
}

/** Write JSON through a temp file and rename, so a crash never leaves a half-written index. */
async function writeJsonAtomic(file, data){
    const tmp = `${file}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(data))
    await fs.rename(tmp, file)
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

/**
 * Newest release of `repo`. Uses a conditional request so repeated launches don't eat GitHub's
 * 60 requests/hour for unauthenticated clients (304 responses are free). `cache` is what a
 * previous call returned, or null. Throws when GitHub can't be reached or answers with an error;
 * callers fall back to the release embedded in the distribution.
 */
async function fetchLatestRelease(repo, prerelease, cache, request = got){
    const url = prerelease
        ? `https://api.github.com/repos/${repo}/releases?per_page=10`
        : `https://api.github.com/repos/${repo}/releases/latest`
    const headers = {
        'User-Agent': 'ION-Launcher',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    }
    if(cache?.etag) headers['If-None-Match'] = cache.etag

    const res = await request(url, { headers, responseType: 'json', throwHttpErrors: false, timeout: 8000 })
    if(res.statusCode === 304 && cache?.release) return { release: cache.release, cache }
    if(res.statusCode !== 200) throw new Error(`GitHub answered ${res.statusCode} for ${repo}`)

    const found = Array.isArray(res.body) ? res.body.find(r => !r.draft) : res.body
    if(found == null) throw new Error(`${repo} has no releases`)
    const release = {
        tag_name: found.tag_name,
        html_url: found.html_url,
        assets: (found.assets || []).map(a => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url, digest: a.digest ?? null }))
    }
    return { release, cache: { etag: res.headers?.etag || null, release, fetchedAt: Date.now() } }
}

module.exports = {
    DEFAULT_ASSET_PATTERN,
    fetchLatestRelease,
    resolveGithubRelease,
    candidateDownloads,
    writeJsonAtomic,
    isGithubModule,
    isManualModule,
    safeTag,
    pickAsset,
    applyRelease,
    pruneUnavailableManualModules
}
