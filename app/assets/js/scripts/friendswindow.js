/**
 * The friends window (friends.ejs): the add row and three tabs.
 *
 *   Friends   party invites to me, my party (or Start a party), requests (Accept / Decline, Cancel
 *             on my own), then PLAYING · IN THE LAUNCHER · OFFLINE with Join, Challenge and Invite,
 *             or one list when sorted otherwise; search and sort sit above it.
 *   Clan      my clan's members with presence and the quick actions that exist: Join, party
 *             invite, friend request.
 *   Settings  every friends setting the launcher may change, and the blocked list with Unblock.
 *
 * It is its own renderer: the model (friendsmodel.js) is built here from the main process's
 * `friends:*` answers and pushed events; Join and Challenge are relayed to the launcher window,
 * where the Play view is. No messages: private messages and party chat live in Minecraft only.
 */
const { ipcRenderer } = require('electron')
const Lang = require('./assets/js/langloader')
const Web = require('./assets/js/weburl')
const {
    createFriendsModel, activityLine, ago, followPlace, partyWhereKey, confirmStep, sortFriends, cleanSort, searchFriends, roundLines,
    cleanClanMembers, CROWN_SVG, PARTY_TICK_MS, MODES, NAME, SETTING_ENUMS
} = require('./assets/js/friendsmodel')

Lang.setupLanguage()

const t = (k, p) => Lang.queryJS(`friends.${k}`, p)
const s = (k, p) => t(`social.${k}`, p)
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
const TEXTS = {
    inTheLauncher: t('inTheLauncher'), online: t('online'), inTheHub: t('inTheHub'), inAMatch: t('inAMatch'),
    lobby: t('lobby'), podium: t('podium'), playing: t('playing'), offline: t('offline'), lastOnline: when => t('lastOnline', { when })
}
const ROUND_TEXTS = {
    map: map => map,
    team: team => s('roundTeam', { team }),
    waiting: (count, max) => s('roundWaiting', { count, max })
}
const NET_RING = '#A9B9FA'
const NET_JOIN = 'linear-gradient(100deg, #1E9CCB 0%, #4F6EE0 52%, #7150CF 100%)'
const NOTE_MS = 2600
/** The enum settings' option labels (friends.social.<key>). */
const OPTION_KEYS = { EVERYONE: 'optEveryone', FRIENDS: 'optFriends', FRIENDS_AND_CLAN: 'optFriendsAndClan', NOBODY: 'optNobody' }
const TABS = ['friends', 'clan', 'settings']

const model = createFriendsModel()
let status = { session: false, live: false, reason: null }
let releases = []
let launcherState = { busy: false, release: null }
const notes = new Map()
const invited = new Set()
/** Party invites sent from here, shown as Invited until the next `party` event says what happened. */
const partyPending = new Set()
/** Friend requests sent from the clan tab, shown as Requested until the view has them. */
const requested = new Set()
/** The friend whose ⋯ is open (Block, Remove): nothing happens without that second click. */
let confirming = null
/** 'leave', 'disband' or 'kick:<uuid>': these take a second, deliberate click (confirmStep). */
let partyConfirm = null
/** Redraws "Offline for N min" while my party has an away member; cleared otherwise. */
let partyTick = null
let tab = 'friends'
let search = ''
let sort = 'online'
/** The clan tab's answer: null until asked, then {clan, members} or {failed}. */
let clan = null
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
/** A blocked player has no headUrl in the view; the website serves every head at the same path. */
const headPath = uuid => `/api/launcher/friends/head/${encodeURIComponent(uuid)}`
const inGame = () => launcherState.busy || model.me?.presence.status === 'playing'
const stale = () => model.stale || !status.session
const off = () => stale() ? 'disabled' : ''
const sectionOf = f => f.presence.status === 'playing' ? 'playing' : f.presence.status === 'offline' ? 'offline' : 'launcher'

