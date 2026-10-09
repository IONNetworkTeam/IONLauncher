/**
 * Minecraft installations outside the launcher that settings sync can pair with: the vanilla
 * .minecraft folder of the official launcher, or an instance of Prism Launcher or MultiMC.
 *
 * Options and packs travel in the direction the player picks:
 * - `import` (default): from that folder into the launcher's modpacks, never back,
 * - `both`: both ways,
 * - `export`: from the launcher's modpacks into that folder, never back.
 *
 * No Electron dependencies, so it can be tested on its own.
 */

const crypto = require('crypto')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const mc = require('./mcoptions')

const DIRECTIONS = ['import', 'both', 'export']
const DEFAULT_DIRECTION = 'import'

/**
 * Where the official launcher keeps .minecraft, most likely first.
 *
 * @param {string} [home] The home directory.
 * @returns {string[]}
 */
function vanillaCandidates(home = os.homedir()){
    switch(process.platform){
        case 'win32':
            return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft')]
        case 'darwin':
            return [path.join(home, 'Library', 'Application Support', 'minecraft')]
        default:
            return [
                path.join(home, '.minecraft'),
                path.join(home, '.var', 'app', 'com.mojang.Minecraft', '.minecraft')
            ]
    }
}

/**
 * The vanilla .minecraft folder, if there is one.
 *
 * @returns {Promise<string|null>}
 */
async function findVanillaDir(home = os.homedir()){
    for(const dir of vanillaCandidates(home)){
        if(await fs.pathExists(dir)){
            return dir
        }
    }
    return null
}

/**
 * Data directories of Prism Launcher and MultiMC, with the name of their config file.
 */
function launcherDataCandidates(home = os.homedir()){
    const out = []
    const add = (dir, cfg) => out.push({ dir, cfg })
    switch(process.platform){
        case 'win32': {
            const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
            add(path.join(appData, 'PrismLauncher'), 'prismlauncher.cfg')
            break
        }
        case 'darwin':
            add(path.join(home, 'Library', 'Application Support', 'PrismLauncher'), 'prismlauncher.cfg')
            break
        default:
            add(path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'PrismLauncher'), 'prismlauncher.cfg')
            add(path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher'), 'prismlauncher.cfg')
            add(path.join(home, '.local', 'share', 'multimc'), 'multimc.cfg')
            add(path.join(home, '.local', 'share', 'MultiMC'), 'multimc.cfg')
    }
    return out
}

/**
 * Parse an INI-like file of `key=value` lines (instance.cfg, prismlauncher.cfg).
 */
function parseCfg(text){
    const out = {}
    for(const line of text.split(/\r?\n/)){
        const i = line.indexOf('=')
        if(i > 0 && !line.startsWith('[')){
            out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
        }
    }
    return out
}

async function readCfg(file){
    try {
        return parseCfg(await fs.readFile(file, 'utf8'))
    } catch {
        return null
    }
}

/**
 * Whether a folder is a Prism Launcher / MultiMC instance (not its game folder).
 */
async function isMmcInstance(dir){
    return await fs.pathExists(path.join(dir, 'instance.cfg')) || await fs.pathExists(path.join(dir, 'mmc-pack.json'))
}

/**
 * The game folder inside a Prism / MultiMC instance. Prism uses .minecraft, older MultiMC
 * instances use minecraft.
 */
async function mmcGameDir(instanceDir){
    for(const name of ['.minecraft', 'minecraft']){
        if(await fs.pathExists(path.join(instanceDir, name))){
            return path.join(instanceDir, name)
        }
    }
    return path.join(instanceDir, '.minecraft')
}

/**
 * The Minecraft version of a Prism / MultiMC instance, from its component list.
 *
 * @returns {Promise<string|null>}
 */
async function mmcMinecraftVersion(instanceDir){
    try {
        const pack = await fs.readJson(path.join(instanceDir, 'mmc-pack.json'))
        const component = (pack.components || []).find(c => c.uid === 'net.minecraft')
        return component != null && typeof component.version === 'string' ? component.version : null
    } catch {
        return null
    }
}

/**
 * The Minecraft version that last wrote a game folder's options.txt.
 *
 * @returns {Promise<string|null>}
 */
async function optionsMinecraftVersion(gameDir){
    try {
        const entries = mc.entriesOf(mc.parseOptions(await fs.readFile(path.join(gameDir, 'options.txt'), 'utf8')))
        return mc.minecraftForDataVersion(Number(entries.version))
    } catch {
        return null
    }
}

