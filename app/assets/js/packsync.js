/**
 * Shares resource packs and shader packs between instances.
 *
 * Every participating instance's resourcepacks/ and shaderpacks/ directories are scanned. A pack
 * first seen in one instance (its origin) is linked into every other instance where it works:
 * resource packs when their pack format fits the instance's Minecraft version, shader packs when
 * the instance has a shader loader (OptiFine, Iris or Oculus). Zip packs are hard linked so they
 * take no extra disk space; folder packs are symlinked. Copying is the fallback when linking is
 * impossible. A pack can be forced into every instance ("everywhere") or kept out of sharing
 * ("off") per pack. Removing a linked copy by hand keeps that pack out of that instance.
 *
 * No Electron dependencies; the SettingsSync module owns the store and drives this.
 */

const fs   = require('fs-extra')
const path = require('path')

const PACK_KINDS = [
    { dir: 'resourcepacks', kind: 'resource' },
    { dir: 'shaderpacks', kind: 'shader' }
]

/**
 * Resource pack format of Minecraft releases. 1.14+ jars carry the value in version.json; this
 * table covers older releases and serves as a fallback.
 */
const RESOURCE_FORMATS = [
    ['1.21.9', 69], ['1.21.7', 64], ['1.21.6', 63], ['1.21.5', 55], ['1.21.4', 46], ['1.21.2', 42], ['1.21', 34],
    ['1.20.5', 32], ['1.20.3', 22], ['1.20.2', 18], ['1.20', 15],
    ['1.19.4', 13], ['1.19.3', 12], ['1.19', 9],
    ['1.18', 8], ['1.17', 7], ['1.16.2', 6], ['1.15', 5], ['1.13', 4], ['1.11', 3], ['1.9', 2], ['1.6', 1]
]

const SHADER_LOADER_PATTERN = /optifine|iris|oculus/i

function parseVersion(v){
    return String(v).split('.').map(n => Number.parseInt(n, 10) || 0)
}

function compareVersions(a, b){
    const pa = parseVersion(a)
    const pb = parseVersion(b)
    for(let i = 0; i < Math.max(pa.length, pb.length); i++){
        const d = (pa[i] || 0) - (pb[i] || 0)
        if(d !== 0){
            return d
        }
    }
    return 0
}

/**
 * Resource pack format of a Minecraft release, from the built-in table.
 *
 * @param {string} mcVersion
 * @returns {number|null}
 */
function resourceFormatForMinecraft(mcVersion){
    for(const [since, format] of RESOURCE_FORMATS){
        if(compareVersions(mcVersion, since) >= 0){
            return format
        }
    }
    return null
}

/**
 * Resource pack format from a client jar's version.json. The shape changed twice: a number up to
 * 1.20.1, {resource, data} up to 1.21.8, {resource_major, resource_minor, ...} from 1.21.9.
 *
 * @param {Object} versionJson Parsed version.json.
 * @returns {number|null}
 */
function resourceFormatFromVersionJson(versionJson){
    const pv = versionJson != null ? versionJson.pack_version : undefined
    if(typeof pv === 'number'){
        return pv
    }
    if(pv != null && typeof pv === 'object'){
        if(typeof pv.resource_major === 'number'){
            return pv.resource_major
        }
        if(typeof pv.resource === 'number'){
            return pv.resource
        }
        if(Array.isArray(pv.resource) && typeof pv.resource[0] === 'number'){
            return pv.resource[0]
        }
    }
    return null
}

/** Major part of a pack format, which may be a number or a [major, minor] pair. */
function majorOf(value){
    if(typeof value === 'number'){
        return value
    }
    if(Array.isArray(value) && typeof value[0] === 'number'){
        return value[0]
    }
    return null
}

/**
 * Work out the range of resource pack formats a pack.mcmeta declares support for.
 *
 * @param {Object} mcmeta Parsed pack.mcmeta.
 * @returns {{min: number, max: number}|null} Null when the file declares nothing usable.
 */
