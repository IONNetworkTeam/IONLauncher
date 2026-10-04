/**
 * Keeps Minecraft's settings (options.txt and OptiFine's option files) the same across every
 * instance of the launcher.
 *
 * One central store (settingssync.json in the data directory) holds the latest value of every
 * known option in a version independent form, plus a content hash per instance file so changes
 * made by the game, or by hand, can be noticed. Before a launch the store is pushed into the
 * instance about to start, after the game exits the instance's files are read back into the
 * store and pushed to every other instance. See docs/superpowers/specs for the design.
 *
 * The SettingsSync class only needs paths and never touches the launcher configuration, so it
 * can be tested on its own. The module level functions bind it to ConfigManager.
 */

const crypto = require('crypto')
const fs     = require('fs-extra')
const path   = require('path')

const mc = require('./mcoptions')
const { PackSync, PACK_KINDS, SHADER_LOADER_PATTERN, resourceFormatForMinecraft, resourceFormatFromVersionJson, modsDirHasShaderLoader } = require('./packsync')

const STORE_VERSION = 1

/**
 * The files that are synchronized. `translate` marks options.txt, whose format depends on the
 * Minecraft version. The others are the same in every version and are copied as they are.
 */
const SYNCED_FILES = [
    { name: 'options.txt', sep: ':', translate: true, seed: true, exclude: [] },
    { name: 'optionsof.txt', sep: ':', translate: false, seed: false, exclude: [] },
    // shaderPack is managed per instance by the launcher's own shader pack selector.
    { name: 'optionsshaders.txt', sep: '=', translate: false, seed: false, exclude: ['shaderPack'] }
]

const EOL = process.platform === 'win32' ? '\r\n' : '\n'

function sha1(text){
    return crypto.createHash('sha1').update(text).digest('hex')
}

function emptyStore(){
    return { version: STORE_VERSION, files: {}, instances: {} }
}

/**
 * Write a file atomically: write to a temporary file, then rename it over the target.
 */
async function writeAtomic(file, text){
    const tmp = `${file}.ionsync.tmp`
    await fs.ensureDir(path.dirname(file))
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, file)
}

class SettingsSync {

    /**
     * @param {Object} opts
     * @param {string} opts.instanceDir Directory holding one sub directory per server id.
     * @param {string} opts.commonDir The common directory, where version jars live.
     * @param {string} opts.storePath Path of the central store file.
     * @param {Object} [opts.logger] Logger with info/warn/error methods.
     * @param {{enabled: boolean, modes: Object<string, string>}} [opts.packs] Whether resource and
     *        shader packs are shared, and the per pack overrides ('everywhere' or 'off').
     */
    constructor({ instanceDir, commonDir, storePath, logger, packs }){
        this.instanceDir = instanceDir
        this.commonDir = commonDir
        this.storePath = storePath
        this.logger = logger || { info(){}, warn(){}, error(){} }
        this.packs = packs || { enabled: true, modes: {} }
        this.packSync = new PackSync({ instanceDir, logger: this.logger })
        this.versionJsonCache = {}
    }

    async loadStore(){
        try {
            const store = await fs.readJson(this.storePath)
            if(store != null && store.version === STORE_VERSION && typeof store.files === 'object' && typeof store.instances === 'object'){
                return store
            }
            this.logger.warn('Settings sync store is unreadable, starting over.')
        } catch(err) {
            if(err.code !== 'ENOENT'){
                this.logger.warn('Settings sync store is unreadable, starting over.', err)
            }
        }
        return emptyStore()
    }

    async saveStore(store){
        await writeAtomic(this.storePath, JSON.stringify(store, null, 4))
    }

    instanceFile(serverId, name){
        return path.join(this.instanceDir, serverId, name)
    }

    /**
     * Read an instance file, if it exists.
     *
     * @returns {Promise<{text: string, hash: string, mtimeMs: number}|null>}
     */
    async readInstanceFile(serverId, name){
        const file = this.instanceFile(serverId, name)
        try {
            const [text, stats] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
            return { text, hash: sha1(text), mtimeMs: stats.mtimeMs }
        } catch(err) {
            if(err.code === 'ENOENT'){
                return null
            }
            throw err
        }
    }

    recordedHash(store, serverId, name){
        const inst = store.instances[serverId]
        return inst != null && inst[name] != null ? inst[name].hash : null
    }