/**
 * List the Prism Launcher and MultiMC instances on this computer.
 *
 * @returns {Promise<Array<{name: string, path: string, minecraftVersion: string|null, launcher: string}>>}
 */
async function listMmcInstances(home = os.homedir()){
    const found = []
    const seen = new Set()
    for(const { dir, cfg } of launcherDataCandidates(home)){
        if(!await fs.pathExists(dir)){
            continue
        }
        const settings = await readCfg(path.join(dir, cfg))
        let instancesDir = settings != null && settings.InstanceDir ? settings.InstanceDir : 'instances'
        if(!path.isAbsolute(instancesDir)){
            instancesDir = path.join(dir, instancesDir)
        }
        let names
        try {
            names = await fs.readdir(instancesDir)
        } catch {
            continue
        }
        for(const name of names){
            const instanceDir = path.join(instancesDir, name)
            if(name.startsWith('.') || name.startsWith('_') || seen.has(instanceDir) || !await isMmcInstance(instanceDir)){
                continue
            }
            seen.add(instanceDir)
            const info = await readCfg(path.join(instanceDir, 'instance.cfg'))
            found.push({
                name: info != null && info.name ? info.name : name,
                path: instanceDir,
                minecraftVersion: await mmcMinecraftVersion(instanceDir),
                launcher: cfg === 'multimc.cfg' ? 'MultiMC' : 'Prism Launcher'
            })
        }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Work out what a folder the player picked is: a Prism / MultiMC instance (or the game folder
 * inside one) or a plain game folder such as vanilla .minecraft.
 *
 * @param {string} folder
 * @returns {Promise<{kind: 'mmc'|'vanilla', gameDir: string, name: string, minecraftVersion: string|null, exists: boolean}>}
 */
async function resolveFolder(folder){
    const dir = path.resolve(folder)
    let instanceDir = null
    if(await isMmcInstance(dir)){
        instanceDir = dir
    } else if(['.minecraft', 'minecraft'].includes(path.basename(dir)) && await isMmcInstance(path.dirname(dir))){
        instanceDir = path.dirname(dir)
    }
    if(instanceDir != null){
        const gameDir = instanceDir === dir ? await mmcGameDir(instanceDir) : dir
        const info = await readCfg(path.join(instanceDir, 'instance.cfg'))
        return {
            kind: 'mmc',
            gameDir,
            name: info != null && info.name ? info.name : path.basename(instanceDir),
            minecraftVersion: await mmcMinecraftVersion(instanceDir) || await optionsMinecraftVersion(gameDir),
            exists: await fs.pathExists(gameDir)
        }
    }
    return {
        kind: 'vanilla',
        gameDir: dir,
        name: path.basename(dir),
        minecraftVersion: await optionsMinecraftVersion(dir),
        exists: await fs.pathExists(dir)
    }
}

/**
 * Sync id of an outside folder. It follows the folder, so pointing sync at a different folder
 * starts fresh instead of mixing up what was recorded for the old one.
 */
function participantId(folder){
    return `external-${crypto.createHash('sha1').update(path.resolve(folder)).digest('hex').slice(0, 10)}`
}

function normalizeDirection(direction){
    return DIRECTIONS.includes(direction) ? direction : DEFAULT_DIRECTION
}

/**
 * Turn the player's choice into a settings sync participant.
 *
 * @param {{path: string, direction: string}} choice
 * @returns {Promise<{id: string, dir: string, minecraftVersion: string|null, external: true, readFrom: boolean, writeTo: boolean}|null>}
 *          Null when nothing is chosen or the folder is gone.
 */
async function participantFor(choice){
    if(choice == null || !choice.path){
        return null
    }
    const resolved = await resolveFolder(choice.path)
    if(!resolved.exists){
        return null
    }
    const direction = normalizeDirection(choice.direction)
    return {
        id: participantId(choice.path),
        dir: resolved.gameDir,
        minecraftVersion: resolved.minecraftVersion,
        hasShaderLoader: await fs.pathExists(path.join(resolved.gameDir, 'shaderpacks')),
        external: true,
        readFrom: direction !== 'export',
        writeTo: direction !== 'import'
    }
}

module.exports = {
    DIRECTIONS,
    DEFAULT_DIRECTION,
    findVanillaDir,
    listMmcInstances,
    resolveFolder,
    participantId,
    participantFor,
    normalizeDirection
}
