/**
 * The launcher session for the website's friends routes (main process only).
 *
 * The launcher has no account on the website. It proves that it holds the selected Microsoft
 * account with Mojang's own server-join handshake, once per account, and keeps the opaque session
 * token the website mints in return:
 *
 *   POST …/session/start {uuid, name}        → {serverId}
 *   POST sessionserver.mojang.com/…/join     {accessToken, selectedProfile, serverId}
 *   POST …/session/complete {uuid, serverId} → {token, expiresAt}
 *
 * The Minecraft access token goes to Mojang only, never to the website. The session token is kept
 * per account uuid, encrypted on disk beside the website login (`friends-session.bin`), and sent as
 * `Authorization: Bearer` on every other friends route (api.js). A 401 there means a new one has
 * to be minted; sign-out and account switches call DELETE and drop it.
 *
 * Everything that touches Electron or the network is injected, so the flow can be driven by tests
 * and by a plain Node script.
 *
 * @module friends/session
 */
const MOJANG_JOIN_URL = 'https://sessionserver.mojang.com/session/minecraft/join'
const START_PATH = '/api/launcher/friends/session/start'
const COMPLETE_PATH = '/api/launcher/friends/session/complete'
const SESSION_PATH = '/api/launcher/friends/session'
/** More than 5 handshakes a minute is a 429 on `start`; wait this long before the next try. */
const RATE_LIMIT_BACKOFF_MS = 60000
/** A token this close to its expiry is minted again rather than used. */
const EXPIRY_MARGIN_MS = 5 * 60000
const TOKEN = /^[0-9a-f]{64}$/i

const silent = { info(){}, warn(){}, error(){}, debug(){} }

/** Mojang wants the profile id without dashes. */
function undashed(uuid){
    return String(uuid).replace(/-/g, '').toLowerCase()
}

/**
 * @param {Object} deps
 * @param {(path: string, init?: {method?: string, body?: any, bearer?: string}) => Promise<{ok: boolean, status: number, data?: any}>} deps.fetchJson
 *        The website, through the basic-auth gate (webauth.fetchJson).
 * @param {(url: string, init: Object) => Promise<{status: number}>} deps.fetchMojang Plain fetch for Mojang's session server.
 * @param {() => (string|null)} [deps.load] The stored tokens, as the JSON string written by `save`.
 * @param {(text: string) => void} [deps.save]
 * @param {() => number} [deps.now]
 * @param {Object} [deps.logger]
 */
