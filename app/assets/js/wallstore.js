/**
 * The launcher's wallpaper cache: `<userData>/wallpapers/`, one file per picture version plus
 * `manifest.json`. The window only ever shows files that are already here; `sync()` brings the
 * cache up to date with the site in the background.
 *
 * Retired files are deleted when the store opens (the next start), never while the window may
 * still be showing one.
 *
 * @module wallstore
 */
const fs = require('fs/promises')
const path = require('path')
const { emptyManifest, parseManifest, planSync, settle } = require('./wallsync')

function createWallStore({ dir, fetchJson, fetchBytes, onChange, logger }){
    const manifestPath = path.join(dir, 'manifest.json')
    let manifest = emptyManifest()
    let syncing = null

    async function write(file, data){
        const tmp = file + '.tmp'
        await fs.writeFile(tmp, data)
        await fs.rename(tmp, file)
    }

    async function exists(file){
        try { await fs.access(file); return true } catch { return false }
    }

    function list(){
        const releases = {}
        for(const [rel, ids] of Object.entries(manifest.releases)){
            releases[rel] = ids.filter(id => manifest.files[id]).map(id => path.join(dir, manifest.files[id].file))
        }
        return { releases }
    }

    async function open(){
        await fs.mkdir(dir, { recursive: true })
        let text = null
        try { text = await fs.readFile(manifestPath, 'utf8') } catch { /* first start */ }
        manifest = parseManifest(text)
        for(const name of await fs.readdir(dir)){
            if(name.endsWith('.tmp') || manifest.retired.includes(name)){
                await fs.rm(path.join(dir, name), { force: true })
            }
        }
        // A file deleted by hand is simply not listed until the next sync fetches it again.
        for(const [id, f] of Object.entries(manifest.files)){
            if(!await exists(path.join(dir, f.file))) delete manifest.files[id]
        }
        manifest.retired = []
        await write(manifestPath, JSON.stringify(manifest))
    }

    async function run(){
        let body
        try { body = await fetchJson('/api/launcher/releases') } catch(err) { body = null; logger.warn('Wallpaper list unavailable.', err) }
        // No list, or an empty one, is the site having a bad moment: keep everything as it is.
        if(!body || !Array.isArray(body.releases) || body.releases.length === 0) return false

        const previous = manifest
        const { downloads, next } = planSync(manifest, body.releases)
        const failed = []
        for(const d of downloads){
            try {
                const bytes = await fetchBytes(d.url)
                if(!bytes || !bytes.length) throw new Error('empty response')
                await write(path.join(dir, d.file), bytes)
            } catch(err) {
                failed.push(d.id)
                await fs.rm(path.join(dir, d.file + '.tmp'), { force: true })
                logger.warn(`Wallpaper ${d.id} not downloaded.`, err)
            }
        }
        manifest = settle(next, failed, previous)
        await write(manifestPath, JSON.stringify(manifest))
        logger.info(`Wallpapers synced: ${downloads.length - failed.length} new, ${manifest.retired.length} retired.`)
        onChange(list())
        return true
    }

    function sync(){
        // One sync at a time; a second call while one runs waits for it.
        // A failed sync (disk full, a malformed answer, a window gone mid-notify) is logged and
        // leaves the cache as it was; it never becomes an unhandled rejection in the main process.
        if(!syncing){
            syncing = run()
                .catch(err => { logger.error('Wallpaper sync failed.', err); return false })
                .finally(() => { syncing = null })
        }
        return syncing
    }

    return { open, list, sync }
}

module.exports = { createWallStore }
