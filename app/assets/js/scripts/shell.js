/**
 * The launcher shell: tabs, web tabs, the Play tab and the website bridge.
 *
 * The Play tab is drawn by the launcher. The Challenges, Stats and News tabs show the configured
 * website (weburl.js) in webviews on a persistent session, so a website login survives restarts.
 * A web tab's webview is created the first time the tab opens and kept afterwards. The Challenges
 * tab is opened in the background shortly after start, since it reports the user's coins.
 *
 * The website talks to the launcher through webbridge.js with two messages, `web:report` and
 * `web:toast`; see docs/website-integration.md.
 */
const Web = require('./assets/js/weburl')

const loggerShell = LoggerUtil.getLogger('Shell')

const WEBBRIDGE_PRELOAD = 'file://' + require('path').join(__dirname, 'assets', 'js', 'webbridge.js')

/** What the website last reported, or null until it has. */
let webState = null
let currentTab = 'home'
const webviews = {}
/** Each web tab's curtain setter: `(state, message)`, state one of none, loading, failed, locked. */
const curtains = {}
/** The user cancelled the website's password prompt; web tabs wait behind a curtain. */
let webLocked = false

function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
}

/* Tabs */

/** Where a web tab opens. Stats opens on the selected player's own page. */
function tabRoot(tab){
    if(tab === 'stats'){
        const name = webState?.minecraftName || ConfigManager.getSelectedAccount()?.displayName
        if(name) return `/stats/${encodeURIComponent(name)}`
    }
    return document.querySelector(`[data-tab-panel="${tab}"]`)?.dataset.webPath ?? '/'
}

/**
 * Show a tab. Selecting the tab that is already showing returns it to its start page.
 *
 * @param {string} tab One of home, challenges, stats or news.
 * @param {string=} path A path on the website to open in that tab.
 */
function showTab(tab, path){
    const again = tab === currentTab
    currentTab = tab
    document.getElementById('ionStage').dataset.tabCurrent = tab
    if(tab === 'home') resumeLobby()
    else pauseLobby()

    document.querySelectorAll('#ionRail [data-tab]').forEach(el => {
        if(el.dataset.tab === tab) el.setAttribute('aria-current', 'page')
        else el.removeAttribute('aria-current')
    })
    // Hidden by visibility rather than display:none, which can stop a webview from painting.
    document.querySelectorAll('[data-tab-panel]').forEach(el => {
        el.toggleAttribute('data-tab-hidden', el.dataset.tabPanel !== tab)
    })

    if(tab === 'news') document.getElementById('newsDot').classList.add('hidden')
    if(tab === 'home') return

    const view = ensureWebview(tab)
    if(path){
        navigateWebview(view, path)
    } else if(again){
        navigateWebview(view, tabRoot(tab))
    }
}

function navigateWebview(view, path){
    const url = new URL(path, Web.url).toString()
    if(view.dataset.ready === 'true') view.loadURL(url)
    else view.setAttribute('src', url)
}

/* Web tabs */

function createCurtain(panel){
    const curtain = document.createElement('div')
    curtain.className = 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-ionGrayer text-sm text-neutral-400'
    curtain.innerHTML = `
        <span class="h-6 w-6 animate-spin rounded-full border-2 border-[#6E8CF0] border-t-transparent" data-curtain="spin"></span>
        <p data-curtain="text">${escapeHtml(Lang.queryJS('shell.loading', { host: Web.host }))}</p>
        <button data-curtain="retry" class="hidden rounded-lg bg-white/10 px-4 py-2 text-white hover:bg-white/20"></button>`
    panel.appendChild(curtain)

    return (state, message) => {
        curtain.classList.toggle('hidden', state === 'none')
        curtain.querySelector('[data-curtain="spin"]').classList.toggle('hidden', state !== 'loading')
        const retry = curtain.querySelector('[data-curtain="retry"]')
        retry.classList.toggle('hidden', state !== 'failed' && state !== 'locked')
        retry.textContent = Lang.queryJS(state === 'locked' ? 'shell.enterPassword' : 'shell.retry')
        if(message) curtain.querySelector('[data-curtain="text"]').textContent = message
    }
}

function lockCurtain(setCurtain){
    setCurtain('locked', Lang.queryJS('shell.locked', { host: Web.host }))
}

