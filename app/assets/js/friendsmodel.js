/**
 * The friends model the renderer draws from: a `FriendsView` from the website, kept current by the
 * pushed events and the presence poll, with everything the strip and the window derive from it.
 * Pure: no DOM, no IPC, so it can be tested on its own. The main process (friends/index.js) is
 * the only thing that talks to the website.
 *
 * @module friendsmodel
 */
const { since } = require('./panelformat')

/** The sections of the window, in order; `online` sits in the launcher section. */
const STATUS_ORDER = { playing: 0, launcher: 1, online: 1, offline: 2 }
const MODES = {
    bowbash: 'Bowbash',
    crystalhunt: 'CrystalHunt',
    bedwars: 'Bedwars',
    piratecraft: 'PirateCraft',
    ionjumps: 'IONJumps'
}
const NAME = /^[A-Za-z0-9_]{3,16}$/
const EMPTY_SETTINGS = { showActivity: true, appearOffline: false, allowJoin: true, receiveRequests: true }
const PARTY_WHERE = ['launcher', 'network', 'away']
const ENDED_KEPT = 32
/** The strip's "Disbands in N min" line shows once the party has been idle this long (the store reaps at 15). */
const IDLE_WARN_MS = 10 * 60000
const TOAST_MIN_MS = 5000
const TOAST_MAX_MS = 60000
/** How often both renderers redraw a party so "Disbands in N min" counts down. */
const PARTY_TICK_MS = 30000
/** A member's `where` -> the language key of its label (friends.<key>); shared by the strip card and the window. */
const PARTY_WHERE_KEYS = { launcher: 'whereLauncher', network: 'whereNetwork', away: 'whereAway' }
/** The leader's crown, shared by the strip bracket and the window. */
const CROWN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 7.5l4.6 4L12 4l4.4 7.5L21 7.5 19.2 18H4.8z"/></svg>'

const isObj = v => v && typeof v === 'object'

/** A friend as the website sends it, reduced to what the UI reads; anything odd is dropped. */
function cleanPresence(p){
    const a = isObj(p?.activity) ? p.activity : null
    const status = ['offline', 'launcher', 'online', 'playing'].includes(p?.status) ? p.status : 'offline'
    return {
        status,
        since: typeof p?.since === 'string' ? p.since : null,
        lastOnline: typeof p?.lastOnline === 'string' ? p.lastOnline : null,
        activity: a && (a.kind === 'network' || a.kind === 'pack') ? {
            kind: a.kind,
            gamemode: typeof a.gamemode === 'string' ? a.gamemode : null,
            inMatch: !!a.inMatch,
            phase: ['lobby', 'match', 'podium'].includes(a.phase) ? a.phase : null,
            matchId: typeof a.matchId === 'string' ? a.matchId : null,
            release: typeof a.release === 'string' ? a.release : null
        } : null,
        join: {
            play: !!p?.join?.play,
            spectate: !!p?.join?.spectate,
            reason: typeof p?.join?.reason === 'string' ? p.join.reason : null
        }
    }
}

function cleanFriend(f){
    if(!isObj(f) || typeof f.uuid !== 'string' || typeof f.name !== 'string') return null
    return { uuid: f.uuid, name: f.name, bedrock: !!f.bedrock, headUrl: typeof f.headUrl === 'string' ? f.headUrl : null, presence: cleanPresence(f.presence) }
}

function cleanRequest(r){
    if(!isObj(r) || typeof r.uuid !== 'string' || typeof r.name !== 'string') return null
    return { uuid: r.uuid, name: r.name, headUrl: typeof r.headUrl === 'string' ? r.headUrl : null, direction: r.direction === 'outgoing' ? 'outgoing' : 'incoming', sentAt: typeof r.sentAt === 'string' ? r.sentAt : null }
}

