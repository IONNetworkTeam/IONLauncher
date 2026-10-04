/**
 * Friends in the main process: the launcher session, the client, the presence heartbeat and the
 * live channel, exposed to the renderer over the `friends:*` IPC surface. The renderer never
 * holds the session token; it sends the selected account (uuid, name and the Minecraft access
 * token, which goes to Mojang only) and gets back views, answers and pushed events.
 *
 * Renderer → main (`ipcRenderer.invoke`):
 *   friends:account {uuid, displayName, accessToken} | null   the selected account changed
 *   friends:signOut uuid                                       an account was removed
 *   friends:view                                               the whole FriendsView
 *   friends:request name · friends:accept uuid · friends:decline uuid · friends:remove uuid
 *   friends:block uuid · friends:unblock uuid · friends:settings patch
 *   friends:join uuid, inGame · friends:invite uuid · friends:dismissInvite uuid
 *   friends:presence {state, release}                          what the launcher is doing (presence.js)
 *   friends:poll                                               the presence poll, now (a window opened)
 *   friends:status                                             {account, session, live}
 *   friends:releases [list]                                    the launcher window's releases, for the friends window (no list: read them)
 *   friends:openWindow · friends:window op                    the friends window (friends.ejs): open; pin, putBack, minimize, close
 *   friends:act op, uuid                                       from the friends window: join, challenge or partyFollow, run in the launcher window
 *   friends:party · friends:partyCreate · friends:partyInvite uuid · friends:partyAccept partyId
 *   friends:partyDecline partyId · friends:partyLeave · friends:partyKick uuid · friends:partyPromote uuid
 *   friends:partyFollow                                        a JoinResult, like friends:join
 *
 * Main → renderer (`friends:event`, to every window): `{event, ...payload}` for the pushed events
 * of the contract (presence, request, request_resolved, friend_added, friend_removed, invite,
 * invite_expired), `snapshot` {friends} from the presence poll, `view` {view} after a change made
 * here, `status` {session, live, reason}, `window` {open} and `releases` {releases}. The launcher
 * window alone gets `friends:do` {op, uuid} for a Join, Challenge or Follow pressed in the friends window.
 * `party` {party, invites} follows every party answer, the start and each poll; the pushed party frames
 * arrive as party_invite, party_invite_expired, party_updated, party_disbanded and party_follow.
 *
 * Everything degrades: without a session the answers say NO_SESSION and nothing is retried in a
 * loop; a 503 keeps the last view; the Play button never waits for any of this.
 *
 * @module friends
 */
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { createSessionStore } = require('./session')
const { createFriendsApi } = require('./api')
const { createPresence } = require('./presence')
const { createLiveChannel } = require('./live')
const { createPartyHandlers } = require('./party')

const SESSION_FILE = 'friends-session.bin'
const NAME = /^[A-Za-z0-9_]{3,16}$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

let initialised = false
let hostWin = null
let friendsWin = null

/**
 * The message a pushed frame becomes for the renderer. Party frames reuse friends event names
 * (`invite`, `invite_expired`), so they travel as `party_<event>`. The name is set last, so the
 * frame's own `event` key can never override it.
 */
function rendererMessage(event, frame){
    const name = frame?.type === 'party' ? `party_${event}` : event
    return { ...frame, event: name }
}

/**
 * @param {Object} deps
 * @param {Electron.App} deps.app
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {typeof Electron.BrowserWindow} deps.BrowserWindow
 * @param {Electron.SafeStorage} deps.safeStorage
 * @param {{fetchJson: Function}} deps.webAuth webauth.js
 * @param {{url: string}} deps.web weburl.js, for the socket's address
 * @param {string} deps.appDir The `app` directory, for friends.ejs.
 * @param {Electron.BrowserWindow} deps.host The launcher window, where Join and Challenge run.
 * @param {Object} deps.logger
 */