function ensureWebview(tab){
    if(webviews[tab]) return webviews[tab]
    const panel = document.querySelector(`[data-tab-panel="${tab}"]`)
    const setCurtain = createCurtain(panel)
    curtains[tab] = setCurtain
    if(webLocked) lockCurtain(setCurtain)

    const view = document.createElement('webview')
    view.setAttribute('partition', Web.partition)
    view.setAttribute('preload', WEBBRIDGE_PRELOAD)
    view.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes')
    view.setAttribute('src', new URL(tabRoot(tab), Web.url).toString())
    panel.appendChild(view)
    webviews[tab] = view

    view.addEventListener('dom-ready', () => { view.dataset.ready = 'true' })
    // A locked tab has loaded the auth gate's 401 page, so it stays behind its curtain.
    view.addEventListener('did-stop-loading', () => { if(!webLocked) setCurtain('none') })
    view.addEventListener('did-fail-load', e => {
        // -3 (ERR_ABORTED) is a load replaced by another navigation, not a failure.
        if(!e.isMainFrame || e.errorCode === -3) return
        loggerShell.warn(`The ${tab} tab could not load ${e.validatedURL}: ${e.errorDescription}`)
        setCurtain('failed', Lang.queryJS('shell.unreachable', { host: Web.host }))
    })
    panel.querySelector('[data-curtain="retry"]').onclick = () => {
        webLocked = false
        ipcRenderer.send('web:authRetry')
        setCurtain('loading', Lang.queryJS('shell.loading', { host: Web.host }))
        view.reload()
    }
    view.addEventListener('ipc-message', e => onBridgeMessage(view, e.channel, e.args[0]))
    return view
}

/* The website bridge */

function onBridgeMessage(view, channel, payload){
    // Only the configured website may talk to the launcher.
    let origin
    try { origin = new URL(view.getURL()).origin } catch { return }
    if(origin !== Web.origin || payload == null || typeof payload !== 'object') return

    if(channel === 'web:report'){
        webState = {
            loggedIn: !!payload.loggedIn,
            username: typeof payload.username === 'string' ? payload.username : null,
            minecraftName: typeof payload.minecraftName === 'string' ? payload.minecraftName : null,
            balance: Number.isFinite(payload.balance) ? payload.balance : null
        }
        renderWebState()
    } else if(channel === 'web:toast' && typeof payload.text === 'string' && typeof payload.href === 'string'){
        showToast(payload.text, payload.href)
    }
}

function renderWebState(){
    const coins = document.getElementById('frameCoins')
    const hasBalance = webState?.balance != null
    coins.classList.toggle('hidden', !hasBalance)
    coins.classList.toggle('flex', hasBalance)
    if(hasBalance) document.getElementById('frameCoinsValue').textContent = webState.balance.toLocaleString()

    const card = document.getElementById('homeCoins')
    const button = (label, path, primary) => `<button data-tab-link="challenges"${path ? ` data-tab-path="${escapeHtml(path)}"` : ''} class="rounded-lg px-3.5 py-1.5 text-sm font-medium text-white transition ${primary ? 'bg-white/10 hover:bg-white/20' : 'text-neutral-300 hover:bg-white/10 hover:text-white'}">${escapeHtml(label)}</button>`
    const text = s => `<p class="text-sm leading-relaxed text-neutral-300">${s}</p>`

    if(webState?.loggedIn && hasBalance){
        const who = webState.minecraftName ? ` &middot; ${escapeHtml(webState.minecraftName)}` : ''
        card.innerHTML = `
            <b class="signal-bg block bg-clip-text font-mono text-[34px] font-bold leading-none tabular-nums text-transparent">${webState.balance.toLocaleString()}</b>
            <span class="mt-1 block text-xs text-neutral-400">${escapeHtml(Lang.queryJS('shell.coins'))}${who}</span>
            <div class="mt-3 flex flex-wrap gap-2">${button(Lang.queryJS('shell.openChallenges'), null, true)}${button(Lang.queryJS('shell.newChallenge'), '/challenges/new', false)}</div>`
    } else if(webState && !webState.loggedIn){
        card.innerHTML = text(escapeHtml(Lang.queryJS('shell.loginPrompt')))
            + `<div class="mt-3">${button(Lang.queryJS('shell.loginButton'), '/auth/login?redirect=/challenges', true)}</div>`
    } else if(webState?.loggedIn){
        card.innerHTML = text(escapeHtml(Lang.queryJS('shell.linkPrompt', { name: webState.username ?? '' })))
            + `<div class="mt-3">${button(Lang.queryJS('shell.linkButton'), '/account', true)}</div>`
    }
}

