/**
 * Reads the icons that mods and packs carry inside themselves, for the settings lists.
 *
 * Resource packs (and the odd shader pack) ship a pack.png at their root. Mod jars name their
 * logo in their metadata: fabric.mod.json and quilt.mod.json (icon), META-INF/mods.toml and
 * META-INF/neoforge.mods.toml (logoFile) and mcmod.info (logoFile). Multi-loader mods often ship
 * an undeclared assets/<modid>/icon.png, which is the fallback. Icons come back as data URLs and
 * are cached per file path, size and modification time.
 *
 * No Electron dependencies.
 */

const fs   = require('fs-extra')
const path = require('path')

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
}

// Icons larger than this are skipped; a list row has no use for them.
const MAX_ICON_BYTES = 2 * 1024 * 1024

const cache = new Map()

/**
 * Open a zip file or a folder as one reader: `read(name)` gives an entry's bytes or null, and
 * `names()` the zip's file names (none for a folder). Zip packs zipped with a top level folder
 * are accepted one level deep.
 */
async function openArchive(file){
    const stats = await fs.stat(file)
    if(stats.isDirectory()){
        return {
            stats,
            async read(name){
                const target = path.join(file, name)
                // Names come from the archive's own metadata; never leave the folder.
                if(path.relative(file, target).startsWith('..')){
                    return null
                }
                return await fs.pathExists(target) ? fs.readFile(target) : null
            },
            names(){
                return []
            }
        }
    }
    const AdmZip = require('adm-zip')
    const zip = new AdmZip(await fs.readFile(file))
    const entries = zip.getEntries()
    return {
        stats,
        async read(name){
            const entry = zip.getEntry(name) || entries.find(e => !e.isDirectory && e.entryName.replace(/^[^/]+\//, '') === name)
            if(entry == null || entry.isDirectory || entry.header.size > MAX_ICON_BYTES){
                return null
            }
            return entry.getData()
        },
        names(){
            return entries.filter(e => !e.isDirectory).map(e => e.entryName)
        }
    }
}

function toDataUrl(name, data){
    const mime = MIME_TYPES[path.extname(name).toLowerCase()]
    if(mime == null || data == null || data.length === 0 || data.length > MAX_ICON_BYTES){
        return null
    }
    return `data:${mime};base64,${data.toString('base64')}`
}

function parseJson(data){
    if(data == null){
        return null
    }
    try {
        return JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''))
    } catch {
        return null
    }
}

/**
 * Pick one path out of a fabric/quilt icon field: a string, or an object keyed by pixel size.
 * The smallest icon of at least 64px is preferred, else the largest there is.
 */
function pickSizedIcon(icon){
    if(typeof icon === 'string'){
        return icon
    }
    if(icon == null || typeof icon !== 'object'){
        return null
    }
    const sizes = Object.keys(icon).map(Number).filter(n => !Number.isNaN(n)).sort((a, b) => a - b)
    if(sizes.length === 0){
        return null
    }
    const size = sizes.find(n => n >= 64) ?? sizes[sizes.length - 1]
    return typeof icon[size] === 'string' ? icon[size] : null
}

/**
 * The logo and mod ids a mods.toml declares.
 *
 * @returns {{icon: string|null, ids: string[]}}
 */
function readModsToml(data){
    if(data == null){
        return { icon: null, ids: [] }
    }
    const text = data.toString('utf8')
    let parsed
    try {
        parsed = require('toml').parse(text)
    } catch {
        // Some mods.toml files carry syntax the strict parser rejects; fall back to plain matches.
        const logo = /^\s*logoFile\s*=\s*["']([^"']+)["']/m.exec(text)
        const ids = [...text.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)].map(m => m[1])
        return { icon: logo != null ? logo[1] : null, ids }
    }
    const mods = Array.isArray(parsed.mods) ? parsed.mods : []
    const mod = mods.find(m => typeof m.logoFile === 'string')
    return {
        icon: typeof parsed.logoFile === 'string' ? parsed.logoFile : mod != null ? mod.logoFile : null,
        ids: mods.map(m => m.modId).filter(id => typeof id === 'string')
    }
}

/**
 * The logo and mod ids an mcmod.info declares.
 *
 * @returns {{icon: string|null, ids: string[]}}
 */
function readMcmodInfo(data){
    const info = parseJson(data)
    const list = (Array.isArray(info) ? info : info != null && Array.isArray(info.modList) ? info.modList : []).filter(m => m != null)
    const mod = list.find(m => typeof m.logoFile === 'string' && m.logoFile.length > 0)
    return {
        icon: mod != null ? mod.logoFile : null,
        ids: list.map(m => m.modid).filter(id => typeof id === 'string')
    }
}

/**
 * The paths a mod jar might keep its icon at, in order of preference.
 */
async function modIconCandidates(archive){
    const candidates = []
    const ids = []
    const fabric = parseJson(await archive.read('fabric.mod.json'))
    if(fabric != null){
        candidates.push(pickSizedIcon(fabric.icon))
        ids.push(fabric.id)
    }
    const quilt = parseJson(await archive.read('quilt.mod.json'))
    if(quilt != null && quilt.quilt_loader != null){
        if(quilt.quilt_loader.metadata != null){
            candidates.push(pickSizedIcon(quilt.quilt_loader.metadata.icon))
        }
        ids.push(quilt.quilt_loader.id)
    }
    for(const meta of [
        readModsToml(await archive.read('META-INF/neoforge.mods.toml')),
        readModsToml(await archive.read('META-INF/mods.toml')),
        readMcmodInfo(await archive.read('mcmod.info'))
    ]){
        candidates.push(meta.icon)
        ids.push(...meta.ids)
    }
    for(const id of ids){
        if(typeof id === 'string'){
            candidates.push(`assets/${id}/icon.png`)
        }
    }
    candidates.push(...archive.names().filter(name => /^assets\/[^/]+\/icon\.png$/.test(name)))
    candidates.push('pack.png', 'icon.png', 'logo.png')
    return candidates.filter(c => typeof c === 'string' && c.length > 0).map(c => c.replace(/^[./\\]+/, ''))
}

async function readFirstIcon(archive, candidates){
    for(const name of candidates){
        const url = toDataUrl(name, await archive.read(name))
        if(url != null){
            return url
        }
    }
    return null
}

async function cached(kind, file, read){
    let stats
    try {
        stats = await fs.stat(file)
    } catch {
        return null
    }
    const key = `${kind}\0${file}\0${stats.size}\0${stats.mtimeMs}`
    if(!cache.has(key)){
        cache.set(key, (async () => {
            try {
                return await read(await openArchive(file))
            } catch {
                return null
            }
        })())
    }
    return cache.get(key)
}

/**
 * The icon of a resource pack or shader pack.
 *
 * @param {string} packPath Path of the zip file or folder.
 * @returns {Promise<string|null>} A data URL, or null when the pack has no icon.
 */
function readPackIcon(packPath){
    return cached('pack', packPath, archive => readFirstIcon(archive, ['pack.png']))
}

/**
 * The icon of a mod jar.
 *
 * @param {string} jarPath Path of the jar (or zip/litemod) file.
 * @returns {Promise<string|null>} A data URL, or null when the mod has no icon.
 */
function readModIcon(jarPath){
    return cached('mod', jarPath, async archive => readFirstIcon(archive, await modIconCandidates(archive)))
}

module.exports = {
    readPackIcon,
    readModIcon,
    pickSizedIcon
}