function init({ app, ipcMain, BrowserWindow, safeStorage, webAuth, web, appDir, host, logger }){
    hostWin = host
    if(initialised) return
    initialised = true

    const file = () => path.join(app.getPath('userData'), SESSION_FILE)
    const session = createSessionStore({
        fetchJson: webAuth.fetchJson,
        fetchMojang: (url, init) => fetch(url, init),
        load: () => {
            try {
                if(fs.existsSync(file()) && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(fs.readFileSync(file()))
            } catch {
                // Unreadable or written on another machine: a new session is minted.
            }
            return null
        },
        save: text => {
            try {
                if(safeStorage.isEncryptionAvailable()) fs.writeFileSync(file(), safeStorage.encryptString(text), { mode: 0o600 })
            } catch(err) {
                logger.warn('Could not store the friends session; it is kept for this run only.', err)
            }
        },
        logger
    })

    let account = null
    let lastView = null
    let releases = []
    let status = { session: false, live: false, reason: null }

    const api = createFriendsApi({ fetchJson: webAuth.fetchJson, session, account: () => account, logger })

    /** Counts the pushed party events, so a GET /party that was in flight when one landed is dropped. */
    let partyEpoch = 0
    const party = createPartyHandlers({ api, note, broadcast, epoch: () => partyEpoch })
    /** The party, read again: on start and beside every presence poll, so a missed frame heals within a minute. */
    const refreshParty = () => { party.party().catch(() => {}) }

    function broadcast(event, payload = {}){
        for(const w of BrowserWindow.getAllWindows()){
            if(!w.isDestroyed()) w.webContents.send('friends:event', { ...payload, event })
        }
    }

    function setStatus(patch){
        const next = { ...status, ...patch }
        if(next.session === status.session && next.live === status.live && next.reason === status.reason) return
        status = next
        logger.info(`Friends: session ${status.session ? 'up' : 'down'}, live channel ${status.live ? 'up' : 'down'}${status.reason ? ` (${status.reason})` : ''}.`)
        broadcast('status', status)
    }

    /** Session and reachability, from a route's answer. */
    function note(res){
        if(res.ok){ setStatus({ session: true, reason: null }); return res }
        if(res.code === 'NO_SESSION') setStatus({ session: false, reason: res.reason ?? 'invalid' })
        // The session exists, but the site's password gate answers bearer requests: nothing to show, nothing to retry in a loop.
        else if(res.code === 'GATE') setStatus({ session: true, reason: 'gate' })
        else if(res.code === 'UNAVAILABLE' || res.code === 'OFFLINE') setStatus({ reason: res.code.toLowerCase() })
        return res
    }

    async function view(){
        const res = note(await api.view())
        if(res.ok){ lastView = res.data; return { ok: true, status: 200, data: lastView } }
        // Keep the last view on screen; the renderer greys its actions while `stale` is set.
        return { ...res, data: lastView, stale: lastView != null }
    }

    /** After a change made from here, every window gets the fresh view. */
    async function refresh(){
        const res = await view()
        if(res.ok) broadcast('view', { view: res.data })
    }

    const presence = createPresence({
        put: p => api.putPresence(p).then(note),
        logger
    })

    const live = createLiveChannel({
        ticket: () => api.wsTicket().then(note),
        poll: () => { refreshParty(); return api.presence().then(note) },
        url: web.url.replace(/^http/, 'ws') + '/api/launcher/friends/ws',
        onEvent: (event, frame) => {
            const msg = rendererMessage(event, frame)
            if(msg.event.startsWith('party_')) partyEpoch++
            logger.info(`Friends: ${msg.event} pushed.`)
            broadcast(msg.event, msg)
        },
        onSnapshot: friends => broadcast('snapshot', { friends }),
        onStatus: up => setStatus({ live: up }),
        logger
    })

    function stop(){
        presence.stop()
        live.stop()
        setStatus({ session: false, live: false })
    }

    async function start(){
        if(!account) return
        const first = await view()
        if(first.ok){ broadcast('view', { view: first.data }); refreshParty() }
        if(!account || first.code === 'NO_SESSION' || first.code === 'GATE') return
        presence.start()
        live.start()
    }

    function sanitizeAccount(a){
        if(!a || typeof a !== 'object') return null
        if(typeof a.uuid !== 'string' || !UUID.test(a.uuid) || typeof a.accessToken !== 'string' || !a.accessToken) return null
        if(typeof a.displayName !== 'string' || !NAME.test(a.displayName)) return null
        return { uuid: a.uuid, displayName: a.displayName, accessToken: a.accessToken }
    }

    /** The selected account changed (or its tokens were refreshed). */
    async function setAccount(next){
        const clean = sanitizeAccount(next)
        const switched = account?.uuid !== clean?.uuid
        if(switched){
            stop()
            if(account) presence.gone().catch(() => {})
            if(account) await session.end(account.uuid)
            lastView = null
            partyEpoch++
            broadcast('party', { party: null, invites: [] })
        }
        account = clean
        if(switched || !status.session) start().catch(err => logger.warn('Friends did not start.', err))
        return status
    }

    const guard = (uuidish) => typeof uuidish === 'string' && UUID.test(uuidish)
    const mutate = fn => async (...args) => {
        const res = note(await fn(...args))
        if(res.ok) refresh().catch(() => {})
        return res
    }
    const handlers = {
        account: (_e, a) => setAccount(a),
        signOut: async (_e, uuid) => {
            if(!guard(uuid)) return
            if(account?.uuid === uuid){ stop(); account = null; lastView = null; partyEpoch++; broadcast('party', { party: null, invites: [] }) }
            await session.end(uuid)
        },
        status: () => ({ ...status, account: account?.uuid ?? null }),
        view: () => view(),
        request: (_e, name) => NAME.test(String(name)) ? mutate(api.sendRequest)(String(name)) : { ok: false, status: 400, code: 'BAD_NAME', error: null },
        accept: (_e, uuid) => guard(uuid) ? mutate(api.accept)(uuid) : badUuid(),
        decline: (_e, uuid) => guard(uuid) ? mutate(api.decline)(uuid) : badUuid(),
        remove: (_e, uuid) => guard(uuid) ? mutate(api.remove)(uuid) : badUuid(),
        block: (_e, uuid) => guard(uuid) ? mutate(api.block)(uuid) : badUuid(),
        unblock: (_e, uuid) => guard(uuid) ? mutate(api.unblock)(uuid) : badUuid(),
        settings: (_e, patch) => {
            const clean = {}
            for(const k of ['showActivity', 'appearOffline', 'allowJoin', 'receiveRequests']){
                if(typeof patch?.[k] === 'boolean') clean[k] = patch[k]
            }
            return Object.keys(clean).length ? mutate(api.settings)(clean) : { ok: false, status: 400, code: 'BAD_REQUEST', error: null }
        },
        join: (_e, uuid, inGame) => guard(uuid) ? api.join(uuid, !!inGame).then(note) : badUuid(),
        invite: (_e, uuid) => guard(uuid) ? api.invite(uuid).then(note) : badUuid(),
        dismissInvite: (_e, uuid) => guard(uuid) ? mutate(api.dismissInvite)(uuid) : badUuid(),
        presence: (_e, p) => {
            if(!p || !['idle', 'playing'].includes(p.state)) return false
            presence.set(p.state, typeof p.release === 'string' ? p.release : null)
            // The friends window shows Invite only while the game runs.
            broadcast('launcher', { busy: p.state === 'playing', release: presence.release })
            return true
        },
        poll: () => live.running ? live.poll() : undefined,
        releases: (_e, list) => {
            if(Array.isArray(list)){
                releases = list.filter(r => r && typeof r.id === 'string').map(r => ({ id: r.id, name: String(r.name ?? r.id), net: !!r.net, accent: r.accent ?? null, playBg: typeof r.playBg === 'string' ? r.playBg : null }))
                broadcast('releases', { releases })
            }
            return releases
        },
        openWindow: () => openWindow(),
        window: (e, op) => {
            const w = BrowserWindow.fromWebContents(e.sender)
            if(!w || w !== friendsWin) return false
            if(op === 'pin'){ w.setAlwaysOnTop(!w.isAlwaysOnTop()); return w.isAlwaysOnTop() }
            if(op === 'minimize') w.minimize()
            else if(op === 'close' || op === 'putBack') w.close()
            return true
        },
        act: (e, op, uuid) => {
            if(BrowserWindow.fromWebContents(e.sender) !== friendsWin || !guard(uuid) || !['join', 'challenge', 'partyFollow'].includes(op)) return false
            const target = hostWin && !hostWin.isDestroyed() ? hostWin : BrowserWindow.getAllWindows().find(w => w !== friendsWin && !w.isDestroyed())
            target?.webContents.send('friends:do', { op, uuid })
            if(target && !target.isDestroyed()) target.focus()
            return !!target
        }
    }

    /** The friends window: one at a time, frameless, beside the launcher. */
    function openWindow(){
        if(friendsWin && !friendsWin.isDestroyed()){ friendsWin.focus(); return true }
        friendsWin = new BrowserWindow({
            width: 420, height: 720, minWidth: 360, minHeight: 480,
            frame: false, backgroundColor: '#0e0f14', show: false,
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        })
        friendsWin.removeMenu()
        friendsWin.loadURL(pathToFileURL(path.join(appDir, 'friends.ejs')).toString())
        friendsWin.once('ready-to-show', () => friendsWin?.show())
        friendsWin.on('closed', () => { friendsWin = null; broadcast('window', { open: false }) })
        broadcast('window', { open: true })
        return true
    }
    const badUuid = () => ({ ok: false, status: 400, code: 'BAD_REQUEST', error: null })
    Object.assign(handlers, party)
    for(const [name, fn] of Object.entries(handlers)) ipcMain.handle(`friends:${name}`, fn)

    // Best effort: the server forgets a silent launcher after 90 s anyway.
    app.on('before-quit', () => { if(account) presence.gone().catch(() => {}) })

    return { setAccount, view, stop }
}

module.exports = { init, SESSION_FILE, rendererMessage }