function cleanInvite(i){
    if(!isObj(i) || !isObj(i.from) || typeof i.from.uuid !== 'string') return null
    return {
        from: { uuid: i.from.uuid, name: typeof i.from.name === 'string' ? i.from.name : '', headUrl: typeof i.from.headUrl === 'string' ? i.from.headUrl : null },
        activity: cleanPresence({ activity: i.activity }).activity,
        expiresAt: typeof i.expiresAt === 'string' ? i.expiresAt : null
    }
}

function cleanSettings(s){
    const out = { ...EMPTY_SETTINGS }
    for(const k of Object.keys(EMPTY_SETTINGS)) if(typeof s?.[k] === 'boolean') out[k] = s[k]
    return out
}

const str = v => typeof v === 'string' ? v : null
const list = v => Array.isArray(v) ? v : []
/** The same player, dashed or not, any case. */
const uid = v => String(v ?? '').replace(/-/g, '').toLowerCase()

/** A server time: ISO-8601 text (the contract) or epoch ms both read as ms; anything else is null. */
function toMs(v){
    if(typeof v === 'number') return Number.isFinite(v) ? v : null
    if(typeof v === 'string'){ const t = Date.parse(v); return Number.isFinite(t) ? t : null }
    return null
}

function cleanPartyMember(m){
    if(!isObj(m) || typeof m.uuid !== 'string' || typeof m.name !== 'string') return null
    return { uuid: m.uuid, name: m.name, headUrl: str(m.headUrl), leader: !!m.leader, where: PARTY_WHERE.includes(m.where) ? m.where : 'away', presence: cleanPresence(m.presence) }
}

/** A PartyView as the website sends it; members leader first, then in the server's order. `version` is the store snapshot version. */
function cleanPartyView(p){
    if(!isObj(p) || typeof p.id !== 'string') return null
    const members = list(p.members).map(cleanPartyMember).filter(Boolean)
    const leader = typeof p.leader === 'string' ? p.leader : (members.find(m => m.leader)?.uuid ?? null)
    const ordered = members.map(m => ({ ...m, leader: leader != null && uid(m.uuid) === uid(leader) }))
        .sort((a, b) => Number(b.leader) - Number(a.leader))
    return {
        id: p.id,
        version: Number.isFinite(p.version) ? p.version : null,
        leader,
        private: !!p.private,
        createdAt: toMs(p.createdAt),
        lastActivity: toMs(p.lastActivity),
        idleDisbandAt: toMs(p.idleDisbandAt),
        members: ordered,
        invites: list(p.invites).filter(i => isObj(i) && typeof i.uuid === 'string').map(i => ({ uuid: i.uuid, name: typeof i.name === 'string' ? i.name : '', expiresAt: toMs(i.expiresAt) }))
    }
}

/** A PartyInviteView: an invite addressed to me. */
function cleanPartyInvite(i){
    if(!isObj(i) || typeof i.partyId !== 'string' || !isObj(i.from) || typeof i.from.uuid !== 'string') return null
    return {
        partyId: i.partyId,
        from: { uuid: i.from.uuid, name: typeof i.from.name === 'string' ? i.from.name : '', headUrl: str(i.from.headUrl) },
        members: Number.isInteger(i.members) && i.members > 0 ? i.members : 1,
        expiresAt: toMs(i.expiresAt)
    }
}

/**
 * The `follow` frame: the leader went somewhere, I am in the launcher. `where` is the public
 * gamemode key ('lobby' for the hub, 'network' when unknown) and the release; only those two
 * keys are copied, so nothing else the frame might carry is ever kept.
 */
function cleanFollow(f){
    if(!isObj(f) || typeof f.partyId !== 'string' || !isObj(f.leader) || typeof f.leader.uuid !== 'string') return null
    const where = isObj(f.where) ? f.where : {}
    return {
        partyId: f.partyId,
        leader: { uuid: f.leader.uuid, name: typeof f.leader.name === 'string' ? f.leader.name : '' },
        where: { gamemode: str(where.gamemode) || 'network', release: str(where.release) }
    }
}

