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
 *
 * Main → renderer (`friends:event`, to every window): `{event, ...payload}` for the pushed events
 * of the contract (presence, request, request_resolved, friend_added, friend_removed, invite,
 * invite_expired), `snapshot` {friends} from the presence poll, `view` {view} after a change made
 * here, and `status` {session, live, reason}.
 *
 * Everything degrades: without a session the answers say NO_SESSION and nothing is retried in a
 * loop; a 503 keeps the last view; the Play button never waits for any of this.
 *
 * @module friends
 */
const fs = require('fs')
const path = require('path')
const { createSessionStore } = require('./session')
const { createFriendsApi } = require('./api')
const { createPresence } = require('./presence')
const { createLiveChannel } = require('./live')

const SESSION_FILE = 'friends-session.bin'
const NAME = /^[A-Za-z0-9_]{3,16}$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

let initialised = false

/**
 * @param {Object} deps
 * @param {Electron.App} deps.app
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {typeof Electron.BrowserWindow} deps.BrowserWindow
 * @param {Electron.SafeStorage} deps.safeStorage
 * @param {{fetchJson: Function}} deps.webAuth webauth.js
 * @param {{url: string}} deps.web weburl.js, for the socket's address
 * @param {Object} deps.logger
 */
function init({ app, ipcMain, BrowserWindow, safeStorage, webAuth, web, logger }){
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
    let status = { session: false, live: false, reason: null }

    const api = createFriendsApi({ fetchJson: webAuth.fetchJson, session, account: () => account, logger })

    function broadcast(event, payload = {}){
        for(const w of BrowserWindow.getAllWindows()){
            if(!w.isDestroyed()) w.webContents.send('friends:event', { event, ...payload })
        }
    }

    function setStatus(patch){
        const next = { ...status, ...patch }
        if(next.session === status.session && next.live === status.live && next.reason === status.reason) return
        status = next
        broadcast('status', status)
    }

    /** Session and reachability, from a route's answer. */
    function note(res){
        if(res.ok){ setStatus({ session: true, reason: null }); return res }
        if(res.code === 'NO_SESSION') setStatus({ session: false, reason: res.reason ?? 'invalid' })
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
        poll: () => api.presence().then(note),
        url: web.url.replace(/^http/, 'ws') + '/api/launcher/friends/ws',
        onEvent: (event, frame) => broadcast(event, frame),
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
        if(first.ok) broadcast('view', { view: first.data })
        if(!account || first.code === 'NO_SESSION') return
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
            if(account?.uuid === uuid){ stop(); account = null; lastView = null }
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
            return true
        },
        poll: () => live.running ? live.poll() : undefined
    }
    const badUuid = () => ({ ok: false, status: 400, code: 'BAD_REQUEST', error: null })
    for(const [name, fn] of Object.entries(handlers)) ipcMain.handle(`friends:${name}`, fn)

    // Best effort: the server forgets a silent launcher after 90 s anyway.
    app.on('before-quit', () => { if(account) presence.gone().catch(() => {}) })

    return { setAccount, view, stop }
}

module.exports = { init, SESSION_FILE }
