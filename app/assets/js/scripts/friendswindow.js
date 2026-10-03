/**
 * The friends window (friends.ejs): the add row, requests with Accept and Decline, the PLAYING ·
 * IN THE LAUNCHER · OFFLINE sections with Join, Challenge and Invite, and the two switches. It is
 * its own renderer: the model (friendsmodel.js) is built here from the main process's `friends:*`
 * answers and pushed events; Join and Challenge are relayed to the launcher window, where the Play
 * view is.
 */
const { ipcRenderer } = require('electron')
const Lang = require('./assets/js/langloader')
const Web = require('./assets/js/weburl')
const { createFriendsModel, activityLine, ago, MODES, NAME } = require('./assets/js/friendsmodel')

Lang.setupLanguage()

const t = (k, p) => Lang.queryJS(`friends.${k}`, p)
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
const TEXTS = {
    inTheLauncher: t('inTheLauncher'), online: t('online'), inTheHub: t('inTheHub'), inAMatch: t('inAMatch'),
    lobby: t('lobby'), podium: t('podium'), playing: t('playing'), offline: t('offline'), lastOnline: when => t('lastOnline', { when })
}
const NET_RING = '#A9B9FA'
const NET_JOIN = 'linear-gradient(100deg, #1E9CCB 0%, #4F6EE0 52%, #7150CF 100%)'
const NOTE_MS = 2600

const model = createFriendsModel()
let status = { session: false, live: false, reason: null }
let releases = []
let launcherState = { busy: false, release: null }
const notes = new Map()
const invited = new Set()
const root = document.getElementById('friendsWindow')
const body = document.getElementById('fwBody')
const $ = id => document.getElementById(id)

const releaseName = id => releases.find(r => r.id === id)?.name ?? null
const releaseFor = f => {
    const a = f.presence.activity
    if(!a) return null
    return a.kind === 'network' ? releases.find(r => r.net) ?? null : releases.find(r => r.id === a.release) ?? null
}
const ringOf = r => r?.accent?.text ?? NET_RING
const joinBgOf = r => r?.playBg ?? NET_JOIN
const modeIcon = id => MODES[id] ? `assets/images/modes/${id}.svg` : null
const headStyle = url => {
    if(!url) return ''
    try { return `background-image:url('${esc(new URL(url, Web.url).href)}')` } catch { return '' }
}
const inGame = () => launcherState.busy || model.me?.presence.status === 'playing'
const stale = () => model.stale || !status.session

function note(uuid, text){
    notes.set(uuid, { text, until: Date.now() + NOTE_MS })
    render()
    setTimeout(() => { if(notes.get(uuid)?.until <= Date.now()){ notes.delete(uuid); render() } }, NOTE_MS + 50)
}
const failText = res => res?.error || (res?.code === 'UNAVAILABLE' || res?.code === 'GATE' ? t('unavailable') : res?.code === 'NO_SESSION' ? t('noSession') : t('noteFailed'))

