/**
 * What a wallpaper sync has to do, worked out without touching the disk or the network: which
 * pictures to download, which files are no longer needed, and the manifest afterwards.
 *
 * @module wallsync
 */
const crypto = require('crypto')
const path = require('path')

function emptyManifest(){
    return { version: 1, files: {}, releases: {}, retired: [] }
}

function parseManifest(text){
    try {
        const m = JSON.parse(text)
        if(!m || typeof m !== 'object' || Array.isArray(m) || m.version !== 1) return emptyManifest()
        return {
            version: 1,
            files: m.files && typeof m.files === 'object' ? m.files : {},
            releases: m.releases && typeof m.releases === 'object' ? m.releases : {},
            retired: Array.isArray(m.retired) ? m.retired.filter(f => typeof f === 'string') : []
        }
    } catch {
        return emptyManifest()
    }
}

function fileNameFor(id, version, url){
    const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_').slice(0, 64)
    const tag = crypto.createHash('sha1').update(String(version)).digest('hex').slice(0, 8)
    const ext = path.extname(String(url).split('?')[0]).toLowerCase()
    return `${safe}-${tag}${['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg'}`
}

function planSync(manifest, remote){
    const files = {}
    const releases = {}
    const downloads = []
    for(const release of remote){
        releases[release.id] = []
        for(const wp of release.wallpapers || []){
            releases[release.id].push(wp.id)
            if(files[wp.id]) continue
            const have = manifest.files[wp.id]
            if(have && have.version === wp.version){
                files[wp.id] = have
            } else {
                const file = fileNameFor(wp.id, wp.version, wp.url)
                files[wp.id] = { version: wp.version, file }
                downloads.push({ id: wp.id, version: wp.version, url: wp.url, file })
            }
        }
    }
    const keep = new Set(Object.values(files).map(f => f.file))
    const retired = manifest.retired.concat(
        Object.values(manifest.files).map(f => f.file).filter(f => !keep.has(f))
    )
    return { downloads, next: { version: 1, files, releases, retired: [...new Set(retired)] } }
}

function settle(next, failedIds, previous){
    const failed = new Set(failedIds)
    const files = {}
    for(const [id, f] of Object.entries(next.files)){
        if(!failed.has(id)) files[id] = f
        else if(previous.files[id]) files[id] = previous.files[id]
    }
    const releases = {}
    for(const [rel, ids] of Object.entries(next.releases)) releases[rel] = ids.filter(id => files[id])
    const keep = new Set(Object.values(files).map(f => f.file))
    return { version: 1, files, releases, retired: next.retired.filter(f => !keep.has(f)) }
}

module.exports = { emptyManifest, parseManifest, fileNameFor, planSync, settle }
