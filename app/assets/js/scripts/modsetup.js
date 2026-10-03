/**
 * Pre-launch handling of ION's distribution extensions (the `ion` field; see docs/distro.md):
 *
 *  - GitHub mods: look up the newest release and rewrite the module so the newest jar is used.
 *  - Manual mods: make sure every enabled one is present, asking the player for the rest.
 *
 * Helios validates and downloads files in a forked child (FullRepair) that re-reads
 * distribution.json from disk, so the resolved distribution is written back to disk here,
 * before the child starts.
 */
const IonMods                 = require('./assets/js/ionmods')
const fsx                     = require('fs-extra')
const { HeliosDistribution }  = require('helios-core/common')

const loggerModSetup = LoggerUtil.getLogger('ModSetup')

/**
 * Resolve GitHub mods and collect manual mods for the selected server.
 *
 * @param {HeliosDistribution} distro The freshly refreshed distribution.
 * @param {string} serverId
 * @returns {Promise<HeliosDistribution|null>} The distribution to launch with (rebuilt when a
 * GitHub release changed a module), or null when the player cancelled the manual download step.
 */
async function prepareIonModules(distro, serverId){
    const raw = distro.rawDistribution
    const rawServer = raw.servers.find(s => s.id === serverId)
    if(rawServer == null) return distro

    let changed = false
    for(const mdl of rawServer.modules){
        if(!IonMods.isGithubModule(mdl)) continue
        const { repo, prerelease } = mdl.ion.github
        try {
            const { release, cache } = await IonMods.fetchLatestRelease(repo, prerelease, ConfigManager.getGithubReleaseCache(repo))
            ConfigManager.setGithubReleaseCache(repo, cache)
            if(IonMods.applyRelease(mdl, release)){
                loggerModSetup.info(`${mdl.name}: using GitHub release ${release.tag_name}.`)
                changed = true
            }
        } catch(err) {
            loggerModSetup.warn(`Could not check GitHub releases for ${repo}; using the release from the distribution index.`, err)
        }
    }

    if(changed){
        // Module paths are computed when a HeliosModule is constructed, so rebuild.
        distro = new HeliosDistribution(raw, ConfigManager.getCommonDirectory(), ConfigManager.getInstanceDirectory())
        DistroAPI.distribution = distro
        syncModConfigurations(distro)
    }

    const serv = distro.getServerById(serverId)
    await removeStaleGithubFiles(serv)

    const unavailable = await missingManualModules(serv)
    const enabledMissing = unavailable.filter(m => m.enabled).map(m => m.module)
    if(enabledMissing.length > 0){
        loggerModSetup.info(`${enabledMissing.length} manual mod(s) missing, asking the player.`)
        const done = await showManualModsDialog(enabledMissing)
        if(!done) return null
    }

    // Whatever is still missing is disabled; leave it out of the copy the child validates,
    // otherwise it would try to download the mod's web page.
    const stillMissing = []
    for(const { module } of unavailable){
        if(!await isModuleFilePresent(module)) stillMissing.push(module.rawModule.id)
    }
    const forChild = IonMods.pruneUnavailableManualModules(raw, serverId, stillMissing)
    const file = DistroAPI.isDevMode() ? 'distribution_dev.json' : 'distribution.json'
    await fsx.writeJson(path.join(ConfigManager.getLauncherDirectory(), file), forChild)

    return distro
}

/** True when the module's file exists and matches its MD5 (or just exists, when the index has none). */
async function isModuleFilePresent(mdl){
    return validateLocalFile(mdl.getPath(), 'md5', mdl.rawModule.artifact.MD5)
}

/**
 * Manual mods whose file is not in place, with whether the player has them enabled
 * (required, or optional and switched on).
 */
async function missingManualModules(serv){
    const cfg = ConfigManager.getModConfiguration(serv.rawServer.id)
    const result = []
    for(const mdl of serv.modules){
        if(!IonMods.isManualModule(mdl.rawModule)) continue
        if(await isModuleFilePresent(mdl)) continue
        const enabled = ProcessBuilder.isModEnabled(cfg?.mods?.[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
        result.push({ module: mdl, enabled })
    }
    return result
}

/** A GitHub jar is valid when it matches the release's SHA-256 digest, or its size when GitHub published none. */
async function verifyGithubFile(mdl){
    const p = mdl.getPath()
    if(!await fsx.pathExists(p)) return false
    const { sha256 } = mdl.rawModule.ion.github
    if(sha256) return validateLocalFile(p, 'sha256', sha256)
    return (await fsx.stat(p)).size === mdl.rawModule.artifact.size
}

/** Delete GitHub jars that don't match their release so FullRepair fetches them again. */
async function removeStaleGithubFiles(serv){
    for(const mdl of serv.modules){
        if(!IonMods.isGithubModule(mdl.rawModule)) continue
        if(await fsx.pathExists(mdl.getPath()) && !await verifyGithubFile(mdl)){
            loggerModSetup.warn(`${mdl.rawModule.name}: local file doesn't match the release, re-downloading.`)
            await fsx.remove(mdl.getPath()).catch(() => {})
        }
    }
}

/**
 * After FullRepair downloaded: GitHub jars that still don't match are corrupt. They are deleted
 * and their names returned so the launch can fail with a clear message.
 */
async function findCorruptedGithubFiles(serv){
    const names = []
    for(const mdl of serv.modules){
        if(!IonMods.isGithubModule(mdl.rawModule)) continue
        if(!await verifyGithubFile(mdl)){
            names.push(mdl.rawModule.name)
            await fsx.remove(mdl.getPath()).catch(() => {})
        }
    }
    return names
}

/**
 * Copy `file` into place if it is exactly the module's file: same MD5, or same size when the
 * index carries no hash. Used for files the player downloaded or picked.
 */
async function acceptFile(mdl, file){
    const { MD5, size } = mdl.rawModule.artifact
    const ok = MD5 ? await validateLocalFile(file, 'md5', MD5) : (await fsx.stat(file)).size === size
    if(!ok) return false
    await fsx.ensureDir(path.dirname(mdl.getPath()))
    await fsx.copy(file, mdl.getPath(), { overwrite: true })
    return true
}

/**
 * Ask the player to download the given modules themselves.
 * @returns {Promise<boolean>} true once every file is in place, false when cancelled.
 */
function showManualModsDialog(modules){
    // Task 16 replaces this stub with the dialog.
    loggerModSetup.error(`Manual download dialog not implemented; missing: ${modules.map(m => m.rawModule.name).join(', ')}`)
    return Promise.resolve(false)
}
