/**
 * Verifying the selected Minecraft account for the ION account signed in on the website, without
 * `/register` in game (main process only).
 *
 * The launcher holds both halves: the Minecraft session, and the website login in the web tabs'
 * `ion_session` cookie. It proves the first to the website with Mojang's server-join handshake:
 *
 *   POST /api/launcher/account/link/start     {session}                                → {challenge, username}
 *        the renderer asks the player: link <Minecraft name> to <username>?
 *   POST sessionserver.mojang.com/…/join      {accessToken, selectedProfile, serverId: sha1(prefix + challenge)}
 *   POST /api/launcher/account/link/complete  {session, challenge, name, confirmTransfer} → {linked, minecraftName}
 *
 * The website asks Mojang who joined for that server id and links the account Mojang names. The
 * Minecraft access token goes to Mojang only; the website session and the challenge stay in this
 * process. The server id is derived here from the challenge, never taken from the website, so a
 * join made for it is no good to any real server. A 409 means the Minecraft account belongs to
 * another ION account: the website keeps the proof for the challenge's two minutes, and
 * `transfer()` moves it once the player agrees.
 *
 * Everything that touches Electron or the network is injected, so tests can drive the flow.
 *
 * @module mclink
 */
const crypto = require('crypto')

const MOJANG_JOIN_URL = 'https://sessionserver.mojang.com/session/minecraft/join'
const START_PATH = '/api/launcher/account/link/start'
const COMPLETE_PATH = '/api/launcher/account/link/complete'
/** Must match Strapi's `SERVER_ID_PREFIX` (mc-verification/services/launcher-link.ts). */
const SERVER_ID_PREFIX = 'ion-website-link:'
const CHALLENGE = /^[0-9a-f]{64}$/
const NAME = /^[A-Za-z0-9_]{3,16}$/
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

const silent = { info(){}, warn(){}, error(){}, debug(){} }

/** The server id the launcher joins for a challenge. */
function serverIdFor(challenge){
    return crypto.createHash('sha1').update(SERVER_ID_PREFIX + challenge).digest('hex')
}

/**
 * @param {Object} deps
 * @param {(path: string, init?: {method?: string, body?: any}) => Promise<{ok: boolean, status: number, data?: any, error?: string, code?: string}>} deps.fetchJson
 *        The website, through the basic-auth gate (webauth.fetchJson).
 * @param {(url: string, init: Object) => Promise<{status: number}>} deps.fetchMojang Plain fetch for Mojang's session server.
 * @param {() => Promise<string|null>} deps.readSession The website's session token, from the web tabs' cookie.
 * @param {Object} [deps.logger]
 */
function createMinecraftLink({ fetchJson, fetchMojang, readSession, logger = silent }){
    /** The verification in progress: { session, challenge, username, name }. */
    let open = null

    async function post(path, body){
        try {
            return await fetchJson(path, { method: 'POST', body })
        } catch(err) {
            logger.warn('Minecraft link: the website did not answer.', err)
            return { ok: false, status: 0, code: 'UNAVAILABLE' }
        }
    }

    const refusal = (res) => ({ ok: false, code: res.code || 'UNAVAILABLE', error: typeof res.error === 'string' ? res.error : null })

    /**
     * Ask the website for a challenge for whoever is signed in there.
     *
     * @returns {Promise<{ok: true, username: string} | {ok: false, code: string, error: ?string}>}
     *          `username` is the ION account the link is for, as the website names it.
     */
    async function start(){
        open = null
        let session = null
        try { session = await readSession() } catch { session = null }
        if(!session) return { ok: false, code: 'SIGNED_OUT', error: null }
        const res = await post(START_PATH, { session })
        if(!res.ok || !CHALLENGE.test(res.data?.challenge) || typeof res.data?.username !== 'string' || !res.data.username){
            return refusal(res)
        }
        open = { session, challenge: res.data.challenge, username: res.data.username, name: null }
        return { ok: true, username: open.username }
    }

    async function complete(confirmTransfer){
        const res = await post(COMPLETE_PATH, { session: open.session, challenge: open.challenge, name: open.name, confirmTransfer })
        if(res.ok && res.data?.linked === true){
            open = null
            return { ok: true, minecraftName: String(res.data.minecraftName || ''), transferredFrom: res.data.transferredFrom || null }
        }
        if(res.status === 409 && res.code === 'LINKED_ELSEWHERE'){
            return { ok: false, code: 'LINKED_ELSEWHERE', error: res.error || null, existingUser: res.data?.existingUser || null }
        }
        // An outage leaves the challenge for another try; anything else spent it.
        if(res.code !== 'UNAVAILABLE') open = null
        return refusal(res)
    }

    /**
     * The player agreed: join for the challenge with their Minecraft session, then have the website
     * check the join and link the account.
     *
     * @param {{uuid: string, displayName: string, accessToken: string}} account The selected account.
     * @returns {Promise<{ok: true, minecraftName: string, transferredFrom: ?string} | {ok: false, code: string, error: ?string, existingUser?: ?string}>}
     *          `MOJANG` when Mojang refused the token (the account needs a refresh; the challenge is kept),
     *          `LINKED_ELSEWHERE` when `transfer()` may follow.
     */
    async function confirm(account){
        if(!open) return { ok: false, code: 'EXPIRED', error: null }
        if(!account || typeof account.uuid !== 'string' || !UUID.test(account.uuid)
            || typeof account.displayName !== 'string' || !NAME.test(account.displayName)
            || typeof account.accessToken !== 'string' || !account.accessToken){
            return { ok: false, code: 'NO_ACCOUNT', error: null }
        }
        let join
        try {
            join = await fetchMojang(MOJANG_JOIN_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    accessToken: account.accessToken,
                    selectedProfile: account.uuid.replace(/-/g, '').toLowerCase(),
                    serverId: serverIdFor(open.challenge)
                })
            })
        } catch(err) {
            logger.warn('Minecraft link: Mojang did not answer.', err)
            return { ok: false, code: 'OFFLINE', error: null }
        }
        if(join.status === 429) return { ok: false, code: 'RATE_LIMITED', error: null }
        if(join.status < 200 || join.status >= 300){
            logger.warn(`Minecraft link: Mojang refused the join (${join.status}).`)
            return { ok: false, code: 'MOJANG', error: null }
        }
        open.name = account.displayName
        return complete(false)
    }

    /** After `LINKED_ELSEWHERE`: move the Minecraft account to this ION account, with the proof the website kept. */
    async function transfer(){
        if(!open?.name) return { ok: false, code: 'EXPIRED', error: null }
        return complete(true)
    }

    function cancel(){
        open = null
    }

    return { start, confirm, transfer, cancel }
}

module.exports = { createMinecraftLink, serverIdFor, SERVER_ID_PREFIX, MOJANG_JOIN_URL, START_PATH, COMPLETE_PATH }
