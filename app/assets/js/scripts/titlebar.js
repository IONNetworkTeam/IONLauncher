/**
 * The title bar: Play · Challenges · Stats · News with the lit horizon and the stretching tab
 * light ("Nav 1+"), count badges and hover peeks, the coins, the settings gear and the account.
 */
/* global ConfigManager, Lang, escapeHtml, showTab, setSelectedAccount, prepareSettings, switchView, getCurrentView, VIEWS, settingsNavItemListener, Workspace, loginOptionsCancelEnabled */
/* global loginOptionsViewOnLoginSuccess:writable, loginOptionsViewOnLoginCancel:writable, loginOptionsViewOnCancel:writable */
const TitleBar = (() => {
    const nav = document.getElementById('ionNav')
    const seg = document.getElementById('ionNavLit')
    let current = 'home'
    let peekTimer = null
    let peekOpen = null

    /* The lit segment: its leading edge moves first, the trailing one follows 120ms later. */
    function placeSegment(tab, from){
        const cell = nav.querySelector(`[data-tab="${tab}"]`)
        if(!cell){ seg.style.opacity = '0'; return }
        const navBox = nav.getBoundingClientRect()
        const box = cell.getBoundingClientRect()
        const left = box.left - navBox.left + 14
        const right = navBox.right - box.right + 14
        const goingRight = from == null || nav.querySelector(`[data-tab="${from}"]`)?.getBoundingClientRect().left <= box.left
        seg.style.transitionDelay = goingRight ? '.12s, 0s, 0s, 0s, 0s' : '0s, .12s, 0s, 0s, 0s'
        seg.style.left = `${left}px`
        seg.style.right = `${right}px`
        seg.style.opacity = '1'
    }

    /** Called by shell.js's showTab, and by the settings workspace (tab = null: nothing lit). */
    function setCurrent(tab){
        const from = current
        current = tab
        nav.querySelectorAll('[data-tab]').forEach(el => {
            if(el.dataset.tab === tab) el.setAttribute('aria-current', 'page')
            else el.removeAttribute('aria-current')
        })
        if(tab == null) seg.style.opacity = '0'
        else placeSegment(tab, from)
        closePeek()
    }

    function setBadge(tab, text){
        const b = nav.querySelector(`[data-tab="${tab}"] .mb-badge`)
        if(!b) return
        b.textContent = text ?? ''
        b.hidden = !text
    }

    /* Peeks */

    function setPeek(tab, peek){
        const el = nav.querySelector(`[data-peek="${tab}"]`)
        if(!el) return
        el.dataset.ready = peek ? 'true' : 'false'
        if(!peek) return
        el.querySelector('.peek-img').src = peek.img
        el.querySelector('.peek-kicker').textContent = peek.kicker
        el.querySelector('.peek-title').textContent = peek.title
        el.querySelector('.peek-meta').textContent = peek.meta
    }

    function closePeek(){
        clearTimeout(peekTimer)
        if(peekOpen) peekOpen.classList.remove('is-open')
        peekOpen = null
    }

    nav.querySelectorAll('.mb-cell').forEach(cell => {
        cell.addEventListener('mouseenter', () => {
            clearTimeout(peekTimer)
            const peek = cell.querySelector('.peek')
            if(!peek || peek.dataset.ready !== 'true' || cell.querySelector('[data-tab]').dataset.tab === current) return
            peekTimer = setTimeout(() => {
                if(peekOpen) peekOpen.classList.remove('is-open')
                peek.classList.add('is-open')
                peekOpen = peek
            }, peekOpen ? 0 : 260)
        })
    })
    nav.addEventListener('mouseleave', closePeek)
    nav.addEventListener('click', e => {
        const item = e.target.closest('[data-tab]') || e.target.closest('[data-peek]')
        if(!item) return
        const tab = item.dataset.tab || item.dataset.peek
        const view = getCurrentView()
        if(view !== VIEWS.landing && view !== VIEWS.settings) return
        // A News peek opens the newest post itself.
        const path = tab === 'news' && item.dataset.peek && window.ionNewestArticle
            ? `/blog/${encodeURIComponent(window.ionNewestArticle.slug)}` : undefined
        if(getCurrentView() === VIEWS.settings && typeof Workspace !== 'undefined') Workspace.close().then(() => showTab(tab, path))
        else showTab(tab, path)
    })

    /** Settings, optionally on one tab. The settings workspace (plan 05) takes this over when it exists. */
    async function openSettings(navId){
        if(typeof Workspace !== 'undefined') return Workspace.open(navId)
        await prepareSettings()
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            if(navId) settingsNavItemListener(document.getElementById(navId), false)
        })
    }
    // .onclick, not a listener: an available update (uicore.js) replaces it to open on the Updates tab.
    document.getElementById('settingsMediaButton').onclick = () => openSettings(null)

    /* Account menu */

    const accountButton = document.getElementById('avatarOverlay')
    const menu = document.getElementById('accountMenu')

    function renderAccounts(){
        const sel = ConfigManager.getSelectedAccount()
        const others = Object.values(ConfigManager.getAuthAccounts()).filter(a => a.uuid !== sel?.uuid)
        menu.querySelector('.am-others').innerHTML = others.map(a => `
            <button class="am-item" role="menuitem" data-switch="${escapeHtml(a.uuid)}">
                <img class="head" src="https://mc-heads.net/avatar/${encodeURIComponent(a.uuid)}/22" alt="">
                <span class="am-name">${escapeHtml(a.displayName)}</span><span class="mono am-hint">${escapeHtml(Lang.queryJS('titlebar.switch'))}</span>
            </button>`).join('')
        // No account selected: no "signed in" card, only the add and manage items.
        menu.querySelector('.am-me').hidden = !sel
        menu.querySelector('.am-rule').hidden = !sel
        if(!sel) return
        menu.querySelector('.am-me-head').src = `https://mc-heads.net/avatar/${encodeURIComponent(sel.uuid)}/44`
        menu.querySelector('.am-me-name').textContent = sel.displayName
        menu.querySelector('.am-me-sub').textContent = Lang.queryJS(sel.type === 'microsoft' ? 'titlebar.signedInMicrosoft' : 'titlebar.signedInMojang')
    }

    /** Straight to the login options; cancelling or signing in returns to where the menu was opened. */
    function addAccount(){
        const from = getCurrentView()
        if(from !== VIEWS.landing && from !== VIEWS.settings) return
        switchView(from, VIEWS.loginOptions, 500, 500, () => {
            loginOptionsViewOnLoginSuccess = from
            loginOptionsViewOnLoginCancel = VIEWS.loginOptions
            loginOptionsViewOnCancel = from
            loginOptionsCancelEnabled(true)
        })
    }

    function toggleMenu(open = !menu.classList.contains('is-open')){
        if(open) renderAccounts()
        menu.classList.toggle('is-open', open)
        menu.setAttribute('aria-hidden', String(!open))
        accountButton.setAttribute('aria-expanded', String(open))
    }

    accountButton.addEventListener('click', e => { e.stopPropagation(); toggleMenu() })
    document.addEventListener('click', e => { if(!e.target.closest('#accountMenu')) toggleMenu(false) })
    document.addEventListener('keydown', e => { if(e.key === 'Escape' && menu.classList.contains('is-open')) toggleMenu(false) })
    menu.addEventListener('click', async e => {
        const sw = e.target.closest('[data-switch]')
        if(sw){ setSelectedAccount(sw.dataset.switch); toggleMenu(false); return }
        if(e.target.closest('[data-add]')){
            toggleMenu(false)
            addAccount()
            return
        }
        if(e.target.closest('[data-manage]')){
            toggleMenu(false)
            openSettings('settingsNavAccount')
        }
    })

    window.addEventListener('resize', () => { if(current) placeSegment(current, current) })
    requestAnimationFrame(() => placeSegment('home', null))

    return { setCurrent, setBadge, setPeek, openSettings }
})()
