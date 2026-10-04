/**
 * Friends v2 in the launcher window: the strip beside the Play view (heads by presence, the card
 * a head slides out, the add card, the invite toast, the requests badge), friend heads on the
 * release slices and the per-mode badges, and the window (friends.ejs) that opens from the strip.
 *
 * The data comes from the main process over the `friends:*` IPC surface (friends/index.js) and is
 * kept in one model (friendsmodel.js). Mounted behind the `settings.launcher.friends` flag
 * (Settings › Launcher, or ION_FRIENDS=1), so it can be exercised in the current layout; the
 * title bar and shelf placement follow when Slices lands. Nothing here is in the Play button's way.
 *
 * Loaded after the views' scripts: landing.js (GameState, updateSelectedAccount), shell.js
 * (showTab, escapeHtml, onSelectedServerChanged), slices.js (Slices), panels.js (Panels).
 */
/* global ConfigManager, ipcRenderer, Lang, LoggerUtil, GameState, Slices, Panels, showTab, escapeHtml, getCurrentView, VIEWS, validateSelectedAccount */
const { createFriendsModel, activityLine, ago, toastMs, followPlace, followKey, modeLabel, MODES: FRIEND_MODES, NAME: FRIEND_NAME } = require('./assets/js/friendsmodel')
const FriendsWeb = require('./assets/js/weburl')