    recordHash(store, serverId, name, hash){
        if(store.instances[serverId] == null){
            store.instances[serverId] = {}
        }
        store.instances[serverId][name] = { hash, syncedAt: Date.now() }
    }

    /**
     * Resolve the data version of a Minecraft release. Known releases come from a table; for
     * anything newer the client jar's version.json is consulted.
     *
     * @returns {Promise<number|null>}
     */
    async resolveDataVersion(mcVersion){
        const known = mc.dataVersionForMinecraft(mcVersion)
        if(known != null){
            return known
        }
        const info = await this.readVersionJson(mcVersion)
        return info != null && Number.isInteger(info.world_version) ? info.world_version : null
    }

    /**
     * Resolve the resource pack format of a Minecraft release, from the client jar when it is
     * there (it is authoritative and covers versions newer than the launcher), else from a table.
     *
     * @returns {Promise<number|null>}
     */
    async resolveResourceFormat(mcVersion){
        const fromJar = resourceFormatFromVersionJson(await this.readVersionJson(mcVersion))
        return fromJar != null ? fromJar : resourceFormatForMinecraft(mcVersion)
    }

    /**
     * Read version.json from the client jar of a Minecraft release (present from 1.14).
     *
     * @returns {Promise<Object|null>}
     */
    async readVersionJson(mcVersion){
        if(mcVersion in this.versionJsonCache){
            return this.versionJsonCache[mcVersion]
        }
        const jar = path.join(this.commonDir, 'versions', mcVersion, `${mcVersion}.jar`)
        let info = null
        try {
            if(await fs.pathExists(jar)){
                const AdmZip = require('adm-zip')
                const entry = new AdmZip(jar).getEntry('version.json')
                if(entry != null){
                    info = JSON.parse(entry.getData().toString('utf8'))
                }
            }
        } catch(err) {
            this.logger.warn(`Could not read version.json of Minecraft ${mcVersion} from its jar.`, err)
        }
        this.versionJsonCache[mcVersion] = info
        return info
    }

    /**
     * Complete the server descriptors with what pack sharing needs to know about each instance.
     */
    async describeForPacks(servers){
        const out = []
        for(const server of servers){
            out.push({
                ...server,
                resourceFormat: await this.resolveResourceFormat(server.minecraftVersion),
                hasShaderLoader: server.hasShaderLoader === true || await modsDirHasShaderLoader(path.join(this.instanceDir, server.id, 'mods'))
            })
        }
        return out
    }

    /**
     * List the packs the launcher knows about, for the settings UI.
     *
     * @returns {Promise<Array<{name: string, kind: string, dir: string, origin: string, linked: string[], formats: Object|null, valid: boolean, mode: string}>>}
     */
    async listSharedPacks(){
        const store = await this.loadStore()
        const packs = []
        for(const { dir, kind } of PACK_KINDS){
            const records = store.packs != null && store.packs[dir] != null ? store.packs[dir] : {}
            for(const [name, rec] of Object.entries(records)){
                packs.push({
                    name,
                    kind,
                    dir,
                    origin: rec.origin,
                    linked: rec.linked || [],
                    formats: rec.meta != null ? rec.meta.formats : null,
                    valid: rec.meta != null ? rec.meta.valid !== false : true,
                    mode: this.packs.modes[name] || 'compatible'
                })
            }
        }
        return packs.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    }

    /**
     * Find the instances whose files were changed since the launcher last read or wrote them.
     * Instances the launcher has never looked at count as changed.
     *
     * @returns {Promise<Array<{server: Object, mtimeMs: number}>>} Sorted oldest change first.
     */
    async findChanged(store, servers){
        const changed = []
        for(const server of servers){
            let newest = null
            for(const spec of SYNCED_FILES){
                const current = await this.readInstanceFile(server.id, spec.name)
                if(current != null && current.hash !== this.recordedHash(store, server.id, spec.name)){
                    newest = newest == null ? current.mtimeMs : Math.max(newest, current.mtimeMs)
                }
            }
            if(newest != null){
                changed.push({ server, mtimeMs: newest })
            }
        }
        return changed.sort((a, b) => a.mtimeMs - b.mtimeMs)
    }