function note(key, text, good = false){
    notes.set(key, { text, good, until: Date.now() + NOTE_MS })
    render()
    setTimeout(() => { if(notes.get(key)?.until <= Date.now()){ notes.delete(key); render() } }, NOTE_MS + 50)
}
/** Why a call did not work. BACKEND_OFF comes first: the server's own sentence is English and says less. */
const failText = res => res?.code === 'BACKEND_OFF' ? s('availableSoon')
    : res?.error || (res?.code === 'UNAVAILABLE' || res?.code === 'GATE' ? t('unavailable') : res?.code === 'NO_SESSION' ? t('noSession') : t('noteFailed'))
const noteSpan = key => {
    const n = notes.get(key)
    return n ? `<span class="fr-note${n.good ? ' is-good' : ''}">${esc(n.text)}</span>` : ''
}

/** The clan tag after a name, and a round's line and standings under the activity line. */
const tagHtml = tag => tag ? `<span class="fr-tag">[${esc(tag)}]</span>` : ''
function roundHtml(presence){
    if(presence.status !== 'playing') return ''
    const r = roundLines(presence.activity?.round, ROUND_TEXTS)
    if(!r) return ''
    return `${r.line ? `<span class="fr-round">${esc(r.line)}</span>` : ''}${r.standings.length ? `<span class="fr-standings">${r.standings.map(x => `<span>${esc(x)}</span>`).join('')}</span>` : ''}`
}