function formatRangeOf(mcmeta){
    const pack = mcmeta != null ? mcmeta.pack : undefined
    if(pack == null || typeof pack !== 'object'){
        return null
    }
    // 1.21.9+: min_format / max_format, each a number or [major, minor].
    const minF = majorOf(pack.min_format)
    const maxF = majorOf(pack.max_format)
    if(minF != null || maxF != null){
        const base = majorOf(pack.pack_format)
        return { min: minF != null ? minF : (base != null ? base : maxF), max: maxF != null ? maxF : (base != null ? base : minF) }
    }
    // 1.20.2+: supported_formats as a number, [min, max] or {min_inclusive, max_inclusive}.
    const sf = pack.supported_formats
    if(typeof sf === 'number'){
        return { min: sf, max: sf }
    }
    if(Array.isArray(sf) && sf.length >= 2 && typeof sf[0] === 'number' && typeof sf[1] === 'number'){
        return { min: sf[0], max: sf[1] }
    }
    if(sf != null && typeof sf === 'object' && typeof sf.min_inclusive === 'number' && typeof sf.max_inclusive === 'number'){
        return { min: sf.min_inclusive, max: sf.max_inclusive }
    }
    const pf = majorOf(pack.pack_format)
    return pf != null ? { min: pf, max: pf } : null
}

function parseMcmeta(text){
    // Minecraft is lenient about pack.mcmeta; so are we (BOM, trailing commas).
    const cleaned = text.replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(cleaned)
}

/**
 * Read what a pack declares about itself.
 *
 * @param {string} packPath Path of the zip file or folder.
 * @param {'resource'|'shader'} kind
 * @returns {Promise<{formats: {min: number, max: number}|null, description: string|null, valid: boolean}>}
 *          `valid` is false when the pack does not look like a pack of that kind at all.
 */