const Friends = (() => {
    const log = LoggerUtil.getLogger('Friends')
    const model = createFriendsModel()
    const t = (k, p) => Lang.queryJS(`friends.${k}`, p)
    const h = (k, p) => escapeHtml(t(k, p))
    const TEXTS = {
        inTheLauncher: t('inTheLauncher'), online: t('online'), inTheHub: t('inTheHub'), inAMatch: t('inAMatch'),
        lobby: t('lobby'), podium: t('podium'), playing: t('playing'), offline: t('offline'), lastOnline: when => t('lastOnline', { when })
    }
    const NOTE_MS = 2600
    const INVITE_MS = 20000
    const LEAVE_MS = 220
    const FOLLOW_MS = 30000
    const KICKED_MS = 6000
    const NET_RING = '#A9B9FA'
    const NET_JOIN = 'linear-gradient(100deg, #1E9CCB 0%, #4F6EE0 52%, #7150CF 100%)'
    const ICONS = {
        friends: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.8 2.5 3.2 5.2"/></svg>',
        hide: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
        offline: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M10.7 5.1A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 3.7-2.2M15.2 10.4A10 10 0 0 1 19 12.5M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg>',
        window: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>'
    }

    const landing = document.getElementById('landingContainer')
    // The Play view clips its children (overflow: hidden) and is 64px narrower while friends are
    // shown, so the strip and its transient cards hang in #main, beside it.
    const main = document.getElementById('main')
    const stage = document.getElementById('stage')
    let mounted = false
    let status = { session: false, live: false, reason: null }
    let windowOpen = false
    let stripHidden = localStorage.getItem('ion.friends.stripHidden') === '1'
    let hot = null              // uuid whose card is out
    let adding = false
    let leaveTimer = null
    const notes = new Map()     // uuid → { text, good, until }
    const invited = new Set()
    const dismissed = new Set() // toasts answered, put off or timed out, by pickToast key (round:<uuid>, party:<id>, kicked:<id>, follow:<id>:<gamemode>:<release>)
    const toastNotes = new Map() // pickToast key → why the last answer did not work
    let toastKey = null
    let toastItem = null
    let inviteTimer = null
    let lastAccountKey = null
    let accountRefreshAt = 0
    let releasesSent = ''
    let strip, card, addCard, inv, showBtn

    /* Releases */

    const releases = () => (typeof Slices !== 'undefined' ? Slices.releases() : [])
    const netRelease = () => releases().find(r => r.net) ?? null
    const releaseName = id => releases().find(r => r.id === id)?.name ?? null
    /** The release a friend's activity belongs to: the network release for the network, the pack by its id. */
    function releaseFor(friend){
        const a = friend?.presence.activity
        if(!a) return null
        return a.kind === 'network' ? netRelease() : (releases().find(r => r.id === a.release) ?? null)
    }
    const ringOf = r => r?.accent?.text ?? NET_RING
    const joinBgOf = r => r ? r.playBg : NET_JOIN
    const modeIcon = id => Object.hasOwn(FRIEND_MODES, id) ? `assets/images/modes/${id}.svg` : null
    const headUrl = url => {
        if(!url) return ''
        try { return new URL(url, FriendsWeb.url).href } catch { return '' }
    }
    const headStyle = url => headUrl(url) ? `background-image:url('${escapeHtml(headUrl(url))}')` : ''
    const line = f => activityLine(f.presence, releaseName, TEXTS)
    const inGame = () => GameState.state === 'running' || GameState.state === 'starting' || model.me?.presence.status === 'playing'
    const kickerOf = f => f.presence.status === 'playing' ? t('kickerPlaying') : f.presence.status === 'launcher' ? t('kickerLauncher') : f.presence.status === 'online' ? t('kickerOnline') : t('kickerOffline')

    /* Mount */

    const enabled = () => ConfigManager.getFriendsEnabled() || process.env.ION_FRIENDS === '1'

    function mount(){
        if(mounted) return
        mounted = true
        document.body.classList.add('has-friends')
        strip = document.createElement('aside')
        strip.className = 'fstrip'
        strip.setAttribute('aria-label', t('label'))
        strip.innerHTML = `
            <button class="fs-top" data-act="add" aria-expanded="false" title="${h('addFriend')}">${ICONS.friends}<span class="fs-count"><span class="live"></span><span class="fs-n">0</span></span></button>
            <button class="fs-req" data-act="window" title="${h('requests')}" hidden></button>
            <div class="fs-list"></div>
            <div class="fs-foot">
                <button class="fs-btn" data-act="hide" title="${h('hide')}" aria-label="${h('hide')}">${ICONS.hide}</button>
                <button class="fs-btn" data-act="window" title="${h('openWindow')}" aria-label="${h('openWindow')}">${ICONS.window}</button>
            </div>`
        card = document.createElement('div')
        card.className = 'fcard'
        card.setAttribute('role', 'dialog')
        addCard = document.createElement('div')
        addCard.className = 'fcard fcard-add'
        addCard.setAttribute('role', 'dialog')
        addCard.setAttribute('aria-label', t('addFriend'))
        addCard.style.top = '46px'
        addCard.innerHTML = `
            <label class="fr-kicker" for="frname">${h('addByName')}</label>
            <form class="fr-add-row">
                <span class="fr-preview"></span>
                <input id="frname" class="fr-field" type="text" maxlength="16" autocomplete="off" spellcheck="false" placeholder="${h('namePlaceholder')}">
                <button type="submit" class="fr-join" style="--join-bg:var(--acc)" disabled>${h('send')}</button>
            </form>
            <p class="fcard-note" hidden></p>`
        inv = document.createElement('div')
        inv.className = 'inv'
        inv.setAttribute('role', 'status')
        inv.setAttribute('aria-live', 'polite')
        main.append(strip, card, addCard, inv)

        showBtn = document.createElement('button')
        showBtn.className = 'fr-show app-no-drag is-gone'
        showBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.8 2.5 3.2 5.2"/></svg><span class="fr-show-n">0</span>'
        showBtn.addEventListener('click', () => { setStripHidden(false) })
        document.getElementById('image_seal_container').before(showBtn)

        bind()
        render()
        sendAccount()
        reportPresence()
        ipcRenderer.invoke('friends:party').catch(() => {})
        requestAnimationFrame(() => { if(typeof Slices !== 'undefined') Slices.update() })
    }

    function unmount(){
        if(!mounted) return
        mounted = false
        document.body.classList.remove('has-friends', 'friends-folded')
        for(const el of [strip, card, addCard, inv, showBtn]) el?.remove()
        document.querySelectorAll('.tag-friends, .mode-friends, .slice-friendline').forEach(el => el.remove())
        lastAccountKey = null
        ipcRenderer.invoke('friends:account', null).catch(() => {})
        requestAnimationFrame(() => { if(typeof Slices !== 'undefined') Slices.update() })
    }

    /* Account and presence */

    function accountPayload(){
        const a = ConfigManager.getSelectedAccount()
        return a?.uuid && a.accessToken ? { uuid: a.uuid, displayName: a.displayName, accessToken: a.accessToken } : null
    }

    async function sendAccount(){
        if(!mounted) return
        const a = accountPayload()
        const key = a ? `${a.uuid}:${a.accessToken}` : 'none'
        if(key === lastAccountKey) return
        lastAccountKey = key
        try {
            status = { ...status, ...(await ipcRenderer.invoke('friends:account', a)) }
        } catch(err) {
            log.warn('Could not hand the account to the friends system.', err)
        }
        render()
    }

    /** The Minecraft token was refused by Mojang: refresh the account once (uibinder.js), then try again. */
    async function refreshAccount(){
        if(Date.now() - accountRefreshAt < 10 * 60000 || typeof validateSelectedAccount !== 'function') return
        accountRefreshAt = Date.now()
        try { await validateSelectedAccount() } catch(err) { log.warn('Account refresh failed.', err) }
        sendAccount()
    }

    function reportPresence(){
        if(!mounted) return
        const s = GameState.state
        const playing = s === 'starting' || s === 'running'
        ipcRenderer.invoke('friends:presence', { state: playing ? 'playing' : 'idle', release: (playing ? GameState.releaseId : ConfigManager.getSelectedServer()) || null }).catch(() => {})
    }

    function pushReleases(){
        if(!mounted) return
        const list = releases().map(r => ({ id: r.id, name: r.name, net: r.net, accent: r.accent, playBg: r.playBg }))
        const key = JSON.stringify(list)
        if(key === releasesSent) return
        releasesSent = key
        ipcRenderer.invoke('friends:releases', list).catch(() => {})
    }

    /* Actions */

    function note(uuid, text, good = false){
        notes.set(uuid, { text, good, until: Date.now() + NOTE_MS })
        render()
        setTimeout(() => { if(notes.get(uuid)?.until <= Date.now()) { notes.delete(uuid); render() } }, NOTE_MS + 50)
    }
    const failText = res => res?.error || (res?.code === 'UNAVAILABLE' || res?.code === 'GATE' ? t('unavailable') : res?.code === 'NO_SESSION' ? t('noSession') : t('noteFailed'))

    /** What a Join or a party Follow answered: moved, a release to start here, or why not. */
    function joined(res, fail){
        if(!res?.ok) return fail(failText(res))
        const a = res.data ?? {}
        if(a.outcome === 'moved') return true
        if(a.outcome === 'refused') return fail(a.error || a.reason || t('noteFailed'))
        if(a.outcome === 'launch' || a.outcome === 'pack') return launch(a.release, fail)
        fail(t('noteFailed'))
    }

    /**
     * Join a friend: `moved` when I was in game, `launch` or `pack` to start a release here,
     * `refused` with the reason for the row's note. While a different release runs nothing is
     * asked; the note says to close the game first.
     */
    async function join(uuid){
        const f = model.friend(uuid)
        if(!f) return
        const target = releaseFor(f)
        const busy = !GameState.canSwitch()
        if(busy && (!target || GameState.releaseId !== target.id)) return note(uuid, t('noteClosePlaying'))
        joined(await ipcRenderer.invoke('friends:join', uuid, busy), text => note(uuid, text))
    }

    /** Follow the party leader: the same outcomes as a Join, routed to the leader by the website. */
    async function follow(item, fromWindow = false){
        const key = followKey(item)
        const fail = text => {
            if(fromWindow) ipcRenderer.invoke('friends:windowNote', 'party', text).catch(() => {})
            else toastFail(key, text)
        }
        if(!GameState.canSwitch()) return fail(t('noteClosePlaying'))
        if(await joined(await ipcRenderer.invoke('friends:partyFollow'), fail) && model.partyFollow === item) model.clearFollow()
    }

    /** Open a release and press Play, as the user would. */
    async function launch(releaseId, fail){
        if(!releaseId || !Slices.byId(releaseId)) return fail(t('noteUnknownRelease'))
        if(!GameState.canSwitch()) return fail(t('noteClosePlaying'))
        hot = null
        hideToast()
        render()
        if(getCurrentView() !== VIEWS.landing) return true
        await Slices.libraryPick(releaseId)
        setTimeout(() => {
            if(GameState.canSwitch() && ConfigManager.getSelectedServer() === releaseId) document.getElementById('launch_button').click()
        }, 900)
        return true
    }

    function challenge(uuid){
        if(getCurrentView() !== VIEWS.landing) return
        showTab('challenges', `/challenges?with=${encodeURIComponent(uuid)}`)
    }

    /** Invite: the round invite while I am in a round, a party invite otherwise (model.inviteAction). */
    async function invite(uuid){
        const kind = model.inviteAction(uuid, inGame())
        if(kind === 'round'){
            const res = await ipcRenderer.invoke('friends:invite', uuid)
            if(res.ok){ invited.add(uuid); render() } else note(uuid, failText(res))
        } else if(kind === 'party'){
            const res = await ipcRenderer.invoke('friends:partyInvite', uuid)
            if(!res.ok) note(uuid, failText(res))
        }
    }

    async function sendRequest(name){
        const noteEl = addCard.querySelector('.fcard-note')
        const res = await ipcRenderer.invoke('friends:request', name)
        noteEl.hidden = false
        noteEl.classList.toggle('is-good', !!res.ok)
        noteEl.textContent = res.ok ? t('requestSent', { name: res.data?.name ?? name }) : failText(res)
        if(res.ok) addCard.querySelector('input').value = ''
        updateAddCard()
    }

    function setStripHidden(v){
        stripHidden = v
        localStorage.setItem('ion.friends.stripHidden', v ? '1' : '0')
        hot = null; adding = false
        render()
    }

    async function openWindow(){
        hot = null; adding = false
        render()
        await ipcRenderer.invoke('friends:openWindow').catch(err => log.warn('Could not open the friends window.', err))
    }

    /* Rendering */

    function render(){
        if(!mounted) return
        renderStrip()
        renderCard()
        renderToast()
        decorateSlices()
        pushReleases()
    }

    /** The slices fold into a band in the settings workspace; the strip goes with them. */
    const away = () => stage.classList.contains('is-mini') || landing.clientWidth === 0

    function renderStrip(){
        const online = model.onlineCount()
        const unavailable = status.reason === 'unavailable' || status.reason === 'offline' || status.reason === 'gate'
        strip.classList.toggle('is-hidden', stripHidden || windowOpen || away())
        document.body.classList.toggle('friends-folded', stripHidden || windowOpen)
        strip.classList.toggle('is-stale', model.stale || unavailable)
        strip.setAttribute('aria-hidden', String(stripHidden || windowOpen || away()))
        showBtn.classList.toggle('is-gone', !stripHidden || windowOpen || away())
        showBtn.title = t('show', { n: online })
        showBtn.setAttribute('aria-label', t('show', { n: online }))
        showBtn.querySelector('.fr-show-n').textContent = String(online)
        const top = strip.querySelector('.fs-top')
        top.setAttribute('aria-label', t('stripLabel', { n: online }))
        top.setAttribute('aria-expanded', String(adding))
        strip.querySelector('.fs-n').textContent = String(online)
        strip.querySelector('.fs-count').classList.toggle('is-zero', online === 0)
        const req = model.incomingRequests().length
        const reqEl = strip.querySelector('.fs-req')
        reqEl.hidden = req === 0
        reqEl.textContent = String(req)

        // Heads: playing with the release's ring and the mode, then the launcher, a rule, then offline.
        const list = strip.querySelector('.fs-list')
        const all = status.session || model.loaded ? model.friends() : []
        let ruled = false
        const html = all.map(f => {
            const st = f.presence.status
            const r = releaseFor(f)
            const a = f.presence.activity
            const icon = st === 'playing' && a?.kind === 'network' && a.gamemode && a.gamemode !== 'lobby' ? modeIcon(a.gamemode) : null
            const ring = st === 'playing' ? `box-shadow:0 0 0 2px #0c0d12,0 0 0 3px ${escapeHtml(ringOf(r))}` : ''
            const rule = st === 'offline' && !ruled ? (ruled = true, '<span class="fs-rule"></span>') : ''
            return `${rule}<button class="fs-head${st === 'offline' ? ' is-off' : ''}${hot === f.uuid ? ' is-hot' : ''}" data-head="${escapeHtml(f.uuid)}" aria-label="${escapeHtml(f.name)} · ${escapeHtml(line(f))}" style="${headStyle(f.headUrl)};${ring}">${icon ? `<span class="fs-badge"><img src="${icon}" alt=""></span>` : ''}${st === 'launcher' || st === 'online' ? '<span class="fs-dot"></span>' : ''}</button>`
        }).join('')
        const shown = all.length ? html : emptyState(unavailable)
        strip.classList.toggle('is-empty', !all.length)
        if(list.dataset.html !== shown){ list.innerHTML = shown; list.dataset.html = shown }
        updateAddCard()
    }

    /**
     * What the strip says when there are no heads to show, in the slices' own vertical type:
     * loading (three breathing slots), signed out, the service down, or no friends yet, where the
     * whole column invites the first request and requests already sent wait as dashed heads.
     */
    function emptyState(unavailable){
        const vertical = (text, cls = '') => `<span class="fs-empty-label${cls}">${escapeHtml(text)}</span>`
        if(!model.loaded && !status.reason) return '<span class="fs-ghost"></span><span class="fs-ghost"></span><span class="fs-ghost"></span>'
        if(unavailable) return `<span class="fs-empty-icon" aria-hidden="true">${ICONS.offline}</span>${vertical(t('emptyUnavailable'), ' is-muted')}`
        if(!status.session) return `<span class="fs-empty-icon" aria-hidden="true">${ICONS.friends}</span>${vertical(t('emptySignedOut'), ' is-muted')}`
        const pending = model.outgoingRequests().map(r => `<span class="fs-head is-pending" title="${escapeHtml(t('pendingTo', { name: r.name }))}" style="${headStyle(r.headUrl)}"></span>`).join('')
        return `<button class="fs-empty-add" data-act="add" aria-label="${h('addFriend')}"><span class="fs-plus" aria-hidden="true">+</span>${vertical(t(pending ? 'emptyWaiting' : 'emptyAdd'))}</button>${pending}`
    }

    function updateAddCard(){
        const input = addCard.querySelector('input')
        const valid = FRIEND_NAME.test(input.value.trim())
        addCard.querySelector('.fr-preview').classList.toggle('is-valid', valid)
        addCard.querySelector('button[type="submit"]').disabled = !valid || !status.session
        addCard.classList.toggle('is-open', adding && !stripHidden && !windowOpen && !away())
        if(adding && !addCard.dataset.focused){ addCard.dataset.focused = '1'; setTimeout(() => input.focus(), 60) }
        if(!adding) delete addCard.dataset.focused
    }

    function renderCard(){
        const f = hot ? model.friend(hot) : null
        if(!f || stripHidden || windowOpen || away()){
            card.classList.remove('is-open')
            return
        }
        const r = releaseFor(f)
        const ring = f.presence.status === 'playing' ? ringOf(r) : f.presence.status === 'offline' ? 'rgba(255,255,255,.3)' : '#25AB90'
        const a = f.presence.activity
        const icon = f.presence.status === 'playing' && a?.kind === 'network' && a.gamemode && a.gamemode !== 'lobby' ? modeIcon(a.gamemode) : null
        const canJoin = f.presence.status === 'playing' && (f.presence.join.play || f.presence.join.spectate)
        const canChallenge = a?.kind === 'network'
        const inviteKind = model.inviteAction(f.uuid, inGame())
        const canInvite = !!inviteKind
        const inviteDone = inviteKind === 'round' ? invited.has(f.uuid) : inviteKind === 'party' && model.invitedToMyParty(f.uuid)
        const n = notes.get(f.uuid)
        const since = f.presence.status === 'playing' ? ago(f.presence.since) : ''
        const stale = model.stale || !status.session
        card.setAttribute('aria-label', f.name)
        card.innerHTML = `
            <div class="fcard-top">
                <span class="fr-head${f.presence.status === 'offline' ? ' is-off' : ''}" style="width:44px;height:44px;${headStyle(f.headUrl)};box-shadow:0 0 0 2px #111219,0 0 0 3.5px ${escapeHtml(ring)}"></span>
                <span style="min-width:0;flex:1">
                    <span class="fr-kicker" style="color:${escapeHtml(ring)}">${escapeHtml(kickerOf(f))}</span>
                    <span class="fr-name" style="margin-top:3px;font-size:15px">${escapeHtml(f.name)}</span>
                    <span class="fr-act">${icon ? `<img src="${icon}" alt="">` : ''}<span>${escapeHtml(line(f))}</span>${since ? `<span class="fr-since">· ${escapeHtml(since)}</span>` : ''}</span>
                </span>
            </div>
            ${canChallenge || canJoin || canInvite ? `<div class="fcard-actions">
                ${canChallenge ? `<button class="fr-ghost" data-act="challenge">${h('challenge')}</button>` : ''}
                ${canJoin ? `<button class="fr-join" data-act="join" style="--join-bg:${escapeHtml(joinBgOf(r))}" ${stale ? 'disabled' : ''}>${h(f.presence.join.play ? 'join' : 'spectate')}</button>` : ''}
                ${canInvite ? `<button class="fr-join${inviteDone ? ' is-done' : ''}" data-act="invite" style="--join-bg:var(--acc)" title="${escapeHtml(t(inviteKind === 'party' ? 'partyInviteHint' : 'roundInviteHint', { name: f.name }))}" ${stale || inviteDone ? 'disabled' : ''}>${h(inviteDone ? 'invited' : 'invite')}</button>` : ''}
            </div>` : ''}
            ${n ? `<p class="fcard-note${n.good ? ' is-good' : ''}">${escapeHtml(n.text)}</p>` : ''}`
        const head = strip.querySelector(`[data-head="${CSS.escape(f.uuid)}"]`)
        if(head){
            const box = head.getBoundingClientRect()
            const base = main.getBoundingClientRect()
            const top = Math.max(8, Math.min(base.height - card.offsetHeight - 8, box.top - base.top - 10))
            card.style.top = `${top}px`
        }
        card.classList.add('is-open')
    }

    function hideToast(){
        clearTimeout(inviteTimer)
        inv.classList.remove('is-open')
        toastKey = null
        toastItem = null
    }

    /** An answer from a toast did not work: show the same toast again, saying why. */
    function toastFail(key, text){
        dismissed.delete(key)
        toastNotes.set(key, text)
        hideToast()
        render()
    }

    const toastNote = text => text ? `<p class="fcard-note">${escapeHtml(text)}</p>` : ''

    /** "{name} invited you" to where they play: the round invite, unchanged. */
    function roundToast(i, why){
        const a = i.activity
        const r = a?.kind === 'network' ? netRelease() : releases().find(x => x.id === a?.release) ?? null
        const icon = a?.kind === 'network' && a.gamemode && a.gamemode !== 'lobby' ? modeIcon(a.gamemode) : null
        const where = a?.kind === 'network'
            ? t('inviteNetwork', { where: a.gamemode && a.gamemode !== 'lobby' ? modeLabel(a.gamemode) : t('inTheHub') })
            : (releaseName(a?.release) ?? t('playing'))
        inv.style.setProperty('--acc-text', ringOf(r))
        return `
            <div class="inv-top">
                <span class="fr-head" style="${headStyle(i.from.headUrl)};box-shadow:0 0 0 2px #111219,0 0 0 3.5px ${escapeHtml(ringOf(r))}"></span>
                <span style="min-width:0;flex:1">
                    <span class="fr-kicker" style="color:${escapeHtml(ringOf(r))}">${h('inviteKicker')}</span>
                    <span class="inv-title">${escapeHtml(t('invitedYou', { name: i.from.name }))}</span>
                    <span class="fr-act">${icon ? `<img src="${icon}" alt="">` : ''}<span>${escapeHtml(where)}</span></span>
                </span>
            </div>
            ${toastNote(why)}
            <div class="inv-actions">
                <button class="fr-ghost" data-act="later">${h('later')}</button>
                <button class="fr-join" data-act="join" style="--join-bg:${escapeHtml(joinBgOf(r))}">${h('join')}</button>
            </div>
            <span class="inv-bar"></span>`
    }

    /** "{name} invited you to their party": Decline / Join party, until the invite expires. */
    function partyToast(i, why){
        inv.style.setProperty('--acc-text', NET_RING)
        return `
            <div class="inv-top">
                <span class="fr-head" style="${headStyle(i.from.headUrl)};box-shadow:0 0 0 2px #111219,0 0 0 3.5px ${NET_RING}"></span>
                <span style="min-width:0;flex:1">
                    <span class="fr-kicker" style="color:${NET_RING}">${h('partyKicker')}</span>
                    <span class="inv-title">${escapeHtml(t('partyInvitedYou', { name: i.from.name }))}</span>
                    <span class="fr-act"><span>${escapeHtml(t('partyMembers', { n: i.members }))}</span></span>
                </span>
            </div>
            ${toastNote(why)}
            <div class="inv-actions">
                <button class="fr-ghost" data-act="pDecline">${h('decline')}</button>
                <button class="fr-join" data-act="pJoin" style="--join-bg:${NET_JOIN}">${h('joinParty')}</button>
            </div>
            <span class="inv-bar"></span>`
    }

    /**
     * "{leader} went to {Mode | the hub | ION Network}": Follow. The frame names a public
     * gamemode and a release, never a server (followPlace).
     */
    function followToast(f, why){
        const r = f.where.release ? (releases().find(x => x.id === f.where.release) ?? null) : netRelease()
        const where = followPlace(f.where, { hub: t('followHub'), network: t('network') })
        const icon = modeIcon(f.where.gamemode)
        const head = model.party?.members.find(m => m.uuid === f.leader.uuid)?.headUrl ?? null
        inv.style.setProperty('--acc-text', ringOf(r))
        return `
            <div class="inv-top">
                <span class="fr-head" style="${headStyle(head)};box-shadow:0 0 0 2px #111219,0 0 0 3.5px ${escapeHtml(ringOf(r))}"></span>
                <span style="min-width:0;flex:1">
                    <span class="fr-kicker" style="color:${escapeHtml(ringOf(r))}">${h('followKicker')}</span>
                    <span class="inv-title">${escapeHtml(t('followWent', { name: f.leader.name, where }))}</span>
                    ${icon ? `<span class="fr-act"><img src="${icon}" alt=""></span>` : ''}
                </span>
            </div>
            ${toastNote(why)}
            <div class="inv-actions">
                <button class="fr-ghost" data-act="fLater">${h('later')}</button>
                <button class="fr-join" data-act="fFollow" style="--join-bg:${escapeHtml(joinBgOf(r))}">${h('follow')}</button>
            </div>
            <span class="inv-bar"></span>`
    }

    /** "You were removed from the party": a short note, no buttons; it goes when its bar runs out. */
    function kickedToast(){
        inv.style.setProperty('--acc-text', '#F2C443')
        return `
            <div class="inv-top">
                <span style="min-width:0;flex:1">
                    <span class="fr-kicker" style="color:#F2C443">${h('partyLabel')}</span>
                    <span class="inv-title">${h('partyRemoved')}</span>
                </span>
            </div>
            <span class="inv-bar"></span>`
    }

    /** One toast at a time (model.pickToast): a party invite, the kicked note, a follow, then a round invite. */
    function renderToast(){
        const pick = model.pickToast(dismissed)
        if(!pick || stripHidden || windowOpen || away()){ hideToast(); return }
        if(toastKey === pick.key) return
        const ms = pick.kind === 'party' ? toastMs(pick.item.expiresAt) : pick.kind === 'follow' ? FOLLOW_MS : pick.kind === 'kicked' ? KICKED_MS : INVITE_MS
        toastKey = pick.key
        toastItem = pick.item
        const draw = { party: partyToast, kicked: kickedToast, follow: followToast }[pick.kind] ?? roundToast
        inv.innerHTML = draw(pick.item, toastNotes.get(pick.key))
        inv.style.setProperty('--inv-ms', `${ms}ms`)
        inv.classList.add('is-open')
        clearTimeout(inviteTimer)
        inviteTimer = setTimeout(() => {
            dismissed.add(pick.key)
            toastNotes.delete(pick.key)
            if(pick.kind === 'follow') model.clearFollow()
            if(pick.kind === 'kicked') model.clearKicked()
            hideToast()
            render()
        }, ms)
    }

    /* Presence on the slices and the mode tiles */

    function decorateSlices(){
        if(typeof Slices === 'undefined') return
        const net = netRelease()
        for(const el of stage.querySelectorAll('.slice[data-id]')){
            const here = model.playingOn(el.dataset.id, net?.id)
            const mid = el.querySelector('.tag-mid')
            let box = el.querySelector('.tag-friends')
            if(!here.length){ box?.remove(); continue }
            if(!box){ box = document.createElement('span'); box.className = 'tag-friends'; mid.appendChild(box) }
            const html = `${here.slice(0, 2).map(f => `<span class="fr-mini" style="${headStyle(f.headUrl)}"></span>`).join('')}<span class="fr-mini-count">${here.length}</span>`
            if(box.dataset.html !== html){ box.innerHTML = html; box.dataset.html = html; box.title = t('playingHere', { names: here.map(f => f.name).join(', ') }) }
        }
        const open = stage.querySelector('.slice.is-open[data-id]')
        if(!open) return
        const r = Slices.byId(open.dataset.id)
        const here = model.playingOn(open.dataset.id, net?.id)
        // The mode tiles: how many friends are in each mode, with the first one's head.
        const counts = model.modeCounts()
        for(const tile of open.querySelectorAll('.modes .mode')){
            const mode = (typeof Panels !== 'undefined' ? Panels.modes : []).find(m => m.name === tile.getAttribute('aria-label'))
            const n = mode ? counts[mode.id] || 0 : 0
            let badge = tile.querySelector('.mode-friends')
            if(!n){ badge?.remove(); continue }
            const first = model.friends().find(f => f.presence.activity?.gamemode === mode.id && f.presence.status === 'playing')
            if(!badge){ badge = document.createElement('span'); badge.className = 'mode-friends'; tile.appendChild(badge) }
            const html = `<img src="${escapeHtml(headUrl(first?.headUrl))}" alt="">${n}`
            if(badge.dataset.html !== html){ badge.innerHTML = html; badge.dataset.html = html; badge.title = t('isInMode', { name: first?.name ?? '', mode: mode.name }) }
        }
        // The line under the panel's heads: who of my friends is here.
        const panel = open.querySelector('.netpanel')
        let lineEl = open.querySelector('.slice-friendline')
        if(!panel || !here.length || !r){ lineEl?.remove(); return }
        const first = here[0]
        let text
        if(r.net){
            const mode = first.presence.activity?.gamemode
            const modeName = mode && mode !== 'lobby' ? modeLabel(mode) : t('inTheHub')
            text = here.length > 1 ? t('isInModeMore', { name: first.name, mode: modeName, n: here.length - 1 }) : t('isInMode', { name: first.name, mode: modeName })
        } else {
            text = here.length > 1 ? t('isPlayingMore', { name: first.name, n: here.length - 1 }) : t('isPlaying', { name: first.name })
        }
        const mode = r.net ? first.presence.activity?.gamemode : null
        const html = `${mode && modeIcon(mode) ? `<img src="${modeIcon(mode)}" alt="">` : '<i></i>'}<span>${escapeHtml(text)}</span>`
        if(!lineEl){ lineEl = document.createElement('p'); lineEl.className = 'slice-friendline' }
        const anchor = panel.querySelector('.np-count')
        if(anchor && lineEl.previousElementSibling !== anchor) anchor.after(lineEl)
        if(lineEl.dataset.html !== html){ lineEl.innerHTML = html; lineEl.dataset.html = html }
    }

    /* Wiring */

    function bind(){
        strip.addEventListener('click', e => {
            const head = e.target.closest('[data-head]')
            if(head){ clearTimeout(leaveTimer); hot = head.dataset.head; adding = false; render(); return }
            const act = e.target.closest('[data-act]')?.dataset.act
            if(act === 'add'){ adding = !adding; hot = null; render() }
            else if(act === 'hide') setStripHidden(true)
            else if(act === 'window') openWindow()
        })
        strip.addEventListener('mouseover', e => {
            const head = e.target.closest('[data-head]')
            if(!head || head.dataset.head === hot) return
            clearTimeout(leaveTimer)
            hot = head.dataset.head; adding = false
            render()
        })
        strip.addEventListener('focusin', e => {
            const head = e.target.closest('[data-head]')
            if(head){ clearTimeout(leaveTimer); hot = head.dataset.head; render() }
        })
        const leave = () => { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => { hot = null; render() }, LEAVE_MS) }
        strip.addEventListener('mouseleave', leave)
        card.addEventListener('mouseleave', leave)
        card.addEventListener('mouseenter', () => clearTimeout(leaveTimer))
        card.addEventListener('click', e => {
            const act = e.target.closest('[data-act]')?.dataset.act
            if(!act || !hot) return
            if(act === 'join') join(hot)
            else if(act === 'challenge') challenge(hot)
            else if(act === 'invite') invite(hot)
        })
        const form = addCard.querySelector('form')
        form.addEventListener('submit', e => {
            e.preventDefault()
            const name = form.querySelector('input').value.trim()
            if(FRIEND_NAME.test(name)) sendRequest(name)
        })
        form.querySelector('input').addEventListener('input', () => { addCard.querySelector('.fcard-note').hidden = true; updateAddCard() })
        inv.addEventListener('click', async e => {
            const act = e.target.closest('[data-act]')?.dataset.act
            const key = toastKey
            const item = toastItem
            if(!act || !key || !item) return
            dismissed.add(key)
            toastNotes.delete(key)
            switch(act){
                case 'later':
                    hideToast()
                    ipcRenderer.invoke('friends:dismissInvite', item.from.uuid).catch(() => {})
                    render()
                    break
                case 'join':
                    join(item.from.uuid)
                    render()
                    break
                case 'pDecline':
                    hideToast()
                    ipcRenderer.invoke('friends:partyDecline', item.partyId).catch(() => {})
                    render()
                    break
                case 'pJoin': {
                    hideToast()
                    render()
                    const res = await ipcRenderer.invoke('friends:partyAccept', item.partyId)
                    if(!res?.ok) toastFail(key, failText(res))
                    break
                }
                case 'fLater':
                    hideToast()
                    model.clearFollow()
                    break
                case 'fFollow':
                    hideToast()
                    follow(item)
                    break
            }
        })
        document.addEventListener('mousedown', e => {
            if(adding && !addCard.contains(e.target) && !e.target.closest('.fs-top')){ adding = false; render() }
        })
        document.addEventListener('keydown', e => {
            if(e.key === 'Escape' && (adding || hot)){ adding = false; hot = null; render() }
        })
    }

    ipcRenderer.on('friends:event', (_e, f) => {
        if(!f || typeof f.event !== 'string') return
        switch(f.event){
            case 'status':
                status = { session: !!f.session, live: !!f.live, reason: f.reason ?? null }
                if(status.reason === 'unavailable' || status.reason === 'offline' || status.reason === 'gate') model.setStale(true)
                if(status.reason === 'mojang') refreshAccount()
                render()
                break
            case 'window':
                windowOpen = !!f.open
                render()
                break
            case 'view':
                model.apply('view', f)
                for(const uuid of invited) if(!model.friend(uuid)) invited.delete(uuid)
                break
            default:
                model.apply(f.event, f)
        }
    })
    // Join and Challenge from the friends window run here, where the Play view is.
    ipcRenderer.on('friends:do', (_e, m) => {
        if(m?.op === 'partyFollow') {
            // The friends window's Follow: the same path as the follow toast's button.
            if(model.partyFollow) follow(model.partyFollow, true)
            return
        }
        if(!m || typeof m.uuid !== 'string') return
        if(m.op === 'join') join(m.uuid)
        else if(m.op === 'challenge') challenge(m.uuid)
    })

    model.subscribe(render)
    GameState.subscribe(() => { reportPresence(); render() })
    // landing.js calls these when the selection changes; shell.js already defines the server one.
    const prevServer = window.onSelectedServerChanged
    window.onSelectedServerChanged = (...a) => { prevServer?.(...a); reportPresence(); render() }
    const prevAccount = window.onSelectedAccountChanged
    window.onSelectedAccountChanged = (...a) => { prevAccount?.(...a); sendAccount() }
    // The slices rebuild their nodes and panels on their own schedule; the decorations follow.
    new MutationObserver(() => { if(mounted) requestAnimationFrame(decorateSlices) }).observe(stage, { childList: true, subtree: true })
    // Entering or leaving the settings workspace only changes the stage's class (slices.js).
    new MutationObserver(() => { if(mounted) render() }).observe(stage, { attributes: true, attributeFilter: ['class'] })
    // The Play view is shown and hidden in several ways (jQuery fades, the settings workspace); a
    // hidden view has no size, so its size is the one signal all of them share.
    new ResizeObserver(() => { if(mounted) render() }).observe(landing)
    // The flag (Settings › Launcher) and a refreshed account token are picked up here.
    setInterval(() => {
        if(enabled() !== mounted) (enabled() ? mount : unmount)()
        else if(mounted) sendAccount()
    }, 2000)
    if(enabled()) mount()

    return { model, join, follow, challenge, invite, openWindow, get mounted(){ return mounted } }
})()