/** The language key for a member's `where`; anything unknown reads as away. */
function partyWhereKey(where){
    return typeof where === 'string' && Object.hasOwn(PARTY_WHERE_KEYS, where) ? PARTY_WHERE_KEYS[where] : PARTY_WHERE_KEYS.away
}

/** A gamemode key from the wire as a label; an unknown key is shown as sent. `Object.hasOwn` keeps "__proto__" and friends from matching. */
function modeLabel(gamemode){
    return Object.hasOwn(MODES, gamemode) ? MODES[gamemode] : gamemode
}

/**
 * Whole minutes until the idle disband, once the party has been idle 10 min (at least 1: when
 * overdue the reaper is on its way); otherwise null.
 */
function idleDisbandMinutes(party, now = Date.now()){
    if(!party || party.lastActivity == null || party.idleDisbandAt == null) return null
    if(now - party.lastActivity < IDLE_WARN_MS) return null
    return Math.max(1, Math.ceil((party.idleDisbandAt - now) / 60000))
}

/**
 * The two-click confirm (Leave, Kick): the first click on a target arms it, the second on the
 * same target confirms. A click on another target re-arms. Returns the new armed value.
 */
function confirmStep(armed, target){
    return armed === target ? { confirmed: true, next: null } : { confirmed: false, next: target }
}

/**
 * How long the party invite toast stays: until `expiresAt`, but never under 5 s or over 60 s,
 * so a launcher clock that is off by minutes neither flashes it nor keeps it forever.
 */
function toastMs(expiresAt, now = Date.now()){
    if(expiresAt == null) return TOAST_MAX_MS
    return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS, expiresAt - now))
}

/**
 * Where the follow toast says the leader went: the mode's label, the hub, or the network. The
 * frame carries a public gamemode key, never a server name.
 */
function followPlace(where, texts){
    const g = where?.gamemode
    if(typeof g !== 'string' || !g || g === 'network') return texts.network
    if(g === 'lobby') return texts.hub
    return modeLabel(g)
}