    /**
     * Read an instance's files into the store. Only files that changed since the last sync are
     * read. Values the instance has overwrite the store, values it lacks are kept.
     */
    async ingest(store, server){
        for(const spec of SYNCED_FILES){
            const current = await this.readInstanceFile(server.id, spec.name)
            if(current == null || current.hash === this.recordedHash(store, server.id, spec.name)){
                continue
            }
            const entries = mc.entriesOf(mc.parseOptions(current.text, spec.sep))
            if(Object.keys(entries).length === 0){
                // An empty file (a modpack shipping a blank options.txt, or a truncated write)
                // carries no settings; never let it count as the newest state.
                this.recordHash(store, server.id, spec.name, current.hash)
                continue
            }
            let values
            if(spec.translate){
                values = mc.entriesToCanonical(entries, mc.detectFormat(entries, server.minecraftVersion))
            } else {
                values = {}
                for(const [k, v] of Object.entries(entries)){
                    if(!spec.exclude.includes(k)){
                        values[k] = v
                    }
                }
            }
            const bucket = store.files[spec.name] || { values: {} }
            Object.assign(bucket.values, values)
            bucket.updatedAt = Date.now()
            bucket.source = server.id
            store.files[spec.name] = bucket
            this.recordHash(store, server.id, spec.name, current.hash)
            this.logger.info(`Read ${Object.keys(values).length} settings from ${spec.name} of ${server.id}.`)
        }
    }

    /**
     * Write the store's values into an instance. Files that exist get only the options they
     * already contain updated. A missing options.txt is created from the store, so a new instance
     * starts with the player's settings.
     *
     * @returns {Promise<boolean>} Whether any file was written.
     */
    async push(store, server){
        let wrote = false
        for(const spec of SYNCED_FILES){
            const bucket = store.files[spec.name]
            if(bucket == null || Object.keys(bucket.values).length === 0){
                continue
            }
            let current = await this.readInstanceFile(server.id, spec.name)
            if(current != null && spec.seed && Object.keys(mc.entriesOf(mc.parseOptions(current.text, spec.sep))).length === 0){
                current = null // An empty options.txt is as good as none; seed it.
            }
            if(current != null){
                const result = spec.translate
                    ? mc.applyCanonical(current.text, bucket.values, server.minecraftVersion)
                    : mc.applyPlain(current.text, bucket.values, spec.sep)
                if(result.changed){
                    await writeAtomic(this.instanceFile(server.id, spec.name), result.text)
                    this.recordHash(store, server.id, spec.name, sha1(result.text))
                    this.logger.info(`Updated ${spec.name} of ${server.id}.`)
                    wrote = true
                } else {
                    this.recordHash(store, server.id, spec.name, current.hash)
                }
            } else if(spec.seed){
                const format = {
                    modern: mc.isModernMinecraft(server.minecraftVersion),
                    dataVersion: await this.resolveDataVersion(server.minecraftVersion)
                }
                const text = mc.buildOptionsFile(bucket.values, format, EOL)
                if(text == null){
                    this.logger.warn(`Not creating ${spec.name} for ${server.id}: the data version of Minecraft ${server.minecraftVersion} is unknown.`)
                    continue
                }
                await writeAtomic(this.instanceFile(server.id, spec.name), text)
                this.recordHash(store, server.id, spec.name, sha1(text))
                this.logger.info(`Created ${spec.name} for ${server.id} from the synced settings.`)
                wrote = true
            }
        }
        return wrote
    }

    /**
     * Bring every instance up to date: read changed instances into the store, newest change
     * last so it wins, then write the store into every instance.
     *
     * @param {Array<{id: string, minecraftVersion: string}>} servers The instances taking part.
     * @param {{id: string}} [last] An instance whose changes must win regardless of file times,
     *        typically the one whose game just exited.
     */
    async reconcile(servers, last){
        const store = await this.loadStore()
        const changed = await this.findChanged(store, servers)
        for(const { server } of changed){
            if(last == null || server.id !== last.id){
                await this.ingest(store, server)
            }
        }
        if(last != null && changed.some(c => c.server.id === last.id)){
            await this.ingest(store, last)
        }
        for(const server of servers){
            await this.push(store, server)
        }
        if(this.packs.enabled){
            try {
                await this.packSync.sync(store, await this.describeForPacks(servers), this.packs.modes)
            } catch(err) {
                this.logger.error('Sharing packs failed.', err)
            }
        }
        await this.saveStore(store)
    }
}

// Binding to the launcher configuration.

let queue = Promise.resolve()

/**
 * Run sync work one operation at a time, and never let it fail the caller.
 */