function row(f, section){
    const r = releaseFor(f)
    const a = f.presence.activity
    const st = f.presence.status
    const icon = st === 'playing' && a?.kind === 'network' && a.gamemode && a.gamemode !== 'lobby' ? modeIcon(a.gamemode) : null
    const since = st === 'playing' ? ago(f.presence.since) : ''
    const n = notes.get(f.uuid)
    const canJoin = st === 'playing' && (f.presence.join.play || f.presence.join.spectate)
    const ring = st === 'playing' ? ringOf(r) : '#25AB90'
    let acts = ''
    if(section === 'playing'){
        acts = `${a?.kind === 'network' ? `<button class="fr-ghost" data-act="challenge" data-uuid="${esc(f.uuid)}">${esc(t('challenge'))}</button>` : ''}
            ${canJoin ? `<button class="fr-join" data-act="join" data-uuid="${esc(f.uuid)}" style="--join-bg:${esc(joinBgOf(r))}">${esc(t(f.presence.join.play ? 'join' : 'spectate'))}</button>` : ''}`
    } else if(section === 'launcher' && inGame()){
        const done = invited.has(f.uuid)
        acts = `<button class="fr-join${done ? ' is-done' : ''}" data-act="invite" data-uuid="${esc(f.uuid)}" ${done ? 'disabled' : ''}>${esc(t(done ? 'invited' : 'invite'))}</button>`
    } else if(section === 'offline'){
        acts = `<button class="fr-ghost" data-act="remove" data-uuid="${esc(f.uuid)}" aria-label="${esc(t('more', { name: f.name }))}" title="${esc(t('remove'))}">⋯</button>`
    }
    return `<div class="fr-row${st === 'offline' ? ' is-off' : ''}">
        <span class="fr-head${st === 'offline' ? ' is-off' : ''}" style="${headStyle(f.headUrl)}${st === 'playing' ? `;box-shadow:0 0 0 2px #0e0f14,0 0 0 3.5px ${esc(ring)}` : ''}">${st !== 'offline' ? `<span class="fr-dot" style="background:${esc(ring)};box-shadow:0 0 0 3px #0e0f14"></span>` : ''}</span>
        <span style="min-width:0"><span class="fr-name">${esc(f.name)}</span><span class="fr-act">${icon ? `<img src="${icon}" alt="">` : ''}<span>${esc(activityLine(f.presence, releaseName, TEXTS))}</span>${since ? `<span class="fr-since">· ${esc(since)}</span>` : ''}</span></span>
        <span class="fr-acts">${acts}</span>
        ${n ? `<span class="fr-note">${esc(n.text)}</span>` : ''}
    </div>`
}

function requestRow(r){
    const incoming = r.direction === 'incoming'
    return `<div class="fr-row">
        <span class="fr-head" style="${headStyle(r.headUrl)}"></span>
        <span style="min-width:0"><span class="fr-name">${esc(r.name)}</span><span class="fr-act">${esc(t(incoming ? 'wantsToBeFriends' : 'requestPending'))}</span></span>
        <span class="fr-acts">${incoming ? `<button class="fr-ghost is-shown" data-act="decline" data-uuid="${esc(r.uuid)}">${esc(t('decline'))}</button><button class="fr-join" data-act="accept" data-uuid="${esc(r.uuid)}">${esc(t('accept'))}</button>` : ''}</span>
    </div>`
}

function render(){
    const online = model.onlineCount()
    $('fwOnline').textContent = t('onlineCount', { n: online })
    root.classList.toggle('is-stale', stale())
    const staleEl = $('fwStale')
    staleEl.hidden = !(model.stale || status.reason)
    staleEl.textContent = !status.session && status.reason && status.reason !== 'unavailable' && status.reason !== 'offline' ? t('noSession') : t('unavailable')
    const s = model.sections()
    const requests = model.requests
    const sec = (key, n) => `<div class="fd-sec"><span>${esc(t(key, { n }))}</span><i></i></div>`
    body.innerHTML = `
        ${requests.length ? sec('sectionRequests') + requests.map(requestRow).join('') : ''}
        ${sec('sectionPlaying', s.playing.length)}${s.playing.map(f => row(f, 'playing')).join('') || `<p class="fd-empty">${esc(t('nobodyPlaying'))}</p>`}
        ${sec('sectionLauncher', s.launcher.length)}${s.launcher.map(f => row(f, 'launcher')).join('') || `<p class="fd-empty">${esc(t('nobodyHere'))}</p>`}
        ${sec('sectionOffline', s.offline.length)}${s.offline.map(f => row(f, 'offline')).join('') || (model.friends().length ? '' : `<p class="fd-empty">${esc(t('noFriends'))}</p>`)}`
    $('fwShowActivity').setAttribute('aria-checked', String(model.settings.showActivity))
    $('fwAppearOffline').setAttribute('aria-checked', String(model.settings.appearOffline))
    updateAdd()
}

function updateAdd(){
    const valid = NAME.test($('fwName').value.trim())
    $('fwPreview').classList.toggle('is-valid', valid)
    $('fwSend').disabled = !valid || !status.session
}

async function act(op, uuid){
    switch(op){
        case 'join':
        case 'challenge':
            await ipcRenderer.invoke('friends:act', op, uuid)
            break
        case 'invite': {
            const res = await ipcRenderer.invoke('friends:invite', uuid)
            if(res.ok){ invited.add(uuid); render() } else note(uuid, failText(res))
            break
        }
        case 'accept':
        case 'decline':
        case 'remove': {
            const res = await ipcRenderer.invoke(`friends:${op}`, uuid)
            if(!res.ok) note(uuid, failText(res))
            break
        }
    }
}

body.addEventListener('click', e => {
    const b = e.target.closest('[data-act]')
    if(b) act(b.dataset.act, b.dataset.uuid)
})
$('fwAdd').addEventListener('submit', async e => {
    e.preventDefault()
    const name = $('fwName').value.trim()
    if(!NAME.test(name)) return
    const res = await ipcRenderer.invoke('friends:request', name)
    const n = $('fwAddNote')
    n.hidden = false
    n.classList.toggle('is-good', !!res.ok)
    n.textContent = res.ok ? t('requestSent', { name: res.data?.name ?? name }) : failText(res)
    if(res.ok) $('fwName').value = ''
    updateAdd()
})
$('fwName').addEventListener('input', () => { $('fwAddNote').hidden = true; updateAdd() })
for(const [id, key] of [['fwShowActivity', 'showActivity'], ['fwAppearOffline', 'appearOffline']]){
    $(id).addEventListener('click', async () => {
        const next = !model.settings[key]
        model.setSettings({ [key]: next })
        const res = await ipcRenderer.invoke('friends:settings', { [key]: next })
        if(res.ok && res.data) model.setSettings(res.data)
        else if(!res.ok) model.setSettings({ [key]: !next })
    })
}
$('fwPin').addEventListener('click', async () => {
    const on = await ipcRenderer.invoke('friends:window', 'pin')
    $('fwPin').setAttribute('aria-pressed', String(!!on))
})
$('fwPutBack').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'putBack'))
$('fwMinimize').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'minimize'))
$('fwClose').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'close'))
document.addEventListener('keydown', e => { if(e.key === 'Escape') ipcRenderer.invoke('friends:window', 'close') })

ipcRenderer.on('friends:event', (_e, f) => {
    if(!f || typeof f.event !== 'string') return
    if(f.event === 'status'){ status = { session: !!f.session, live: !!f.live, reason: f.reason ?? null }; if(status.reason === 'unavailable' || status.reason === 'offline' || status.reason === 'gate') model.setStale(true); render(); return }
    if(f.event === 'releases'){ releases = Array.isArray(f.releases) ? f.releases : []; render(); return }
    if(f.event === 'launcher'){ launcherState = { busy: !!f.busy, release: f.release ?? null }; render(); return }
    if(f.event === 'window') return
    model.apply(f.event, f)
})
model.subscribe(render)

async function start(){
    status = { ...status, ...(await ipcRenderer.invoke('friends:status').catch(() => ({}))) }
    releases = (await ipcRenderer.invoke('friends:releases').catch(() => [])) || []
    const view = await ipcRenderer.invoke('friends:view').catch(() => null)
    if(view?.data) model.load(view.data)
    if(view && !view.ok) model.setStale(view.stale === true || view.code === 'UNAVAILABLE')
    render()
    ipcRenderer.invoke('friends:poll').catch(() => {})
}
start()