/** playing → launcher (and online) → offline, then by name. */
function compareFriends(a, b){
    const d = (STATUS_ORDER[a.presence.status] ?? 3) - (STATUS_ORDER[b.presence.status] ?? 3)
    return d !== 0 ? d : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/** '· 12 min' material: how long the current activity has run. */
function ago(iso, now = Date.now()){
    if(!iso) return ''
    const t = Date.parse(iso)
    if(!Number.isFinite(t)) return ''
    const min = Math.max(0, Math.round((now - t) / 60000))
    if(min < 1) return 'now'
    if(min < 60) return `${min} min`
    const h = Math.floor(min / 60)
    if(h < 48) return `${h} h`
    return `${Math.floor(h / 24)} d`
}

/**
 * What the row under a friend's name says.
 *
 * @param {Object} presence
 * @param {(releaseId: string) => (string|null)} releaseName The distribution name of a release id.
 * @param {Object} [t] Texts: inTheLauncher, online, inTheHub, inAMatch, lobby, podium, network, playing, lastOnline(when), offline.
 */
function activityLine(presence, releaseName = () => null, t = TEXTS, now = Date.now()){
    const a = presence.activity
    switch(presence.status){
        case 'launcher': return t.inTheLauncher
        case 'online': return t.online
        case 'offline': {
            if(!presence.lastOnline) return t.offline
            const when = since(presence.lastOnline, now)
            return when === 'never' ? t.offline : t.lastOnline(when === 'today' || when === 'yesterday' ? when : `${when} ago`)
        }
        case 'playing': {
            if(a?.kind === 'pack') return (a.release && releaseName(a.release)) || t.playing
            if(a?.kind === 'network'){
                if(!a.gamemode || a.gamemode === 'lobby') return t.inTheHub
                const mode = modeLabel(a.gamemode)
                const where = a.inMatch ? t.inAMatch : a.phase === 'podium' ? t.podium : t.lobby
                return `${mode} · ${where}`
            }
            return t.playing
        }
        default: return ''
    }
}

/** English fallbacks; the UI hands in the language file's texts. */
const TEXTS = {
    inTheLauncher: 'In the launcher',
    online: 'Online',
    inTheHub: 'In the hub',
    inAMatch: 'in a match',
    lobby: 'lobby',
    podium: 'on the podium',
    playing: 'Playing',
    offline: 'Offline',
    lastOnline: when => `Last online ${when}`
}

function createFriendsModel(){
    let me = null
    let friends = new Map()
    let requests = []
    let invites = []
    let settings = { ...EMPTY_SETTINGS }
    let blocked = []
    let loaded = false
    let stale = false
    let party = null            // PartyView | null
    let partyInvites = []       // [PartyInviteView], addressed to me
    let partyFollow = null      // the last follow frame, until answered
    let partyKicked = null      // the id of the party I was just kicked from, until the note is shown
    const ended = new Map()     // party id -> last version held, for the last ENDED_KEPT parties that ended

    /** My party ended (or lost me): remember it so a late, older view of it cannot bring it back. */
    function endParty(){
        if(!party) return
        ended.delete(party.id)
        ended.set(party.id, party.version ?? -1)
        while(ended.size > ENDED_KEPT) ended.delete(ended.keys().next().value)
        party = null
        partyFollow = null
    }
    /** A view older than what I hold for that party is a late frame: ignore it. */
    function staleView(p){
        return !!party && party.id === p.id && p.version != null && party.version != null && p.version < party.version
    }
    const listeners = new Set()

    function emit(){ for(const fn of listeners) fn(api) }

    /** A whole FriendsView replaces everything. */
    function load(view){
        if(!isObj(view)) return
        me = isObj(view.me) ? { uuid: view.me.uuid, presence: cleanPresence(view.me.presence) } : null
        friends = new Map((Array.isArray(view.friends) ? view.friends : []).map(cleanFriend).filter(Boolean).map(f => [f.uuid, f]))
        requests = (Array.isArray(view.requests) ? view.requests : []).map(cleanRequest).filter(Boolean)
        invites = (Array.isArray(view.invites) ? view.invites : []).map(cleanInvite).filter(Boolean)
        settings = cleanSettings(view.settings)
        blocked = (Array.isArray(view.blocked) ? view.blocked : []).filter(b => isObj(b) && typeof b.uuid === 'string').map(b => ({ uuid: b.uuid, name: String(b.name ?? '') }))
        loaded = true
        stale = false
        emit()
    }

    /** A pushed event, by the contract's `event` names, plus `view` and `snapshot` from the main process. */
    function apply(event, frame = {}){
        switch(event){
            case 'view': return load(frame.view)
            case 'presence': {
                const f = friends.get(frame.friend?.uuid)
                if(!f) return
                f.presence = cleanPresence(frame.friend.presence)
                break
            }
            case 'snapshot': {
                let changed = false
                for(const item of Array.isArray(frame.friends) ? frame.friends : []){
                    const f = friends.get(item?.uuid)
                    if(!f) continue
                    f.presence = cleanPresence(item.presence)
                    changed = true
                }
                if(!changed) return
                break
            }
            case 'request': {
                const r = cleanRequest(frame.request)
                if(!r) return
                requests = requests.filter(x => x.uuid !== r.uuid).concat(r)
                break
            }
            case 'request_resolved':
                requests = requests.filter(x => x.uuid !== frame.uuid)
                break
            case 'friend_added': {
                const f = cleanFriend(frame.friend)
                if(!f) return
                friends.set(f.uuid, f)
                requests = requests.filter(x => x.uuid !== f.uuid)
                break
            }
            case 'friend_removed':
                if(!friends.delete(frame.uuid)) return
                break
            case 'invite': {
                const i = cleanInvite(frame.invite)
                if(!i) return
                invites = invites.filter(x => x.from.uuid !== i.from.uuid).concat(i)
                break
            }
            case 'invite_expired':
                invites = invites.filter(x => x.from.uuid !== frame.from)
                break
            case 'party': {
                // A PartyResponse from the main process: GET /party, or the answer to a change made here.
                const p = cleanPartyView(frame.party)
                partyInvites = list(frame.invites).map(cleanPartyInvite).filter(Boolean)
                if(!p){
                    if(party) endParty()
                    partyFollow = null
                } else if(!staleView(p)){
                    // An answer from the website (or to my own change) may show an ended party again.
                    if(party && party.id !== p.id) endParty()
                    party = p
                    ended.delete(p.id)
                    partyKicked = null
                }
                break
            }
            case 'party_invite': {
                const i = cleanPartyInvite(frame.invite)
                if(!i) return
                partyInvites = partyInvites.filter(x => x.partyId !== i.partyId).concat(i)
                break
            }
            case 'party_invite_expired': {
                const before = partyInvites.length
                partyInvites = partyInvites.filter(x => x.partyId !== frame.partyId)
                if(partyInvites.length === before) return
                break
            }
            case 'party_updated': {
                const p = cleanPartyView(frame.party)
                // A pushed view of a party that ended is a late frame whatever its version: only a `party` response revives it.
                if(!p || ended.has(p.id) || staleView(p)) return
                if(me?.uuid && !p.members.some(m => uid(m.uuid) === uid(me.uuid))){
                    // Safety net: my party, without me. The removed member normally gets a
                    // `disbanded` (left | kicked) frame instead. Any other party is not mine to show.
                    if(party?.id !== p.id) return
                    endParty()
                    break
                }
                party = p
                ended.delete(p.id)
                partyKicked = null
                partyInvites = partyInvites.filter(x => x.partyId !== p.id)
                break
            }
            case 'party_disbanded': {
                // To every former member (idle, empty, ...), and to a removed member alone
                // with reason "left" or "kicked" while the party goes on without them.
                const mine = party?.id === frame.partyId
                const before = partyInvites.length
                partyInvites = partyInvites.filter(x => x.partyId !== frame.partyId)
                if(mine){
                    endParty()
                    // Removed against my will: kicked, or the leader kicked everyone. Not idle/empty/admin.
                    if(frame.reason === 'kicked' || frame.reason === 'kicked_all') partyKicked = frame.partyId
                }
                if(!mine && partyInvites.length === before) return
                break
            }
            case 'party_follow': {
                const f = cleanFollow(frame)
                if(!f || uid(f.leader.uuid) === uid(me?.uuid) || party?.id !== f.partyId) return
                partyFollow = f
                break
            }
            default: return
        }
        emit()
    }

    /** The website could not be read: keep what is on screen, say so. */
    function setStale(v){
        if(stale === !!v) return
        stale = !!v
        emit()
    }

    /** Settings flipped locally before the website confirms, so the switch answers at once. */
    function setSettings(patch){
        settings = cleanSettings({ ...settings, ...patch })
        emit()
    }

    function sorted(){ return [...friends.values()].sort(compareFriends) }

    const api = {
        load,
        apply,
        setStale,
        setSettings,
        subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn) },
        get loaded(){ return loaded },
        get stale(){ return stale },
        get me(){ return me },
        get settings(){ return settings },
        get requests(){ return requests.slice() },
        get invites(){ return invites.slice() },
        get blocked(){ return blocked.slice() },
        get party(){ return party },
        get partyInvites(){ return partyInvites.slice() },
        get partyFollow(){ return partyFollow },
        /** The follow toast was answered or put off. */
        clearFollow(){ if(!partyFollow) return; partyFollow = null; emit() },
        get partyKicked(){ return partyKicked },
        /** The "You were removed from the party" note was shown. */
        clearKicked(){ if(!partyKicked) return; partyKicked = null; emit() },
        isMe: uuid => !!me?.uuid && uid(uuid) === uid(me.uuid),
        isInMyParty: uuid => !!party?.members.some(m => uid(m.uuid) === uid(uuid)),
        amLeader: () => !!party && party.leader != null && !!me?.uuid && uid(party.leader) === uid(me.uuid),
        /** My party has a live invite out for this player. */
        invitedToMyParty: uuid => !!party?.invites.some(i => uid(i.uuid) === uid(uuid)),
        /** Whole minutes until the idle disband, once the party has been idle 10 min; otherwise null. */
        idleDisbandIn: (now = Date.now()) => idleDisbandMinutes(party, now),
        /**
         * What Invite does for a friend. While I am in a round, friends in the launcher get the
         * round invite ("come where I am"), as before, even if already in my party. Otherwise
         * anyone not offline and not already in my party gets a party invite, if I lead the
         * party or have none.
         */
        inviteAction(uuid, inRound){
            const f = friends.get(uuid)
            if(!f) return null
            const st = f.presence.status
            if(st === 'offline') return null
            if(inRound && (st === 'launcher' || st === 'online')) return 'round'
            if(api.isInMyParty(uuid)) return null
            if(party && !api.amLeader()) return null
            return 'party'
        },
        /** The one toast to show: a party invite, the kicked note, a follow, then a round invite, skipping dismissed keys. */
        pickToast(dismissed = new Set()){
            for(const i of partyInvites){
                const key = `party:${i.partyId}`
                if(!dismissed.has(key)) return { kind: 'party', key, item: i }
            }
            if(partyKicked){
                const key = `kicked:${partyKicked}`
                if(!dismissed.has(key)) return { kind: 'kicked', key, item: { partyId: partyKicked } }
            }
            if(partyFollow){
                // A move to another mode (or release) is a new key, so it shows again.
                const key = `follow:${partyFollow.partyId}:${partyFollow.where.gamemode}:${partyFollow.where.release ?? ''}`
                if(!dismissed.has(key)) return { kind: 'follow', key, item: partyFollow }
            }
            for(const i of invites){
                const key = `round:${i.from.uuid}`
                if(!dismissed.has(key)) return { kind: 'round', key, item: i }
            }
            return null
        },
        friends: sorted,
        friend: uuid => friends.get(uuid) ?? null,
        /** The window's three sections. */
        sections(){
            const all = sorted()
            return {
                playing: all.filter(f => f.presence.status === 'playing'),
                launcher: all.filter(f => f.presence.status === 'launcher' || f.presence.status === 'online'),
                offline: all.filter(f => f.presence.status === 'offline')
            }
        },
        /** Friends who are not offline; 0 while I appear offline myself. */
        onlineCount(){
            if(settings.appearOffline) return 0
            return [...friends.values()].filter(f => f.presence.status !== 'offline').length
        },
        /** gamemode → how many friends play it right now, for the badges on the mode tiles. */
        modeCounts(){
            const counts = {}
            for(const f of friends.values()){
                const a = f.presence.activity
                if(f.presence.status !== 'playing' || a?.kind !== 'network' || !a.gamemode || a.gamemode === 'lobby') continue
                counts[a.gamemode] = (counts[a.gamemode] || 0) + 1
            }
            return counts
        },
        /** Friends playing a release right now: `releaseId` for a pack, the network release's id for the network. */
        playingOn(releaseId, networkReleaseId){
            return sorted().filter(f => {
                const a = f.presence.activity
                if(f.presence.status !== 'playing' || !a) return false
                return a.kind === 'network' ? releaseId === networkReleaseId : a.release === releaseId
            })
        },
        incomingRequests(){ return requests.filter(r => r.direction === 'incoming') },
        outgoingRequests(){ return requests.filter(r => r.direction === 'outgoing') }
    }
    return api
}

module.exports = { createFriendsModel, cleanPresence, compareFriends, activityLine, ago, toMs, toastMs, followPlace, modeLabel, partyWhereKey, idleDisbandMinutes, confirmStep, cleanPartyView, cleanPartyInvite, CROWN_SVG, PARTY_TICK_MS, PARTY_WHERE_KEYS, MODES, NAME, TEXTS }
