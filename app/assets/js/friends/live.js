/**
 * The live channel: one WebSocket per launcher to the website's `/api/launcher/friends/ws`, from
 * the main process (Node's global WebSocket), beside a slower poll that is a complete client on its
 * own.
 *
 *   → {type: "auth", ticket}                    ← {type: "auth_ok"} | {type: "auth_error", message}
 *   → {type: "subscribe", channel: "user:notifications"}
 *   → {type: "ping"} every 30 s                 ← {type: "pong"}
 *   ← {channel: "user:notifications", data: {type: "friends" | "party", event, …}}
 *
 * Frames whose `data.type` is "friends" or "party" are dispatched by `event`. The two types share
 * the names `invite` and `invite_expired`, so the caller tells them apart by `data.type`
 * (index.js renames party events to `party_<event>`). A ticket is single use
 * and short-lived, so one is fetched right before every connect. The socket reconnects with a
 * backoff from 1 s doubling to 30 s. The poll (`GET …/presence`) runs every 60 s regardless.
 *
 * @module friends/live
 */
const PING_MS = 30000
const POLL_MS = 60000
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
const CHANNEL = 'user:notifications'
/** The events dispatched, per `data.type`. A Map, so a type such as "__proto__" finds nothing. */
const EVENTS = new Map([
    ['friends', new Set(['presence', 'request', 'request_resolved', 'friend_added', 'friend_removed', 'invite', 'invite_expired'])],
    ['party', new Set(['invite', 'invite_expired', 'updated', 'disbanded', 'follow'])]
])

const silent = { info(){}, warn(){}, error(){} }

/**
 * @param {Object} deps
 * @param {() => Promise<{ok: boolean, data?: {ticket: string}}>} deps.ticket POST …/ws-ticket (api.js).
 * @param {() => Promise<{ok: boolean, data?: {friends: Array}}>} deps.poll GET …/presence (api.js).
 * @param {string} deps.url The socket's address.
 * @param {(event: string, frame: Object) => void} deps.onEvent A friends event from the socket.
 * @param {(friends: Array) => void} deps.onSnapshot The poll's answer.
 * @param {(up: boolean) => void} [deps.onStatus] Whether the socket is authenticated right now.
 * @param {Function} [deps.WebSocket] The WebSocket class (Node's global one).
 * @param {Object} [deps.timers] setTimeout/clearTimeout/setInterval/clearInterval, for tests.
 * @param {Object} [deps.logger]
 */
function createLiveChannel({ ticket, poll, url, onEvent, onSnapshot, onStatus = () => {}, WebSocket: WS = globalThis.WebSocket, timers = {}, logger = silent }){
    const t = { setTimeout, clearTimeout, setInterval, clearInterval, ...timers }
    let running = false
    let socket = null
    let authed = false
    let backoff = MIN_BACKOFF_MS
    let reconnectTimer = null
    let pingTimer = null
    let pollTimer = null
    let generation = 0

    function send(frame){
        try { socket?.send(JSON.stringify(frame)) } catch(err) { logger.warn('Live channel: could not send.', err) }
    }

    function setAuthed(up){
        if(authed === up) return
        authed = up
        onStatus(up)
    }

    function stopPing(){
        if(pingTimer != null) t.clearInterval(pingTimer)
        pingTimer = null
    }

    function scheduleReconnect(){
        if(!running || reconnectTimer != null) return
        const wait = backoff
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
        logger.info(`Live channel: reconnecting in ${wait / 1000} s.`)
        reconnectTimer = t.setTimeout(() => { reconnectTimer = null; connect() }, wait)
    }

    function closeSocket(){
        stopPing()
        setAuthed(false)
        const s = socket
        socket = null
        if(s){
            s.onopen = s.onmessage = s.onclose = s.onerror = null
            try { s.close() } catch { /* already closed */ }
        }
    }

    function onFrame(raw){
        let frame
        try { frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
        if(!frame || typeof frame !== 'object') return
        if(frame.type === 'auth_ok'){
            logger.info('Live channel: authenticated.')
            backoff = MIN_BACKOFF_MS
            setAuthed(true)
            send({ type: 'subscribe', channel: CHANNEL })
            stopPing()
            pingTimer = t.setInterval(() => send({ type: 'ping' }), PING_MS)
            return
        }
        if(frame.type === 'auth_error'){
            logger.warn(`Live channel: ticket refused (${frame.message ?? 'no reason'}).`)
            closeSocket()
            scheduleReconnect()
            return
        }
        if(frame.type === 'pong' || frame.type === 'subscribed') return
        const data = frame.data
        if(frame.channel !== CHANNEL || !data) return
        if(!EVENTS.get(data.type)?.has(data.event)) return
        onEvent(data.event, data)
    }

    async function connect(){
        if(!running || socket) return
        const mine = ++generation
        let res
        try {
            res = await ticket()
        } catch(err) {
            res = { ok: false, error: String(err) }
        }
        if(!running || mine !== generation) return
        if(!res.ok || typeof res.data?.ticket !== 'string'){
            // No session, or the backend is down: the poll is the client until the next try.
            scheduleReconnect()
            return
        }
        let s
        try {
            s = new WS(url)
        } catch(err) {
            logger.warn('Live channel: could not open the socket.', err)
            scheduleReconnect()
            return
        }
        socket = s
        s.onopen = () => send({ type: 'auth', ticket: res.data.ticket })
        s.onmessage = e => onFrame(e.data)
        s.onerror = () => { /* onclose follows */ }
        s.onclose = () => {
            if(socket !== s) return
            closeSocket()
            scheduleReconnect()
        }
    }

    async function pollOnce(){
        try {
            const res = await poll()
            if(res.ok && Array.isArray(res.data?.friends)) onSnapshot(res.data.friends)
        } catch(err) {
            logger.warn('Presence poll failed.', err)
        }
    }

    function start(){
        if(running) return
        running = true
        backoff = MIN_BACKOFF_MS
        connect()
        pollTimer = t.setInterval(pollOnce, POLL_MS)
    }

    function stop(){
        running = false
        generation++
        if(reconnectTimer != null) t.clearTimeout(reconnectTimer)
        reconnectTimer = null
        if(pollTimer != null) t.clearInterval(pollTimer)
        pollTimer = null
        closeSocket()
    }

    return {
        start,
        stop,
        /** The poll, now: used when the friends window opens. */
        poll: pollOnce,
        get connected(){ return authed },
        get running(){ return running }
    }
}

module.exports = { createLiveChannel, PING_MS, POLL_MS, MIN_BACKOFF_MS, MAX_BACKOFF_MS, CHANNEL }