function showToast(text, href){
    const toast = document.createElement('button')
    toast.className = 'ion-rise pointer-events-auto flex max-w-sm items-center gap-3 rounded-lg border border-white/10 bg-ionGray px-4 py-3 text-left text-sm text-white shadow-[0_18px_40px_-14px_rgba(0,0,0,0.75)] transition hover:border-white/30'
    toast.innerHTML = `<img src="assets/images/ion/coin.svg" alt="" class="h-[18px] w-[18px]"><span>${escapeHtml(text)}</span>`
    toast.onclick = () => {
        toast.remove()
        showTab('challenges', href)
    }
    document.getElementById('ionToasts').appendChild(toast)
    setTimeout(() => toast.remove(), 8000)
}

/* The Play tab: lobby slideshow */

const LOBBY_TIME = 12000
const LOBBY_FADE = 1800
/** Shown for a release that has no pictures of its own on disk yet. */
const BUNDLED_WALLS = [5, 3, 7, 2, 6, 4, 0, 1].map(n => `assets/images/backgrounds/${n}.jpg`)
/** The direction each picture zooms towards, cycled through. */
const DRIFTS = [['-2%', '-1.5%'], ['2%', '-1%'], ['-1.5%', '1.5%'], ['1.5%', '1.5%']]

const { WallCycle } = require('./assets/js/wallcycle')
const { pathToFileURL } = require('url')

/** The local wallpaper cache's listing (wallstore.js), release id → file paths. */
let wallList = { releases: {} }
let wallCycle = new WallCycle(BUNDLED_WALLS, Math.floor(Math.random() * BUNDLED_WALLS.length))
let lobbyStep = 0
let lobbySlot = 0
let lobbyTimer = null

/** A release's own pictures from disk, or the bundled ones while it has none. */
function wallsFor(serverId){
    const local = (wallList.releases[serverId] || []).map(p => pathToFileURL(p).href)
    return local.length ? local : BUNDLED_WALLS
}

/** The cache changed (a sync finished): the selected release's set takes new pictures quietly. */
function refreshWallCycle(){
    const set = wallsFor(ConfigManager.getSelectedServer())
    const fromBundled = wallCycle.current != null && BUNDLED_WALLS.includes(wallCycle.current) && set !== BUNDLED_WALLS
    if(fromBundled){
        // The release just got pictures of its own: switch to them at once rather than finish the stand-ins.
        wallCycle = new WallCycle(set)
        showLobbyShot()
    } else {
        wallCycle.update(set)
    }
}

ipcRenderer.invoke('wallpapers:list').then(l => { wallList = l; refreshWallCycle() }).catch(() => {})
ipcRenderer.on('wallpapers:changed', (_e, l) => { wallList = l; refreshWallCycle() })

/**
 * Fade in the given picture. Two images take turns so a picture is fully loaded before it shows,
 * and the outgoing one keeps zooming while it fades (`is-leaving` in ion.css).
 */
function showLobbyShot(){
    const src = wallCycle.current
    if(!src) return
    const shots = document.querySelectorAll('#lobby .lobby-shot')
    const next = shots[1 - lobbySlot]
    const prev = shots[lobbySlot]
    const [x, y] = DRIFTS[lobbyStep++ % DRIFTS.length]
    const reveal = () => {
        next.classList.remove('is-leaving')
        next.style.setProperty('--drift-x', x)
        next.style.setProperty('--drift-y', y)
        next.classList.add('is-on')
        if(prev.classList.contains('is-on')){
            prev.classList.replace('is-on', 'is-leaving')
            setTimeout(() => prev.classList.remove('is-leaving'), LOBBY_FADE + 100)
        }
        lobbySlot = 1 - lobbySlot
    }
    if(next.getAttribute('src') === src && next.complete) reveal()
    else {
        next.onload = () => { next.onload = null; reveal() }
        next.setAttribute('src', src)
    }
    resumeLobby()
}

function pauseLobby(){
    clearTimeout(lobbyTimer)
}

function resumeLobby(){
    clearTimeout(lobbyTimer)
    if(currentTab !== 'home' || document.hidden) return
    lobbyTimer = setTimeout(() => { wallCycle.advance(); showLobbyShot() }, LOBBY_TIME)
}

document.addEventListener('visibilitychange', () => (document.hidden ? pauseLobby() : resumeLobby()))

/* The Play tab: headline and news */

const heroMeta = { version: null, online: null, players: null }

/** Called by landing.js when the selected server changes. */
function onSelectedServerChanged(serv){
    const raw = serv?.rawServer
    // Another release is another set of pictures.
    wallCycle = new WallCycle(wallsFor(raw?.id))
    showLobbyShot()
    document.getElementById('heroServerName').textContent = raw?.name ?? Lang.queryEJS('app.title')
    const desc = document.getElementById('heroServerDesc')
    desc.textContent = raw?.description ?? ''
    desc.classList.toggle('hidden', !raw?.description)
    heroMeta.version = raw?.minecraftVersion ?? null
    renderHeroMeta()
}

