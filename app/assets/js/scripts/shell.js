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

const WEBBRIDGE_PRELOAD = require('url').pathToFileURL(require('path').join(__dirname, 'assets', 'js', 'webbridge.js')).href

/** What the website last reported, or null until it has. */
let webState = null
let currentTab = 'home'
/** A release's live map runs in its own partition: no site login, no bridge (index.js). */
const MAP_PARTITION = 'persist:ionmap'
let currentMapUrl = null
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
    if(tab === 'map') return currentMapUrl
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
    if(tab === 'map' && path){
        currentMapUrl = path
        ipcRenderer.sendSync('web:allowMap', path)
    }
    const again = tab === currentTab
    currentTab = tab
    document.getElementById('stage').classList.toggle('away', tab !== 'home')
    if(typeof TitleBar !== 'undefined') TitleBar.setCurrent(tab)
    // Hidden by visibility rather than display:none, which can stop a webview from painting.
    document.querySelectorAll('[data-tab-panel]').forEach(el => {
        el.toggleAttribute('data-tab-hidden', el.dataset.tabPanel !== tab)
    })
    if(tab === 'news'){
        if(typeof TitleBar !== 'undefined') TitleBar.setBadge('news', '')
        if(window.ionNewestArticle) localStorage.setItem('ion.lastSeenArticle', window.ionNewestArticle.slug)
    }
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
    view.setAttribute('partition', tab === 'map' ? MAP_PARTITION : Web.partition)
    if(tab !== 'map') view.setAttribute('preload', WEBBRIDGE_PRELOAD)
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
        promptForAccount()
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
    if(typeof renderIonAccountTab === 'function') renderIonAccountTab()
}

/**
 * Settle a missing report: with no session cookie the site is signed out, whatever it says later.
 * A site that is signed in reports for itself.
 */
async function checkWebSession(){
    if(webState != null) return
    if(await ipcRenderer.invoke('web:hasSession') || webState != null) return
    webState = { loggedIn: false, username: null, minecraftName: null, balance: null }
    renderWebState()
}

/** Sign out of the website, then reload the open web tabs so they show the signed-out site. */
async function signOutOfWebsite(){
    await ipcRenderer.invoke('web:signOut')
    webState = { loggedIn: false, username: null, minecraftName: null, balance: null }
    renderWebState()
    for(const [tab, view] of Object.entries(webviews)){
        if(tab !== 'map' && view.dataset.ready === 'true') view.reload()
    }
}

/**
 * The onboarding signed in to the website with its own forms (ionaccount.js), which left the
 * session in the web tabs' cookie: reload the open tabs so they pick it up.
 *
 * @param {string|null} username The ION account's name.
 */
function signedInToWebsite(username){
    webState = { ...(webState || { balance: null, minecraftName: null }), loggedIn: true, username }
    renderWebState()
    for(const [tab, view] of Object.entries(webviews)){
        if(tab !== 'map' && view.dataset.ready === 'true') view.reload()
    }
}

/* The ION account prompt */

/** Set once the user dismisses the prompt; it never shows again. */
const ACCOUNT_PROMPT_KEY = 'ion.accountPromptDismissed'
let accountPrompt = null
/** The prompt is offered at most once per start. */
let accountPromptOffered = false

/**
 * Invite a signed-out user to sign in to or create their ION account. Asked on the first report
 * from the website after start, and again on later starts until the user dismisses it.
 */