function createSessionStore({ fetchJson, fetchMojang, load = () => null, save = () => {}, now = Date.now, logger = silent }){
    /** uuid → { token, expiresAt } */
    let tokens = new Map()
    /** uuid → the mint in flight, so concurrent callers share one handshake. */
    const pending = new Map()
    let blockedUntil = 0

    try {
        const raw = load()
        const parsed = raw ? JSON.parse(raw) : null
        if(parsed && typeof parsed === 'object'){
            for(const [uuid, v] of Object.entries(parsed)){
                if(v && TOKEN.test(v.token) && Number.isFinite(v.expiresAt)) tokens.set(uuid, { token: v.token, expiresAt: v.expiresAt })
            }
        }
    } catch {
        tokens = new Map()
    }

    function persist(){
        try { save(JSON.stringify(Object.fromEntries(tokens))) } catch(err) { logger.warn('Could not store the friends session.', err) }
    }

    /** The usable token for an account, or null. */
    function get(uuid){
        const t = tokens.get(uuid)
        if(!t) return null
        if(t.expiresAt - EXPIRY_MARGIN_MS <= now()){
            tokens.delete(uuid)
            persist()
            return null
        }
        return t.token
    }

    function invalidate(uuid){
        if(tokens.delete(uuid)) persist()
    }

    /**
     * The handshake. Resolves to `{token}` or `{token: null, reason}` with one of `rate_limited`
     * (wait a minute), `mojang` (the Minecraft token was refused: the account needs a refresh),
     * `unavailable` (the website or its backend is down), `offline` (no answer at all) or
     * `invalid` (the website refused the account).
     */
    async function mint(account){
        if(!account?.uuid || !account.accessToken) return { token: null, reason: 'invalid' }
        if(blockedUntil > now()) return { token: null, reason: 'rate_limited' }
        let start
        try {
            start = await fetchJson(START_PATH, { method: 'POST', body: { uuid: account.uuid, name: account.displayName } })
        } catch(err) {
            logger.warn('Friends session: the website did not answer.', err)
            return { token: null, reason: 'offline' }
        }
        if(start.status === 429){
            blockedUntil = now() + RATE_LIMIT_BACKOFF_MS
            return { token: null, reason: 'rate_limited' }
        }
        if(start.status === 503) return { token: null, reason: 'unavailable' }
        if(!start.ok || typeof start.data?.serverId !== 'string'){
            logger.warn(`Friends session: start answered ${start.status}.`, start.data)
            return { token: null, reason: 'invalid' }
        }
        let join
        try {
            join = await fetchMojang(MOJANG_JOIN_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ accessToken: account.accessToken, selectedProfile: undashed(account.uuid), serverId: start.data.serverId })
            })
        } catch(err) {
            logger.warn('Friends session: Mojang did not answer.', err)
            return { token: null, reason: 'offline' }
        }
        if(join.status === 429){
            blockedUntil = now() + RATE_LIMIT_BACKOFF_MS
            return { token: null, reason: 'rate_limited' }
        }
        if(join.status < 200 || join.status >= 300){
            logger.warn(`Friends session: Mojang refused the join (${join.status}).`)
            return { token: null, reason: 'mojang' }
        }
        let done
        try {
            done = await fetchJson(COMPLETE_PATH, { method: 'POST', body: { uuid: account.uuid, serverId: start.data.serverId } })
        } catch(err) {
            logger.warn('Friends session: the website did not answer.', err)
            return { token: null, reason: 'offline' }
        }
        if(done.status === 429){
            blockedUntil = now() + RATE_LIMIT_BACKOFF_MS
            return { token: null, reason: 'rate_limited' }
        }
        if(done.status === 503) return { token: null, reason: 'unavailable' }
        if(!done.ok || !TOKEN.test(done.data?.token)){
            logger.warn(`Friends session: complete answered ${done.status}.`, done.data)
            return { token: null, reason: 'invalid' }
        }
        const expiresAt = Date.parse(done.data.expiresAt)
        tokens.set(account.uuid, { token: done.data.token.toLowerCase(), expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 30 * 86400000 })
        persist()
        logger.info('Friends session minted.')
        return { token: tokens.get(account.uuid).token }
    }

    /** The stored token, or a freshly minted one. Concurrent calls share one handshake. */
    function ensure(account){
        if(!account?.uuid) return Promise.resolve({ token: null, reason: 'invalid' })
        const have = get(account.uuid)
        if(have) return Promise.resolve({ token: have })
        if(pending.has(account.uuid)) return pending.get(account.uuid)
        const p = mint(account).finally(() => pending.delete(account.uuid))
        pending.set(account.uuid, p)
        return p
    }

    /** Tell the website the session is over and forget it. Failures are ignored: the token is dropped either way. */
    async function end(uuid){
        const token = tokens.get(uuid)?.token
        invalidate(uuid)
        if(!token) return
        try {
            await fetchJson(SESSION_PATH, { method: 'DELETE', bearer: token })
        } catch(err) {
            logger.warn('Friends session: could not end the session.', err)
        }
    }

    return {
        get,
        ensure,
        mint,
        invalidate,
        end,
        /** When the next handshake may be tried, 0 when not rate limited. */
        get blockedUntil(){ return blockedUntil },
        /** The accounts with a stored session (for tests and sign-out of every account). */
        accounts(){ return [...tokens.keys()] }
    }
}

module.exports = { createSessionStore, undashed, MOJANG_JOIN_URL, START_PATH, COMPLETE_PATH, SESSION_PATH, RATE_LIMIT_BACKOFF_MS }