/** Called by landing.js when the server's status has been read. */
function onServerStatus(online, players){
    heroMeta.online = online
    heroMeta.players = players
    renderHeroMeta()
}

function renderHeroMeta(){
    const parts = []
    if(heroMeta.version) parts.push(`<span>${escapeHtml(Lang.queryJS('shell.minecraftVersion', { version: heroMeta.version }))}</span>`)
    if(heroMeta.online === true){
        parts.push(`<span class="flex items-center gap-2"><span class="h-1.5 w-1.5 rounded-full bg-ionGood shadow-[0_0_10px_#25AB90]"></span>${escapeHtml(Lang.queryJS('shell.playersOnline', { players: heroMeta.players }))}</span>`)
    } else if(heroMeta.online === false){
        parts.push(`<span class="flex items-center gap-2"><span class="h-1.5 w-1.5 rounded-full bg-ionCritical"></span>${escapeHtml(Lang.queryJS('shell.serverOffline'))}</span>`)
    }
    document.getElementById('heroServerMeta').innerHTML = parts.join('<span class="text-white/25">/</span>')
}

/** Called by landing.js when the selected Minecraft account changes. */
function onSelectedAccountChanged(authUser){
    document.getElementById('homeGreeting').textContent = authUser?.displayName
        ? Lang.queryJS('shell.greeting', { name: authUser.displayName })
        : Lang.queryJS('shell.greetingAnonymous')
}

async function loadHomeFeed(){
    const list = document.getElementById('homeNews')
    const note = html => { list.innerHTML = `<li class="py-2.5 text-sm text-neutral-400">${html}</li>` }
    try {
        // Fetched by the main process, which handles the website's basic auth (webauth.js).
        const res = await ipcRenderer.invoke('web:fetchJson', '/api/launcher/feed')
        if(res.status === 404){
            note(`${escapeHtml(Lang.queryJS('shell.newsUnsupported', { host: Web.host }))} <button data-tab-link="news" class="underline hover:text-white">${escapeHtml(Lang.queryJS('shell.readBlog'))}</button>`)
            return
        }
        if(!res.ok) throw new Error(`HTTP ${res.status}`)
        const articles = res.data?.articles ?? []
        if(articles.length === 0){
            note(escapeHtml(Lang.queryJS('shell.newsNone')))
            return
        }
        list.innerHTML = articles.map(a => {
            const date = a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''
            const cover = a.cover
                ? `<img src="${escapeHtml(a.cover)}" alt="" class="h-11 w-16 shrink-0 rounded-md object-cover ring-1 ring-white/10" style="max-width:none">`
                : '<span class="h-11 w-16 shrink-0 rounded-md bg-white/[0.06]"></span>'
            return `<li>
                <button data-tab-link="news" data-tab-path="/blog/${encodeURIComponent(a.slug)}" class="group flex w-full items-center gap-3 py-2.5 text-left">
                    ${cover}
                    <span class="min-w-0 flex-1">
                        <span class="block truncate text-sm font-semibold text-white group-hover:underline">${escapeHtml(a.title)}</span>
                        <span class="mt-0.5 block font-mono text-[11px] uppercase tracking-wider text-neutral-500">${escapeHtml(date)}</span>
                    </span>
                </button>
            </li>`
        }).join('')

        // Mark the News tab when the newest article has not been shown before.
        const newest = articles[0].slug
        if(localStorage.getItem('ion.lastSeenArticle') !== newest){
            document.getElementById('newsDot').classList.remove('hidden')
            localStorage.setItem('ion.lastSeenArticle', newest)
        }
    } catch(err) {
        loggerShell.warn('Could not load the launcher feed.', err)
        note(`${escapeHtml(Lang.queryJS('shell.newsFailed'))} <button data-retry-feed class="underline hover:text-white">${escapeHtml(Lang.queryJS('shell.retry'))}</button>`)
    }
}

/* The website's password prompt (see webauth.js) */

let authDialog = null