function promptForAccount(){
    if(webState?.loggedIn){
        accountPrompt?.remove()
        accountPrompt = null
        return
    }
    if(accountPromptOffered || localStorage.getItem(ACCOUNT_PROMPT_KEY)) return
    // Wait for the Play view, and for the website's password prompt to be answered.
    if(getCurrentView() !== VIEWS.landing || (authDialog && !authDialog.classList.contains('hidden'))){
        setTimeout(promptForAccount, 2000)
        return
    }
    accountPromptOffered = true

    const t = key => escapeHtml(Lang.queryJS(`shell.account.${key}`))
    accountPrompt = document.createElement('div')
    accountPrompt.className = 'ion-shell fixed inset-0 z-[90] flex items-center justify-center bg-black/70'
    accountPrompt.innerHTML = `
        <div class="ion-rise w-[400px] rounded-xl border border-white/10 bg-ionGray p-6 text-white shadow-[0_22px_45px_-14px_rgba(0,0,0,0.8)]">
            <h2 class="text-lg font-bold">${t('title')}</h2>
            <p class="mt-2 text-sm text-neutral-400">${t('description')}</p>
            <div class="mt-6 flex justify-end gap-2">
                <button type="button" data-account="dismiss" class="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:bg-white/10">${t('dismiss')}</button>
                <button type="button" data-account="register" class="rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/20">${t('register')}</button>
                <button type="button" data-account="login" class="play-button rounded-lg px-4 py-2 text-sm font-semibold text-white">${t('login')}</button>
            </div>
            <p class="mt-4 text-xs text-neutral-500">${t('later')}</p>
        </div>`
    const close = () => { accountPrompt.remove(); accountPrompt = null }
    accountPrompt.querySelector('[data-account="dismiss"]').onclick = () => {
        localStorage.setItem(ACCOUNT_PROMPT_KEY, new Date().toISOString())
        close()
    }
    accountPrompt.querySelector('[data-account="register"]').onclick = () => { close(); showTab('challenges', '/auth/register') }
    accountPrompt.querySelector('[data-account="login"]').onclick = () => { close(); showTab('challenges', '/auth/login') }
    document.body.appendChild(accountPrompt)
}

function showToast(text, href){
    const toast = document.createElement('button')
    toast.className = 'ion-rise pointer-events-auto flex max-w-sm items-center gap-3 rounded-lg border border-white/10 bg-ionGray px-4 py-3 text-left text-sm text-white shadow-[0_18px_40px_-14px_rgba(0,0,0,0.75)] transition hover:border-white/30'
    toast.innerHTML = `<img src="assets/images/ion/gold_ingot.png" alt="" class="h-[18px] w-[18px]" style="image-rendering:pixelated"><span>${escapeHtml(text)}</span>`
    toast.onclick = () => {
        toast.remove()
        showTab('challenges', href)
    }
    document.getElementById('ionToasts').appendChild(toast)
    setTimeout(() => toast.remove(), 8000)
}

/* The Play view (slices.js) and the feed */

/** Called by landing.js when the selected server changes. */
function onSelectedServerChanged(){
    if(typeof Slices !== 'undefined') Slices.update()
    if(typeof Workspace !== 'undefined') Workspace.refreshGround()
}

/** The newest blog posts: the game servers' announcement, the News badge and the News peek. */
async function loadFeed(){
    try {
        // Fetched by the main process, which handles the website's basic auth (webauth.js).
        const res = await ipcRenderer.invoke('web:fetchJson', '/api/launcher/feed')
        if(!res.ok) throw new Error(`HTTP ${res.status}`)
        const articles = res.data?.articles ?? []
        window.ionNewestArticle = articles[0] ?? null
        if(typeof Slices !== 'undefined') Slices.refill()
        if(articles.length === 0) return
        const seen = localStorage.getItem('ion.lastSeenArticle')
        const unread = seen ? articles.findIndex(a => a.slug === seen) : articles.length
        const n = unread < 0 ? articles.length : unread
        TitleBar.setBadge('news', n > 0 ? Lang.queryJS('shell.newCount', { n }) : '')
        const a = articles[0]
        TitleBar.setPeek('news', {
            img: a.cover || Slices.wallsFor(Slices.releases()[0]?.id)[0],
            kicker: Lang.queryJS('shell.newsKicker', { date: a.publishedAt ? new Date(a.publishedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase() : '' }),
            title: a.title,
            meta: n > 0 ? Lang.queryJS('shell.unreadCount', { n }) : ''
        })
    } catch(err) {
        loggerShell.warn('Could not load the launcher feed.', err)
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
    loadFeed()
})
ipcRenderer.on('web:authCancelled', () => {
    hideAuthDialog()
    webLocked = true
    Object.values(curtains).forEach(lockCurtain)
})

/* Wiring */

// Any element can open a tab, optionally at a path: <button data-tab-link="news" data-tab-path="/blog/x">.
document.addEventListener('click', e => {
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

loadFeed()
// Open the Challenges tab in the background so the coin balance shows from the start.
setTimeout(() => ensureWebview('challenges'), 1500)
