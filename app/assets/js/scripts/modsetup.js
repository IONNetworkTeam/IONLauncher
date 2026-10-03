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
 * Ask the player to download the given modules themselves, Prism-style: one "Open page" button
 * per mod, the Downloads folder is watched for the expected file, files can also be chosen or
 * dropped. Resolves true once every file is in place, false when the player cancels.
 */
function showManualModsDialog(modules){
    const { webUtils } = require('electron')
    const downloadsDir = remote.app.getPath('downloads')
    const t = (key, vars) => escapeHtml(Lang.queryJS(`landing.manualMods.${key}`, vars))

    return new Promise(resolve => {
        const pending = new Map(modules.map(m => [m.rawModule.id, m]))
        const rows = new Map()

        const dialog = document.createElement('div')
        dialog.className = 'ion-shell fixed inset-0 z-[100] flex items-center justify-center bg-black/70'
        dialog.innerHTML = `
            <div class="ion-rise w-[620px] max-w-[calc(100vw-40px)] rounded-xl border border-white/10 bg-ionGray p-6 text-white shadow-[0_22px_45px_-14px_rgba(0,0,0,0.8)]">
                <h2 class="text-lg font-bold">${t('title')}</h2>
                <p class="mt-1 text-sm text-neutral-400">${t('description', { folder: downloadsDir })}</p>
                <ul data-manual="list" class="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1"></ul>
                <p data-manual="hint" class="mt-3 text-xs text-neutral-500">${t('dropHint')}</p>
                <div class="mt-5 flex items-center justify-between gap-2">
                    <button type="button" data-manual="openAll" class="rounded-lg bg-white/10 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-white/20">${t('openAll')}</button>
                    <div class="flex gap-2">
                        <button type="button" data-manual="cancel" class="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:bg-white/10">${t('cancel')}</button>
                        <button type="button" data-manual="continue" disabled class="play-button rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">${t('continue')}</button>
                    </div>
                </div>
            </div>`

        const list = dialog.querySelector('[data-manual="list"]')
        for(const mdl of modules){
            const raw = mdl.rawModule
            const li = document.createElement('li')
            li.className = 'flex items-center gap-3 rounded-lg border border-white/10 bg-ionGrayer px-3 py-2'
            li.innerHTML = `
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">${escapeHtml(raw.name)} <span class="font-mono text-[11px] text-neutral-500">${escapeHtml(mdl.getMavenComponents()?.version ?? '')}</span></p>
                    <p class="truncate font-mono text-[11px] text-neutral-500" title="${escapeHtml(raw.ion.manual.fileName)}">${escapeHtml(raw.ion.manual.fileName)}</p>
                </div>
                <span data-status class="shrink-0 rounded-full bg-ionWarn/20 px-2 py-0.5 text-[11px] font-medium text-[#f0c070]">${t('waiting')}</span>
                <button type="button" data-open class="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20">${t('openPage')}</button>
                <button type="button" data-choose class="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20">${t('chooseFile')}</button>`
            li.querySelector('[data-open]').onclick = () => shell.openExternal(raw.ion.manual.pageUrl)
            li.querySelector('[data-choose]').onclick = async () => {
                const { canceled, filePaths } = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
                    properties: ['openFile'],
                    filters: [{ name: 'Minecraft mod', extensions: ['jar'] }]
                })
                if(canceled || filePaths.length === 0) return
                if(!await tryAccept(mdl, filePaths[0])) flash(li, t('wrongFile'))
            }
            rows.set(raw.id, li)
            list.appendChild(li)
        }

        function flash(li, text){
            const status = li.querySelector('[data-status]')
            const original = status.textContent
            status.textContent = text
            status.classList.add('bg-ionCritical/20', 'text-[#f1a19b]')
            setTimeout(() => {
                if(status.textContent === text){
                    status.textContent = original
                    status.classList.remove('bg-ionCritical/20', 'text-[#f1a19b]')
                }
            }, 2500)
        }

        async function tryAccept(mdl, file){
            try {
                if(!await acceptFile(mdl, file)) return false
            } catch(err) {
                loggerModSetup.warn(`Could not accept ${file}`, err)
                return false
            }
            markDone(mdl)
            return true
        }

        function markDone(mdl){
            const id = mdl.rawModule.id
            if(!pending.delete(id)) return
            const li = rows.get(id)
            const status = li.querySelector('[data-status]')
            status.textContent = Lang.queryJS('landing.manualMods.found')
            status.className = 'shrink-0 rounded-full bg-ionGood/20 px-2 py-0.5 text-[11px] font-medium text-[#7fd9c4]'
            for(const b of li.querySelectorAll('button')) b.disabled = true
            li.classList.add('opacity-70')
            if(pending.size === 0) dialog.querySelector('[data-manual="continue"]').disabled = false
        }

        // Pick up files the player saved to Downloads (polling covers editors that don't emit watch events).
        async function scanDownloads(){
            for(const mdl of [...pending.values()]){
                const candidate = path.join(downloadsDir, mdl.rawModule.ion.manual.fileName)
                if(await fsx.pathExists(candidate)) await tryAccept(mdl, candidate)
            }
        }
        const poll = setInterval(() => { scanDownloads().catch(() => {}) }, 1500)
        let watcher = null
        try {
            watcher = require('fs').watch(downloadsDir, () => { scanDownloads().catch(() => {}) })
        } catch(err) {
            loggerModSetup.warn('Cannot watch the Downloads folder; polling only.', err)
        }

        dialog.ondragover = e => { e.preventDefault() }
        dialog.ondrop = async e => {
            e.preventDefault()
            for(const file of e.dataTransfer.files){
                const filePath = webUtils.getPathForFile(file)
                let accepted = false
                for(const mdl of [...pending.values()]){
                    if(await tryAccept(mdl, filePath)){ accepted = true; break }
                }
                if(!accepted) dialog.querySelector('[data-manual="hint"]').textContent = Lang.queryJS('landing.manualMods.droppedWrongFile', { file: file.name })
            }
        }

        function close(result){
            clearInterval(poll)
            watcher?.close()
            dialog.remove()
            resolve(result)
        }
        dialog.querySelector('[data-manual="openAll"]').onclick = () => {
            for(const mdl of pending.values()) shell.openExternal(mdl.rawModule.ion.manual.pageUrl)
        }
        dialog.querySelector('[data-manual="cancel"]').onclick = () => close(false)
        dialog.querySelector('[data-manual="continue"]').onclick = () => close(true)

        document.body.appendChild(dialog)
        scanDownloads().catch(() => {})
    })
}