function enqueue(label, work){
    const run = queue.then(work).catch(err => {
        getLogger().error(`Settings sync failed (${label}).`, err)
    })
    queue = run
    return run
}

let logger = null
function getLogger(){
    if(logger == null){
        logger = require('helios-core').LoggerUtil.getLogger('SettingsSync')
    }
    return logger
}

function fromConfig(){
    const ConfigManager = require('./configmanager')
    return new SettingsSync({
        instanceDir: ConfigManager.getInstanceDirectory(),
        commonDir: ConfigManager.getCommonDirectory(),
        storePath: path.join(ConfigManager.getDataDirectory(), 'settingssync.json'),
        logger: getLogger(),
        packs: { enabled: ConfigManager.getSharePacks(), modes: ConfigManager.getPackModes() }
    })
}

/**
 * Whether the distribution ships a shader loader (OptiFine, Iris, Oculus) for a server.
 *
 * @param {Object} heliosServer The HeliosServer.
 */
function distributionHasShaderLoader(heliosServer){
    const walk = (modules) => modules.some(m => SHADER_LOADER_PATTERN.test(`${m.rawModule.id} ${m.rawModule.name}`) || walk(m.subModules || []))
    return walk(heliosServer.modules || [])
}

/**
 * Whether the distribution forbids syncing this server's settings. Set by modpack admins.
 *
 * @param {Object} rawServer The raw server object from the distribution.
 */
function isLockedByDistribution(rawServer){
    return rawServer != null && rawServer.ion != null && rawServer.ion.settingsSync === false
}

/**
 * Whether settings sync is active for a server, considering the global switch, the player's
 * per-server choice and the distribution.
 *
 * @param {Object} rawServer The raw server object from the distribution.
 */
function isEnabledFor(rawServer){
    const ConfigManager = require('./configmanager')
    return ConfigManager.getSettingsSyncEnabled()
        && !ConfigManager.isSettingsSyncExcluded(rawServer.id)
        && !isLockedByDistribution(rawServer)
}

function descriptor(heliosServer){
    return {
        id: heliosServer.rawServer.id,
        minecraftVersion: heliosServer.rawServer.minecraftVersion,
        hasShaderLoader: distributionHasShaderLoader(heliosServer)
    }
}

/**
 * The packs the launcher knows about, for the settings UI. Never throws.
 */
async function listSharedPacks(){
    try {
        return await fromConfig().listSharedPacks()
    } catch(err) {
        getLogger().warn('Could not list shared packs.', err)
        return []
    }
}

/**
 * The instances that take part in sync.
 *
 * @param {Object} distro The HeliosDistribution.
 */
function participatingServers(distro){
    return distro.servers.filter(s => isEnabledFor(s.rawServer)).map(descriptor)
}

/**
 * Bring all instances up to date. Runs in the background; errors are logged.
 *
 * @param {Object} distro The HeliosDistribution.
 */
function reconcileAll(distro){
    return enqueue('reconcile', () => {
        const servers = participatingServers(distro)
        if(servers.length === 0){
            return
        }
        return fromConfig().reconcile(servers)
    })
}

/**
 * Prepare an instance for launch: pull in changes from other instances and create its
 * options.txt from the synced settings if it has none yet.
 *
 * @param {Object} distro The HeliosDistribution.
 * @param {Object} server The HeliosServer about to launch.
 */
function beforeLaunch(distro, server){
    return enqueue('before launch', () => {
        const servers = participatingServers(distro)
        if(servers.length === 0){
            return
        }
        getLogger().info(`Syncing settings before launching ${server.rawServer.id}..`)
        return fromConfig().reconcile(servers)
    })
}

/**
 * Read the settings the player changed during the game back into the store and spread them to
 * the other instances.
 *
 * @param {Object} distro The HeliosDistribution.
 * @param {Object} server The HeliosServer whose game exited.
 */
function afterExit(distro, server){
    return enqueue('after exit', () => {
        if(!isEnabledFor(server.rawServer)){
            return
        }
        getLogger().info(`Syncing settings after ${server.rawServer.id} exited..`)
        return fromConfig().reconcile(participatingServers(distro), descriptor(server))
    })
}

module.exports = {
    SettingsSync,
    SYNCED_FILES,
    isLockedByDistribution,
    isEnabledFor,
    participatingServers,
    listSharedPacks,
    reconcileAll,
    beforeLaunch,
    afterExit
}
