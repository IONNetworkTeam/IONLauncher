/**
 * Finds icons on Modrinth for packs that carry none themselves (most shader packs).
 *
 * A zip pack is matched exactly by the SHA-1 of its file (POST /version_files), which works for
 * any pack downloaded from Modrinth. Packs Modrinth does not know by hash (folders, GitHub zips)
 * fall back to a search by name, accepted only when the project's slug or title equals the name
 * the file starts with: "ComplementaryReimagined_r5.6.1 + EuphoriaPatches" is looked up as
 * "Complementary Reimagined". CurseForge is not asked: its API needs a key a desktop app can't
 * keep secret.
 *
 * Results are cached on disk so a pack is looked up once, not on every settings visit. Lookups
 * that fail (offline, rate limited) are not cached and give null.
 *
 * No Electron dependencies.
 */

const crypto = require('crypto')
const fs     = require('fs-extra')
const path   = require('path')

const API = 'https://api.modrinth.com/v2'
const HEADERS = { 'User-Agent': 'ION-Launcher (github.com/IONNetworkTeam/IONLauncher)' }

const FOUND_TTL = 30 * 24 * 60 * 60 * 1000
const MISSING_TTL = 7 * 24 * 60 * 60 * 1000

const PROJECT_TYPES = { shader: 'shader', resource: 'resourcepack' }

/**
 * The name a pack file starts with: no extension, nothing after a "+", camel case split, and no
 * version or branch suffix.
 *
 * @param {string} fileName
 * @returns {string}
 */
function packSearchName(fileName){
    return fileName
        .replace(/\.zip$/i, '')
        .split('+')[0]
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .replace(/\s(v|r)?\d[\w.]*.*$/i, '')
        .replace(/\s(main|master)$/i, '')
        .trim()
}

function normalizeName(s){
    return String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(shaders?|shaderpack|resourcepack|pack)$/, '')
}

function sha1File(file){
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1')
        fs.createReadStream(file).on('error', reject).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex')))
    })
}

class ModrinthIcons {

    /**
     * @param {Object} opts
     * @param {string} opts.cacheFile JSON file the results are kept in.
     * @param {Function} [opts.request] got-like `(url, options) => Promise<{statusCode, body}>`.
     * @param {Function} [opts.now]
     */
    constructor({ cacheFile, request, now = Date.now }){
        this.cacheFile = cacheFile
        this.request = request || ((url, options) => require('got')(url, options))
        this.now = now
        this.cache = null
        this.queue = []
        this.flushTimer = null
        this.saveTimer = null
    }

    async loadCache(){
        if(this.cache == null){
            try {
                this.cache = await fs.readJson(this.cacheFile)
            } catch {
                this.cache = {}
            }
            this.cache.hashes = this.cache.hashes || {}
            this.cache.names = this.cache.names || {}
        }
        return this.cache
    }

    cached(table, key){
        const entry = this.cache[table][key]
        if(entry == null){
            return undefined
        }
        const ttl = entry.icon != null ? FOUND_TTL : MISSING_TTL
        return this.now() - entry.at < ttl ? entry.icon : undefined
    }

    remember(table, key, icon){
        this.cache[table][key] = { icon, at: this.now() }
        clearTimeout(this.saveTimer)
        this.saveTimer = setTimeout(() => {
            fs.outputJson(this.cacheFile, this.cache).catch(() => {})
        }, 500)
    }

    async api(pathAndQuery, json){
        const res = await this.request(`${API}${pathAndQuery}`, {
            method: json !== undefined ? 'POST' : 'GET',
            json,
            headers: HEADERS,
            responseType: 'json',
            throwHttpErrors: false,
            timeout: 8000
        })
        if(res.statusCode !== 200){
            throw new Error(`Modrinth answered ${res.statusCode} for ${pathAndQuery}`)
        }
        return res.body
    }

    /**
     * Look up the queued hashes together: one request for the versions, one for their projects.
     */
    async flush(){
        const batch = this.queue
        this.queue = []
        this.flushTimer = null
        const hashes = [...new Set(batch.map(b => b.hash))]
        let icons = {}
        try {
            const versions = await this.api('/version_files', { hashes, algorithm: 'sha1' })
            const projectIds = [...new Set(Object.values(versions).map(v => v.project_id))]
            const projects = projectIds.length > 0
                ? await this.api(`/projects?${new URLSearchParams({ ids: JSON.stringify(projectIds) })}`)
                : []
            const iconOf = Object.fromEntries(projects.map(p => [p.id, p.icon_url || null]))
            icons = Object.fromEntries(hashes.map(h => [h, versions[h] != null ? iconOf[versions[h].project_id] ?? null : null]))
            for(const h of hashes){
                this.remember('hashes', h, icons[h])
            }
        } catch {
            // Not cached: try again next time.
            icons = null
        }
        for(const b of batch){
            b.resolve(icons != null ? { icon: icons[b.hash] } : null)
        }
    }

    /**
     * @returns {Promise<{icon: string|null}|null>} null when Modrinth could not be asked.
     */
    lookupHash(hash){
        const known = this.cached('hashes', hash)
        if(known !== undefined){
            return Promise.resolve({ icon: known })
        }
        return new Promise(resolve => {
            this.queue.push({ hash, resolve })
            if(this.flushTimer == null){
                this.flushTimer = setTimeout(() => this.flush(), 50)
            }
        })
    }

    async lookupName(name, kind){
        const key = `${kind}:${normalizeName(name)}`
        const known = this.cached('names', key)
        if(known !== undefined){
            return known
        }
        try {
            const params = new URLSearchParams({ query: name, limit: '5', facets: JSON.stringify([[`project_type:${PROJECT_TYPES[kind]}`]]) })
            const result = await this.api(`/search?${params}`)
            const want = normalizeName(name)
            const hit = (result.hits || []).find(h => normalizeName(h.slug) === want || normalizeName(h.title) === want)
            const icon = hit != null ? hit.icon_url || null : null
            this.remember('names', key, icon)
            return icon
        } catch {
            return null
        }
    }

    /**
     * The Modrinth icon of a resource pack or shader pack.
     *
     * @param {string} packPath Path of the zip file or folder.
     * @param {'shader'|'resource'} kind
     * @returns {Promise<string|null>} The icon's URL, or null.
     */
    async lookupPackIcon(packPath, kind){
        if(PROJECT_TYPES[kind] == null){
            return null
        }
        await this.loadCache()
        try {
            const stats = await fs.stat(packPath)
            if(stats.isFile()){
                const found = await this.lookupHash(await sha1File(packPath))
                if(found != null && found.icon != null){
                    return found.icon
                }
            }
        } catch {
            return null
        }
        const name = packSearchName(path.basename(packPath))
        return name.length >= 3 ? this.lookupName(name, kind) : null
    }
}

module.exports = {
    ModrinthIcons,
    packSearchName
}
