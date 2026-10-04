/**
 * Keeps the player's own state out of the distribution's reach.
 *
 * A modpack may ship files such as servers.dat or options.txt so a fresh install starts with a
 * server list and sensible settings. Helios validates every required file on every launch and
 * re-downloads whatever differs, which would reset the player's server list and settings each
 * time they launch. Capture these files before validation and put them back afterwards: the
 * distribution's copy is used only while the player has none yet.
 */

const fs   = require('fs-extra')
const path = require('path')

/** Files, relative to the game directory, that belong to the player once they exist. */
const PLAYER_STATE_FILES = [
    'options.txt',
    'optionsof.txt',
    'optionsshaders.txt',
    'servers.dat',
    'servers.dat_old',
    'hotbar.nbt',
    'usercache.json',
    'usernamecache.json',
    'realms_persistence.json',
    'command_history.txt',
    'data/fabricDefaultResourcePacks.dat'
]

class PlayerStateGuard {

    /**
     * @param {string} gameDir The instance directory.
     * @param {Object} [logger]
     * @param {string[]} [files] Override of the protected file list (for tests).
     */
    constructor(gameDir, logger, files = PLAYER_STATE_FILES){
        this.gameDir = gameDir
        this.logger = logger || { info(){}, warn(){} }
        this.files = files
        this.snapshots = new Map()
    }

    /**
     * Remember the current content of every protected file that exists.
     */
    async capture(){
        this.snapshots.clear()
        for(const rel of this.files){
            const file = path.join(this.gameDir, rel)
            try {
                const [data, stats] = await Promise.all([fs.readFile(file), fs.stat(file)])
                this.snapshots.set(rel, { data, mtime: stats.mtime })
            } catch(err) {
                if(err.code !== 'ENOENT' && err.code !== 'EISDIR'){
                    this.logger.warn(`Could not read ${rel} before validation.`, err)
                }
            }
        }
        return this.snapshots.size
    }

    /**
     * Put back every captured file whose content changed since capture.
     *
     * @returns {Promise<string[]>} The files that were restored.
     */
    async restore(){
        const restored = []
        for(const [rel, snap] of this.snapshots){
            const file = path.join(this.gameDir, rel)
            let current = null
            try {
                current = await fs.readFile(file)
            } catch(err) {
                if(err.code !== 'ENOENT'){
                    this.logger.warn(`Could not read ${rel} after validation.`, err)
                    continue
                }
            }
            if(current != null && current.equals(snap.data)){
                continue
            }
            try {
                const tmp = `${file}.ionstate.tmp`
                await fs.ensureDir(path.dirname(file))
                await fs.writeFile(tmp, snap.data)
                await fs.rename(tmp, file)
                await fs.utimes(file, new Date(), snap.mtime).catch(() => {})
                restored.push(rel)
            } catch(err) {
                this.logger.warn(`Could not restore ${rel} after validation.`, err)
            }
        }
        if(restored.length > 0){
            this.logger.info(`Restored player files the modpack would have overwritten: ${restored.join(', ')}.`)
        }
        return restored
    }
}

module.exports = {
    PLAYER_STATE_FILES,
    PlayerStateGuard
}