async function readPackMeta(packPath, kind){
    const stats = await fs.stat(packPath)
    const isDir = stats.isDirectory()
    const readEntry = async (name) => {
        if(isDir){
            const file = path.join(packPath, name)
            return await fs.pathExists(file) ? await fs.readFile(file, 'utf8') : null
        }
        const AdmZip = require('adm-zip')
        const zip = new AdmZip(packPath)
        // Some packs are zipped with a top level folder; accept one level of nesting.
        const entry = zip.getEntry(name) || zip.getEntries().find(e => e.entryName.replace(/^[^/]+\//, '') === name)
        return entry != null ? entry.getData().toString('utf8') : null
    }
    const hasEntryPrefix = async (prefix) => {
        if(isDir){
            return fs.pathExists(path.join(packPath, prefix))
        }
        const AdmZip = require('adm-zip')
        return new AdmZip(packPath).getEntries().some(e => e.entryName === prefix || e.entryName.startsWith(prefix + '/') || e.entryName.replace(/^[^/]+\//, '').startsWith(prefix + '/'))
    }

    if(kind === 'shader'){
        const valid = await hasEntryPrefix('shaders')
        return { formats: null, description: null, valid }
    }
    const text = await readEntry('pack.mcmeta')
    if(text == null){
        return { formats: null, description: null, valid: false }
    }
    let mcmeta
    try {
        mcmeta = parseMcmeta(text)
    } catch {
        return { formats: null, description: null, valid: true }
    }
    const desc = mcmeta.pack != null ? mcmeta.pack.description : null
    return {
        formats: formatRangeOf(mcmeta),
        description: typeof desc === 'string' ? desc : (desc != null && typeof desc.text === 'string' ? desc.text : null),
        valid: true
    }
}

/**
 * Whether a pack works in an instance, going by what the pack and the instance declare.
 *
 * @param {'resource'|'shader'} kind
 * @param {{formats: {min: number, max: number}|null}} meta The pack's metadata.
 * @param {{resourceFormat: number|null, hasShaderLoader: boolean}} instance
 * @returns {boolean}
 */
function isCompatible(kind, meta, instance){
    if(kind === 'shader'){
        return instance.hasShaderLoader === true
    }
    if(meta.formats == null || instance.resourceFormat == null){
        return false
    }
    return instance.resourceFormat >= meta.formats.min && instance.resourceFormat <= meta.formats.max
}

/**
 * Whether a mods directory contains a shader loader (drop-in Iris, Oculus or OptiFine).
 */
async function modsDirHasShaderLoader(modsDir){
    try {
        return (await fs.readdir(modsDir)).some(f => /\.jar(\.disabled)?$/i.test(f) && SHADER_LOADER_PATTERN.test(f))
    } catch {
        return false
    }
}

/**
 * Put a copy of a pack into an instance, preferring links over copies.
 *
 * @returns {Promise<'hardlink'|'symlink'|'copy'>} How the copy was made.
 */
async function linkPack(src, dest, isDir){
    await fs.ensureDir(path.dirname(dest))
    if(isDir){
        try {
            await fs.symlink(src, dest, process.platform === 'win32' ? 'junction' : 'dir')
            return 'symlink'
        } catch {
            await fs.copy(src, dest)
            return 'copy'
        }
    }
    try {
        await fs.link(src, dest)
        return 'hardlink'
    } catch {
        await fs.copyFile(src, dest)
        return 'copy'
    }
}

/**
 * Whether a linked copy still matches its origin.
 */
async function copyIsCurrent(originPath, destPath, isDir){
    try {
        const [o, d] = await Promise.all([fs.stat(originPath), fs.lstat(destPath)])
        if(isDir){
            if(d.isSymbolicLink()){
                return path.resolve(await fs.readlink(destPath)) === path.resolve(originPath)
            }
            return d.isDirectory()
        }
        if(o.ino === d.ino && o.dev === d.dev){
            return true
        }
        return o.size === d.size && Math.abs(o.mtimeMs - d.mtimeMs) < 1000
    } catch {
        return false
    }
}

async function listPacks(dir){
    let names
    try {
        names = await fs.readdir(dir)
    } catch {
        return []
    }
    const packs = []
    for(const name of names){
        if(name.startsWith('.')){
            continue
        }
        let stats
        try {
            stats = await fs.lstat(path.join(dir, name))
        } catch {
            continue
        }
        const isDir = stats.isDirectory() || stats.isSymbolicLink()
        if(isDir || /\.zip$/i.test(name)){
            packs.push({ name, isDir })
        }
    }
    return packs
}

class PackSync {

    /**
     * @param {Object} opts
     * @param {string} opts.instanceDir Directory holding one sub directory per server id.
     * @param {Object} [opts.logger]
     */
    constructor({ instanceDir, logger }){
        this.instanceDir = instanceDir
        this.logger = logger || { info(){}, warn(){}, error(){} }
    }

    packPath(serverId, dir, name){
        return path.join(this.instanceDir, serverId, dir, name)
    }

    /**
     * Share packs between the participating instances.
     *
     * @param {Object} store The settings sync store; `store.packs` is created and updated.
     * @param {Array<{id: string, resourceFormat: number|null, hasShaderLoader: boolean}>} servers
     * @param {Object<string, 'compatible'|'everywhere'|'off'>} modes Per pack name overrides.
     */
    async sync(store, servers, modes = {}){
        if(store.packs == null){
            store.packs = {}
        }
        for(const { dir, kind } of PACK_KINDS){
            if(store.packs[dir] == null){
                store.packs[dir] = {}
            }
            await this.syncKind(store.packs[dir], dir, kind, servers, modes)
        }
    }

    async syncKind(records, dir, kind, servers, modes){
        const present = {}
        for(const server of servers){
            present[server.id] = new Map((await listPacks(path.join(this.instanceDir, server.id, dir))).map(p => [p.name, p]))
        }

        // Adopt packs the launcher has not seen yet.
        for(const server of servers){
            for(const [name, info] of present[server.id]){
                if(records[name] == null){
                    records[name] = { origin: server.id, isDir: info.isDir, linked: [], excluded: [], meta: null, size: 0, mtimeMs: 0 }
                }
            }
        }

        for(const [name, rec] of Object.entries(records)){
            rec.linked = rec.linked || []
            rec.excluded = rec.excluded || []

            // Copies removed by the player stay removed in that instance.
            for(const id of [...rec.linked]){
                if(present[id] != null && !present[id].has(name)){
                    rec.linked = rec.linked.filter(x => x !== id)
                    if(!rec.excluded.includes(id)){
                        rec.excluded.push(id)
                    }
                    this.logger.info(`${name} was removed from ${id}; it stays out of that instance.`)
                }
            }

            // Make sure the origin still has the pack, or find a new origin among own copies.
            if(present[rec.origin] == null || !present[rec.origin].has(name)){
                const other = servers.find(s => present[s.id].has(name) && !rec.linked.includes(s.id))
                if(other == null){
                    if(present[rec.origin] != null || servers.some(s => rec.linked.includes(s.id))){
                        await this.removeLinks(rec, dir, name, servers)
                        if(present[rec.origin] != null){
                            this.logger.info(`${name} was deleted from ${rec.origin}; removed it from the other instances.`)
                            delete records[name]
                        }
                    }
                    continue
                }
                rec.origin = other.id
                rec.isDir = present[other.id].get(name).isDir
            }

            const originPath = this.packPath(rec.origin, dir, name)
            let originStats
            try {
                originStats = await fs.stat(originPath)
            } catch {
                continue
            }
            if(rec.meta == null || rec.size !== originStats.size || rec.mtimeMs !== originStats.mtimeMs){
                try {
                    rec.meta = await readPackMeta(originPath, kind)
                } catch(err) {
                    this.logger.warn(`Could not read ${name} in ${rec.origin}.`, err)
                    rec.meta = { formats: null, description: null, valid: false }
                }
                rec.size = originStats.size
                rec.mtimeMs = originStats.mtimeMs
            }

            const mode = modes[name] || 'compatible'
            if(mode === 'off' || !rec.meta.valid){
                await this.removeLinks(rec, dir, name, servers)
                continue
            }

            for(const server of servers){
                if(server.id === rec.origin || rec.excluded.includes(server.id)){
                    continue
                }
                const exists = present[server.id].has(name)
                const linkedByUs = rec.linked.includes(server.id)
                if(exists && !linkedByUs){
                    continue // The player's own copy; leave it alone.
                }
                const fits = mode === 'everywhere' || isCompatible(kind, rec.meta, server)
                const destPath = this.packPath(server.id, dir, name)
                if(!fits){
                    if(linkedByUs){
                        await fs.remove(destPath)
                        rec.linked = rec.linked.filter(x => x !== server.id)
                        this.logger.info(`Removed ${name} from ${server.id}: it does not fit Minecraft ${server.minecraftVersion}.`)
                    }
                    continue
                }
                if(linkedByUs && await copyIsCurrent(originPath, destPath, rec.isDir)){
                    continue
                }
                if(linkedByUs){
                    await fs.remove(destPath)
                }
                const how = await linkPack(originPath, destPath, rec.isDir)
                if(!linkedByUs){
                    rec.linked.push(server.id)
                }
                this.logger.info(`Shared ${name} with ${server.id} (${how}).`)
            }
        }
    }

    async removeLinks(rec, dir, name, servers){
        for(const server of servers){
            if(rec.linked.includes(server.id)){
                await fs.remove(this.packPath(server.id, dir, name))
                rec.linked = rec.linked.filter(x => x !== server.id)
            }
        }
    }
}

module.exports = {
    PACK_KINDS,
    PackSync,
    SHADER_LOADER_PATTERN,
    resourceFormatForMinecraft,
    resourceFormatFromVersionJson,
    formatRangeOf,
    readPackMeta,
    isCompatible,
    modsDirHasShaderLoader,
    linkPack
}