function row(f){
    const section = sectionOf(f)
    const r = releaseFor(f)
    const a = f.presence.activity
    const st = f.presence.status
    const icon = st === 'playing' && a?.kind === 'network' && a.gamemode && a.gamemode !== 'lobby' ? modeIcon(a.gamemode) : null
    const since = st === 'playing' ? ago(f.presence.since) : ''
    const canJoin = st === 'playing' && (f.presence.join.play || f.presence.join.spectate)
    const ring = st === 'playing' ? ringOf(r) : '#25AB90'
    const kind = model.inviteAction(f.uuid, inGame())
    const inviteDone = kind === 'round' ? invited.has(f.uuid) : kind === 'party' && (model.invitedToMyParty(f.uuid) || partyPending.has(f.uuid))
    const inviteBtn = kind ? `<button class="fr-join${inviteDone ? ' is-done' : ''}" data-act="invite" data-uuid="${esc(f.uuid)}" title="${esc(t(kind === 'party' ? 'partyInviteHint' : 'roundInviteHint', { name: f.name }))}" ${inviteDone ? 'disabled' : ''}>${esc(t(inviteDone ? 'invited' : 'invite'))}</button>` : ''
    // The board's "More": it reveals Block and Remove, each one deliberate click further.
    const more = `<button class="fr-ghost" data-act="more" data-uuid="${esc(f.uuid)}" aria-label="${esc(t('more', { name: f.name }))}" aria-expanded="false">⋯</button>`
    let acts
    if(confirming === f.uuid){
        acts = `<button class="fr-ghost is-shown" data-act="cancel" data-uuid="${esc(f.uuid)}">${esc(t('cancel'))}</button>
            <button class="fr-join fr-danger" data-act="block" data-uuid="${esc(f.uuid)}" title="${esc(s('blockHint', { name: f.name }))}" ${off()}>${esc(t('block'))}</button>
            <button class="fr-join fr-danger" data-act="remove" data-uuid="${esc(f.uuid)}" ${off()}>${esc(t('remove'))}</button>`
    } else if(section === 'playing'){
        acts = `${a?.kind === 'network' ? `<button class="fr-ghost" data-act="challenge" data-uuid="${esc(f.uuid)}">${esc(t('challenge'))}</button>` : ''}
            ${canJoin ? `<button class="fr-join" data-act="join" data-uuid="${esc(f.uuid)}" style="--join-bg:${esc(joinBgOf(r))}">${esc(t(f.presence.join.play ? 'join' : 'spectate'))}</button>` : ''}
            ${inviteBtn}${more}`
    } else if(section === 'launcher'){
        acts = inviteBtn + more
    } else {
        acts = more
    }
    return `<div class="fr-row${st === 'offline' ? ' is-off' : ''}">
        <span class="fr-head${st === 'offline' ? ' is-off' : ''}" style="${headStyle(f.headUrl)}${st === 'playing' ? `;box-shadow:0 0 0 2px #0e0f14,0 0 0 3.5px ${esc(ring)}` : ''}">${st !== 'offline' ? `<span class="fr-dot" style="background:${esc(ring)};box-shadow:0 0 0 3px #0e0f14"></span>` : ''}</span>
        <span style="min-width:0"><span class="fr-name${f.presence.afk ? ' is-afk' : ''}">${esc(f.name)}${tagHtml(f.clanTag)}${f.presence.afk ? `<span class="fr-afk">${esc(t('afk'))}</span>` : ''}</span><span class="fr-act">${icon ? `<img src="${icon}" alt="">` : ''}<span>${esc(activityLine(f.presence, releaseName, TEXTS))}</span>${since ? `<span class="fr-since">· ${esc(since)}</span>` : ''}</span>${roundHtml(f.presence)}</span>
        <span class="fr-acts">${acts}</span>
        ${noteSpan(f.uuid)}
    </div>`
}

function requestRow(r){
    const incoming = r.direction === 'incoming'
    const acts = incoming
        ? `<button class="fr-ghost is-shown" data-act="decline" data-uuid="${esc(r.uuid)}">${esc(t('decline'))}</button><button class="fr-join" data-act="accept" data-uuid="${esc(r.uuid)}">${esc(t('accept'))}</button>`
        : `<button class="fr-ghost is-shown" data-act="cancelRequest" data-uuid="${esc(r.uuid)}" title="${esc(s('cancelRequestHint', { name: r.name }))}" ${off()}>${esc(t('cancel'))}</button>`
    return `<div class="fr-row">
        <span class="fr-head" style="${headStyle(r.headUrl)}"></span>
        <span style="min-width:0"><span class="fr-name">${esc(r.name)}</span><span class="fr-act">${esc(t(incoming ? 'wantsToBeFriends' : 'requestPending'))}</span></span>
        <span class="fr-acts">${acts}</span>
        ${noteSpan(r.uuid)}
    </div>`
}

const sec = text => `<div class="fd-sec"><span>${esc(text)}</span><i></i></div>`

/** "Offline for 12 min" for an away member with `awaySince`, otherwise the plain place label. */
function whereText(m){
    if(m.where === 'away' && m.awaySince != null){
        const when = ago(new Date(m.awaySince).toISOString())
        return when === 'now' ? s('awayJustNow') : s('awayFor', { when })
    }
    return t(partyWhereKey(m.where))
}

/** Party invites to me, then my party (or "Start a party"). */
function partySection(){
    if(!status.session) return ''
    const p = model.party
    const pending = model.partyInvites
    let out = ''
    if(pending.length){
        out += sec(t('sectionPartyInvites')) + pending.map(i => `<div class="fr-row">
            <span class="fr-head" style="${headStyle(i.from.headUrl)}"></span>
            <span style="min-width:0"><span class="fr-name">${esc(i.from.name)}</span><span class="fr-act">${esc(t('partyMembers', { n: i.members }))}</span></span>
            <span class="fr-acts"><button class="fr-ghost is-shown" data-act="pDecline" data-party="${esc(i.partyId)}" ${off()}>${esc(t('decline'))}</button><button class="fr-join" data-act="pAccept" data-party="${esc(i.partyId)}" ${off()}>${esc(t('joinParty'))}</button></span>
            ${noteSpan(i.partyId)}
        </div>`).join('')
    }
    if(!p){
        return `${out}${sec(t('sectionPartyEmpty'))}<div class="fr-row fp-start"><button class="fr-ghost is-shown" data-act="pCreate" ${off()}>${esc(t('partyStart'))}</button>${noteSpan('party')}</div>`
    }
    const leader = model.amLeader()
    const seats = model.partySeats()
    out += sec(seats.max != null ? s('partySize', { n: seats.members, max: seats.max }) : t('sectionParty', { n: seats.members }))
    const fl = model.partyFollow
    if(fl && fl.partyId === p.id && !model.isMe(fl.leader.uuid)){
        const where = followPlace(fl.where, { hub: t('followHub'), network: t('network') })
        out += `<div class="fr-row">
            <span class="fr-head" style="${headStyle(p.members.find(m => m.uuid === fl.leader.uuid)?.headUrl)}"></span>
            <span style="min-width:0"><span class="fr-name">${esc(t('followWent', { name: fl.leader.name, where }))}</span></span>
            <span class="fr-acts"><button class="fr-join" data-act="pFollow" data-uuid="${esc(fl.leader.uuid)}">${esc(t('follow'))}</button></span>
        </div>`
    }
    out += p.members.map(m => {
        const self = model.isMe(m.uuid)
        let acts = ''
        if(self){
            acts = partyConfirm === 'leave'
                ? `<button class="fr-ghost is-shown" data-act="pCancel">${esc(t('cancel'))}</button><button class="fr-join fr-danger" data-act="pLeave" ${off()}>${esc(t('partyLeave'))}</button>`
                : `<button class="fr-ghost" data-act="pLeave" ${off()}>${esc(t('partyLeave'))}</button>`
        } else if(leader){
            acts = partyConfirm === `kick:${m.uuid}`
                ? `<button class="fr-ghost is-shown" data-act="pCancel">${esc(t('cancel'))}</button><button class="fr-join fr-danger" data-act="pKick" data-uuid="${esc(m.uuid)}" ${off()}>${esc(t('partyKick'))}</button>`
                : `<button class="fr-ghost" data-act="pPromote" data-uuid="${esc(m.uuid)}" ${off()}>${esc(t('partyPromote'))}</button><button class="fr-ghost" data-act="pKick" data-uuid="${esc(m.uuid)}" ${off()}>${esc(t('partyKick'))}</button>`
        }
        return `<div class="fr-row${m.where === 'away' ? ' is-off' : ''}">
            <span class="fr-head${m.where === 'away' ? ' is-off' : ''}" style="${headStyle(m.headUrl)}"></span>
            <span style="min-width:0"><span class="fr-name">${esc(self ? t('you') : m.name)}${m.leader ? `<span class="fp-lead" title="${esc(t('partyLeader'))}">${CROWN_SVG}</span>` : ''}</span><span class="fr-act">${esc(whereText(m))}${model.friend(m.uuid) || self ? '' : ` · ${esc(t('partyNotFriend'))}`}</span></span>
            <span class="fr-acts">${acts}</span>
        </div>`
    }).join('')
    if(leader){
        out += `<div class="fp-leadacts">${partyConfirm === 'disband'
            ? `<button class="fr-ghost is-shown" data-act="pCancel">${esc(t('cancel'))}</button><button class="fr-join fr-danger" data-act="pDisband" ${off()}>${esc(s('partyDisband'))}</button>`
            : `<button class="fr-ghost is-shown" data-act="pDisband" ${off()}>${esc(s('partyDisband'))}</button>`}
            <button class="fr-join" data-act="pWarp" title="${esc(s('partyWarpHint'))}" ${off()}>${esc(s('partyWarp'))}</button></div>`
    }
    return out + (notes.get('party') ? `<div class="fr-row">${noteSpan('party')}</div>` : '')
}

/** The friends themselves: three sections in the "online first" sort, one list otherwise; the search filters both. */
function friendList(){
    const everyone = model.friends()
    const shown = searchFriends(sortFriends(everyone, sort), search)
    if(search.trim() && !shown.length) return sec(s('sectionAll', { n: 0 })) + `<p class="fd-empty">${esc(s('noMatch'))}</p>`
    if(sort !== 'online') return sec(s('sectionAll', { n: shown.length })) + (shown.map(row).join('') || `<p class="fd-empty">${esc(t('noFriends'))}</p>`)
    const of = name => shown.filter(f => sectionOf(f) === name)
    const [playing, launcher, offline] = [of('playing'), of('launcher'), of('offline')]
    return `${sec(t('sectionPlaying', { n: playing.length }))}${playing.map(row).join('') || `<p class="fd-empty">${esc(t('nobodyPlaying'))}</p>`}
        ${sec(t('sectionLauncher', { n: launcher.length }))}${launcher.map(row).join('') || `<p class="fd-empty">${esc(t('nobodyHere'))}</p>`}
        ${sec(t('sectionOffline', { n: offline.length }))}${offline.map(row).join('') || (everyone.length ? '' : `<p class="fd-empty">${esc(t('noFriends'))}</p>`)}`
}

function friendsTab(){
    const requests = model.requests
    return `${partySection()}
        ${requests.length ? sec(t('sectionRequests')) + requests.map(requestRow).join('') : ''}
        ${friendList()}`
}

/** The clan tab: who is in my clan, how they are, and what I can do with each. */
function clanTab(){
    if(!status.session) return `<p class="fd-empty">${esc(t('noSession'))}</p>`
    if(!clan) return `<p class="fd-empty">${esc(s('clanLoading'))}</p>`
    if(clan.failed) return `<p class="fd-empty">${esc(clan.failed)}</p>`
    if(!clan.clan) return `<p class="fd-empty">${esc(s('noClan'))}</p>`
    const name = clan.clan.tag ? `${clan.clan.name} [${clan.clan.tag}]` : clan.clan.name
    return sec(s('clanTitle', { name, n: clan.members.length })) + clan.members.map(clanRow).join('')
}

function clanRow(m){
    const self = model.isMe(m.uuid)
    const st = m.presence.status
    const friend = model.friend(m.uuid)
    let acts = ''
    if(!self){
        // A non-friend's presence carries no usable join answer, so only friends get Join.
        if(friend && st === 'playing' && (m.presence.join.play || m.presence.join.spectate)){
            acts += `<button class="fr-join" data-act="join" data-uuid="${esc(m.uuid)}" style="--join-bg:${esc(joinBgOf(releaseFor(friend)))}">${esc(t(m.presence.join.play ? 'join' : 'spectate'))}</button>`
        }
        const canParty = st !== 'offline' && !model.isInMyParty(m.uuid) && (!model.party || model.amLeader()) && !model.partySeats()?.full
        if(canParty){
            const done = model.invitedToMyParty(m.uuid) || partyPending.has(m.uuid)
            acts += `<button class="fr-join${done ? ' is-done' : ''}" data-act="clanParty" data-uuid="${esc(m.uuid)}" title="${esc(t('partyInviteHint', { name: m.name }))}" ${done || stale() ? 'disabled' : ''}>${esc(t(done ? 'invited' : 'invite'))}</button>`
        }
        if(!friend && !m.friend){
            const done = requested.has(m.uuid) || model.outgoingRequests().some(r => r.uuid === m.uuid)
            acts += `<button class="fr-ghost is-shown" data-act="clanRequest" data-uuid="${esc(m.uuid)}" data-name="${esc(m.name)}" ${done || stale() ? 'disabled' : ''}>${esc(s(done ? 'requested' : 'addFriend'))}</button>`
        }
    }
    const role = m.role === 'LEADER' ? s('roleLeader') : m.role === 'OFFICER' ? s('roleOfficer') : ''
    return `<div class="fr-row${st === 'offline' ? ' is-off' : ''}">
        <span class="fr-head${st === 'offline' ? ' is-off' : ''}" style="${headStyle(m.headUrl)}">${st !== 'offline' ? '<span class="fr-dot" style="background:#25AB90;box-shadow:0 0 0 3px #0e0f14"></span>' : ''}</span>
        <span style="min-width:0"><span class="fr-name">${esc(self ? t('you') : m.name)}${role ? `<span class="fr-role">${esc(role)}</span>` : ''}</span><span class="fr-act"><span>${esc(activityLine(m.presence, releaseName, TEXTS))}</span></span>${roundHtml(m.presence)}</span>
        <span class="fr-acts">${acts}</span>
        ${noteSpan(m.uuid)}
    </div>`
}

/** A switch row; a setting the website does not offer yet (null) says "available soon" instead. */
function switchRow(key, label, desc){
    const v = model.settings[key]
    const control = v == null
        ? `<span class="fw-soon">${esc(s('availableSoon'))}</span>`
        : `<button class="sw" role="switch" data-set="${key}" aria-checked="${v}" aria-label="${esc(label)}"><span></span></button>`
    return `<div class="fr-row fw-set"><span class="rt">${esc(label)}${desc ? `<span class="rd">${esc(desc)}</span>` : ''}</span>${control}${noteSpan(`set:${key}`)}</div>`
}

/** An enum row: its constants as a row of buttons, the current one pressed. */
function choiceRow(key, label, desc){
    const v = model.settings[key]
    const control = v == null
        ? `<span class="fw-soon">${esc(s('availableSoon'))}</span>`
        : `<span class="fw-seg" role="group" aria-label="${esc(label)}">${SETTING_ENUMS[key].map(o => `<button data-set="${key}" data-value="${o}" aria-pressed="${v === o}">${esc(s(OPTION_KEYS[o]))}</button>`).join('')}</span>`
    return `<div class="fr-row fw-set is-wide"><span class="rt">${esc(label)}${desc ? `<span class="rd">${esc(desc)}</span>` : ''}${control}</span>${noteSpan(`set:${key}`)}</div>`
}

/** Every setting except the in-game hider and the in-game sort, then the blocked list. */
function settingsTab(){
    const blocked = model.blocked
    return `${sec(s('sectionPrivacy'))}
        ${switchRow('showActivity', s('showActivity'))}
        ${switchRow('appearOffline', s('appearOffline'))}
        ${switchRow('allowJoin', s('allowJoin'), s('allowJoinDesc'))}
        ${switchRow('receiveRequests', s('receiveRequests'))}
        ${sec(s('sectionInvites'))}
        ${choiceRow('partyInvites', s('partyInvites'))}
        ${choiceRow('privateMessages', s('privateMessages'), s('privateMessagesDesc'))}
        ${sec(s('sectionNotices'))}
        ${switchRow('onlineNotices', s('onlineNotices'))}
        ${switchRow('clanNotices', s('clanNotices'))}
        ${sec(s('sectionBlocked', { n: blocked.length }))}
        ${blocked.map(b => `<div class="fr-row">
            <span class="fr-head" style="${headStyle(headPath(b.uuid))}"></span>
            <span style="min-width:0"><span class="fr-name">${esc(b.name)}</span></span>
            <span class="fr-acts"><button class="fr-ghost is-shown" data-act="unblock" data-uuid="${esc(b.uuid)}" ${off()}>${esc(s('unblock'))}</button></span>
            ${noteSpan(b.uuid)}
        </div>`).join('') || `<p class="fd-empty">${esc(s('noBlocked'))}</p>`}`
}

/** One tick while a party member is away, none otherwise: "Offline for N min" ages without an event. */
function syncPartyTick(){
    const want = !!model.party?.members.some(m => m.where === 'away' && m.awaySince != null)
    if(want && !partyTick) partyTick = setInterval(render, PARTY_TICK_MS)
    else if(!want && partyTick){ clearInterval(partyTick); partyTick = null }
}

function render(){
    const online = model.onlineCount()
    $('fwOnline').textContent = t('onlineCount', { n: online })
    root.classList.toggle('is-stale', stale())
    const staleEl = $('fwStale')
    staleEl.hidden = !(model.stale || status.reason)
    staleEl.textContent = !status.session && status.reason && status.reason !== 'unavailable' && status.reason !== 'offline' ? t('noSession') : t('unavailable')
    for(const b of document.querySelectorAll('.fw-tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
    $('fwTools').hidden = tab !== 'friends'
    if($('fwSort').value !== sort) $('fwSort').value = sort
    body.innerHTML = tab === 'clan' ? clanTab() : tab === 'settings' ? settingsTab() : friendsTab()
    updateAdd()
    syncPartyTick()
}

function updateAdd(){
    const valid = NAME.test($('fwName').value.trim())
    $('fwPreview').classList.toggle('is-valid', valid)
    $('fwSend').disabled = !valid || !status.session
}

async function loadClan(){
    if(!status.session) return
    const res = await ipcRenderer.invoke('friends:clanMembers').catch(() => null)
    clan = res?.ok ? cleanClanMembers(res.data) : { failed: failText(res) }
    render()
}

async function loadSettings(){
    const res = await ipcRenderer.invoke('friends:getSettings').catch(() => null)
    if(res?.ok && res.data) model.setSettings(res.data)
}

function setTab(next){
    if(!TABS.includes(next)) return
    tab = next
    confirming = null
    partyConfirm = null
    render()
    // Each visit reads fresh: the clan has no live frames, and settings may have changed in game.
    if(tab === 'clan') loadClan()
    if(tab === 'settings') loadSettings()
}

/** A setting changed here: flipped at once, put back if the website says no. */
async function changeSetting(key, value){
    const before = model.settings[key]
    if(before === value) return
    model.setSettings({ [key]: value })
    const res = await ipcRenderer.invoke('friends:settings', { [key]: value })
    if(res?.ok && res.data) model.setSettings(res.data)
    else if(!res?.ok){
        model.setSettings({ [key]: before })
        note(`set:${key}`, failText(res))
    }
}

async function act(op, el){
    const uuid = el.dataset.uuid
    const partyId = el.dataset.party
    switch(op){
        case 'join':
        case 'challenge':
            await ipcRenderer.invoke('friends:act', op, uuid)
            break
        case 'invite': {
            const kind = model.inviteAction(uuid, inGame())
            if(kind === 'party') return partyInvite(uuid)
            if(kind === 'round'){
                const res = await ipcRenderer.invoke('friends:invite', uuid)
                if(res.ok){ invited.add(uuid); render() } else note(uuid, failText(res))
            }
            break
        }
        case 'clanParty': return partyInvite(uuid)
        case 'clanRequest': {
            const name = el.dataset.name
            if(!NAME.test(String(name))) return
            requested.add(uuid)
            render()
            const res = await ipcRenderer.invoke('friends:request', name)
            if(res.ok) note(uuid, t('requestSent', { name }), true)
            else { requested.delete(uuid); note(uuid, failText(res)) }
            break
        }
        case 'more':
            confirming = uuid
            render()
            break
        case 'cancel':
            confirming = null
            render()
            break
        case 'remove':
        case 'block': {
            if(confirming !== uuid) return
            confirming = null
            render()
            const res = await ipcRenderer.invoke(`friends:${op}`, uuid)
            if(!res.ok) note(uuid, failText(res))
            break
        }
        case 'accept':
        case 'decline':
        case 'cancelRequest':
        case 'unblock': {
            const res = await ipcRenderer.invoke(`friends:${op}`, uuid)
            if(!res.ok) note(uuid, failText(res))
            break
        }
        case 'pCreate': return partyCall('partyCreate', null, 'party')
        case 'pAccept': return partyCall('partyAccept', partyId, partyId)
        case 'pDecline': return partyCall('partyDecline', partyId, partyId)
        case 'pPromote': return partyCall('partyPromote', uuid, 'party')
        case 'pFollow':
            // The launcher window runs the follow (where the Play view is); a failure comes back as a party note.
            await ipcRenderer.invoke('friends:act', 'partyFollow', uuid)
            model.clearFollow()
            break
        case 'pKick': return confirmThen(`kick:${uuid}`, () => partyCall('partyKick', uuid, 'party'))
        case 'pLeave': return confirmThen('leave', () => partyCall('partyLeave', null, 'party'))
        case 'pDisband': return confirmThen('disband', () => partyCall('partyDisband', null, 'party'))
        case 'pWarp': {
            const res = await partyCall('partyWarp', null, 'party')
            if(res?.ok){
                const moved = Array.isArray(res.data?.moved) ? res.data.moved.length : 0
                const kept = Array.isArray(res.data?.keptBack) ? res.data.keptBack.length : 0
                note('party', s('warped', { moved, kept }), true)
            }
            break
        }
        case 'pCancel':
            partyConfirm = null
            render()
            break
    }
}

async function partyInvite(uuid){
    partyPending.add(uuid)
    render()
    const res = await ipcRenderer.invoke('friends:partyInvite', uuid)
    if(!res.ok){ partyPending.delete(uuid); note(uuid, failText(res)) }
}

/** Leave, Kick and Disband: the first click arms the button, the second on the same target does it. */
function confirmThen(target, run){
    const step = confirmStep(partyConfirm, target)
    partyConfirm = step.next
    if(step.confirmed) run()
    render()
}

/** A party change; the new party arrives as a `party` event, a failure shows as a note. */
async function partyCall(op, arg, noteKey){
    const res = await ipcRenderer.invoke(`friends:${op}`, ...(arg ? [arg] : []))
    if(!res?.ok) note(noteKey, failText(res))
    return res
}

const TWO_CLICK = new Set(['pLeave', 'pKick', 'pDisband', 'block', 'remove'])
body.addEventListener('click', e => {
    const set = e.target.closest('[data-set]')
    if(set){
        const key = set.dataset.set
        changeSetting(key, set.dataset.value ?? !model.settings[key])
        return
    }
    const b = e.target.closest('[data-act]')
    // A double-click must not arm and confirm in one go.
    if(b && e.detail > 1 && TWO_CLICK.has(b.dataset.act)) return
    if(b && !b.disabled) act(b.dataset.act, b)
    else if(!b && (confirming || partyConfirm)){ confirming = null; partyConfirm = null; render() }
})
$('fwTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]')
    if(b) setTab(b.dataset.tab)
})
$('fwSearch').addEventListener('input', e => {
    search = e.target.value
    render()
})
$('fwSort').addEventListener('change', e => {
    sort = cleanSort(e.target.value)
    render()
    // The launcher window keeps the choice in its config (friends.js), so it survives a restart.
    ipcRenderer.invoke('friends:prefs', { sort }).catch(() => {})
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
$('fwPin').addEventListener('click', async () => {
    const on = await ipcRenderer.invoke('friends:window', 'pin')
    $('fwPin').setAttribute('aria-pressed', String(!!on))
})
$('fwPutBack').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'putBack'))
$('fwMinimize').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'minimize'))
$('fwClose').addEventListener('click', () => ipcRenderer.invoke('friends:window', 'close'))
document.addEventListener('keydown', e => {
    if(e.key !== 'Escape') return
    if(confirming || partyConfirm){ confirming = null; partyConfirm = null; render(); return }
    if(document.activeElement === $('fwSearch') && search){ $('fwSearch').value = ''; search = ''; render(); return }
    ipcRenderer.invoke('friends:window', 'close')
})

ipcRenderer.on('friends:event', (_e, f) => {
    if(!f || typeof f.event !== 'string') return
    if(f.event === 'status'){ status = { session: !!f.session, live: !!f.live, reason: f.reason ?? null }; if(status.reason === 'unavailable' || status.reason === 'offline' || status.reason === 'gate') model.setStale(true); render(); return }
    if(f.event === 'releases'){ releases = Array.isArray(f.releases) ? f.releases : []; render(); return }
    if(f.event === 'launcher'){ launcherState = { busy: !!f.busy, release: f.release ?? null }; render(); return }
    if(f.event === 'prefs'){ sort = cleanSort(f.prefs?.sort); render(); return }
    if(f.event === 'window') return
    if(f.event === 'note'){ if(typeof f.text === 'string') note(String(f.scope), f.text); return }
    if(f.event === 'party') partyPending.clear()
    model.apply(f.event, f)
    // A clan request answered (accepted, declined or withdrawn) no longer needs its "Requested".
    if(f.event === 'view') for(const uuid of requested) if(!model.outgoingRequests().some(r => r.uuid === uuid)) requested.delete(uuid)
    // Kicked: say so once, as the party section's short note (this window's model is its own).
    if(model.partyKicked){ note('party', t('partyRemoved')); model.clearKicked() }
})
model.subscribe(render)

async function start(){
    status = { ...status, ...(await ipcRenderer.invoke('friends:status').catch(() => ({}))) }
    releases = (await ipcRenderer.invoke('friends:releases').catch(() => [])) || []
    sort = cleanSort((await ipcRenderer.invoke('friends:prefs').catch(() => null))?.sort)
    const view = await ipcRenderer.invoke('friends:view').catch(() => null)
    if(view?.data) model.load(view.data)
    if(view && !view.ok) model.setStale(view.stale === true || view.code === 'UNAVAILABLE')
    render()
    ipcRenderer.invoke('friends:poll').catch(() => {})
    ipcRenderer.invoke('friends:party').catch(() => {})
}
start()
window.addEventListener('unload', () => { if(partyTick){ clearInterval(partyTick); partyTick = null } })
