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
                const mode = MODES[a.gamemode] || a.gamemode
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

module.exports = { createFriendsModel, cleanPresence, compareFriends, activityLine, ago, MODES, NAME, TEXTS }