function showAuthDialog({ host, failed }){
    if(!authDialog){
        const t = key => escapeHtml(Lang.queryJS(`shell.auth.${key}`))
        const input = 'mt-1 block w-full rounded-md border border-white/10 bg-ionGrayer px-3 py-2 text-sm text-white outline-none focus:border-[#6E8CF0]'
        authDialog = document.createElement('div')
        authDialog.className = 'ion-shell fixed inset-0 z-[100] flex items-center justify-center bg-black/70'
        authDialog.innerHTML = `
            <form class="ion-rise w-[380px] rounded-xl border border-white/10 bg-ionGray p-6 text-white shadow-[0_22px_45px_-14px_rgba(0,0,0,0.8)]" autocomplete="off">
                <h2 class="text-lg font-bold" data-auth="title"></h2>
                <p class="mt-1 text-sm text-neutral-400">${t('description')}</p>
                <p data-auth="error" class="mt-3 hidden rounded-md bg-ionCritical/15 px-3 py-2 text-sm text-[#f1a19b]">${t('error')}</p>
                <label class="mt-4 block text-xs font-medium text-neutral-400">${t('username')}<input name="username" required class="${input}"></label>
                <label class="mt-3 block text-xs font-medium text-neutral-400">${t('password')}<input name="password" type="password" class="${input}"></label>
                <label class="mt-4 flex items-center gap-2 text-sm text-neutral-300"><input name="remember" type="checkbox" checked class="accent-[#6E8CF0]"> ${t('remember')}</label>
                <div class="mt-6 flex justify-end gap-2">
                    <button type="button" data-auth="cancel" class="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:bg-white/10">${t('cancel')}</button>
                    <button type="submit" data-auth="submit" class="play-button rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">${t('submit')}</button>
                </div>
            </form>`
        const form = authDialog.querySelector('form')
        form.onsubmit = e => {
            e.preventDefault()
            authDialog.querySelector('[data-auth="submit"]').disabled = true
            ipcRenderer.send('web:authSubmit', {
                username: form.username.value,
                password: form.password.value,
                remember: form.remember.checked
            })
        }
        authDialog.querySelector('[data-auth="cancel"]').onclick = () => ipcRenderer.send('web:authSubmit', null)
        document.body.appendChild(authDialog)
    }
    authDialog.querySelector('[data-auth="title"]').textContent = Lang.queryJS('shell.auth.title', { host })
    authDialog.querySelector('[data-auth="error"]').classList.toggle('hidden', !failed)
    authDialog.querySelector('[data-auth="submit"]').disabled = false
    authDialog.classList.remove('hidden')
    const form = authDialog.querySelector('form')
    if(failed) form.password.select()
    else (form.username.value ? form.password : form.username).focus()
}

function hideAuthDialog(){
    authDialog?.classList.add('hidden')
}

ipcRenderer.on('web:authRequest', (_e, request) => showAuthDialog(request))
ipcRenderer.on('web:authAccepted', () => {
    hideAuthDialog()
    webLocked = false
    loadHomeFeed()
})
ipcRenderer.on('web:authCancelled', () => {
    hideAuthDialog()
    webLocked = true
    Object.values(curtains).forEach(lockCurtain)
})

/* Wiring */

document.getElementById('ionRail').addEventListener('click', e => {
    const item = e.target.closest('[data-tab]')
    if(item) showTab(item.dataset.tab)
})

// Any element can open a tab, optionally at a path: <button data-tab-link="news" data-tab-path="/blog/x">.
document.addEventListener('click', e => {
    if(e.target.closest('[data-retry-feed]')){
        ipcRenderer.send('web:authRetry')
        loadHomeFeed()
        return
    }
    const link = e.target.closest('[data-tab-link]')
    if(!link) return
    e.preventDefault()
    if(getCurrentView() !== VIEWS.landing) return
    showTab(link.dataset.tabLink, link.dataset.tabPath)
})

// Images and links are not meant to be dragged, and on some Linux systems a drag-and-drop the
// compositor never completes leaves the window ignoring the mouse. Dropping files into the
// Settings drop zones is unaffected.
document.addEventListener('dragstart', e => {
    if(e.target instanceof Element && e.target.closest('img, a') && !e.target.closest('[draggable="true"]')){
        e.preventDefault()
    }
}, true)

// Ctrl/Cmd + 1..4 switch tabs.
document.addEventListener('keydown', e => {
    if(!(e.ctrlKey || e.metaKey) || getCurrentView() !== VIEWS.landing) return
    const tab = ['home', 'challenges', 'stats', 'news'][parseInt(e.key, 10) - 1]
    if(tab){
        e.preventDefault()
        showTab(tab)
    }
})

onSelectedAccountChanged(ConfigManager.getSelectedAccount())
showLobbyShot()
loadHomeFeed()
// Open the Challenges tab in the background so the coin balance shows from the start.
setTimeout(() => ensureWebview('challenges'), 1500)
