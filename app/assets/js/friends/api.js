/**
 * The friends client: one function per route of the website's `/api/launcher/friends/*`, with the
 * launcher session (session.js) as bearer. Main process only; the renderer reaches it through the
 * `friends:*` IPC surface (index.js) and never sees the token.
 *
 * Every call answers `{ok, status, data}` or `{ok: false, status, code, error}`. The codes the
 * launcher itself adds, beside the website's own (`NOT_FOUND`, `ALREADY_FRIENDS`, …):
 *
 *   NO_SESSION    no launcher session could be minted (status 0, `reason` says why)
 *   GATE          the site's password gate refused the bearer request (401 with a Basic challenge)
 *   OFFLINE       the website did not answer (status 0)
 *   UNAVAILABLE   503: the backend is down, keep the last view and try again later
 *   RATE_LIMITED  429, with `retryAfter` seconds when the site said
 *
 * The party routes (`/party/**`) answer a PartyResponse, except `/party/follow`, which answers a JoinResult.
 *
 * A 401 means the session was refused: it is dropped and minted once more, silently, then the call
 * is repeated once.
 *
 * @module friends/api
 */
const BASE = '/api/launcher/friends'
const seg = encodeURIComponent

const silent = { info(){}, warn(){}, error(){}, debug(){} }

/**
 * @param {Object} deps
 * @param {Function} deps.fetchJson webauth.fetchJson: `(path, {method, body, bearer})`.
 * @param {Object} deps.session The session store (session.js).
 * @param {() => ({uuid: string, displayName: string, accessToken: string}|null)} deps.account The selected account.
 * @param {Object} [deps.logger]
 */
function createFriendsApi({ fetchJson, session, account, logger = silent }){

    async function send(method, path, body, bearer){
        try {
            const res = await fetchJson(BASE + path, { method, body, bearer })
            logger.debug(`Friends: ${method} ${path || '/'} → ${res.status}${res.code ? ` ${res.code}` : ''}`)
            return res
        } catch(err) {
            logger.warn(`Friends: ${method} ${path} did not reach the website.`, err)
            return { ok: false, status: 0, code: 'OFFLINE', error: null }
        }
    }

    function shape(res){
        if(res.ok) return { ok: true, status: res.status, data: res.data ?? null }
        const out = { ok: false, status: res.status, code: res.code ?? null, error: res.error ?? null, data: res.data ?? null }
        if(res.status === 503) out.code = 'UNAVAILABLE'
        else if(res.status === 429){ out.code = 'RATE_LIMITED'; if(res.retryAfter) out.retryAfter = res.retryAfter }
        return out
    }

    async function call(method, path, body){
        const acc = account()
        const first = await session.ensure(acc)
        if(!first.token) return { ok: false, status: 0, code: 'NO_SESSION', reason: first.reason ?? 'invalid', error: null }
        let res = await send(method, path, body, first.token)
        // The gate in front of the site answered, not the route: the session is fine, the site is not reachable this way.
        if(res.status === 401 && res.gate) return { ok: false, status: 401, code: 'GATE', error: null, data: null }
        if(res.status === 401){
            // The website forgot or refused the session: mint a new one, once, and try again.
            session.invalidate(acc.uuid)
            const again = await session.ensure(acc)
            if(!again.token) return { ok: false, status: 0, code: 'NO_SESSION', reason: again.reason ?? 'invalid', error: null }
            res = await send(method, path, body, again.token)
            if(res.status === 401) return { ok: false, status: 401, code: 'NO_SESSION', reason: 'refused', error: res.error ?? null }
        }
        return shape(res)
    }

    return {
        /** The whole FriendsView. */
        view: () => call('GET', ''),
        /** `{friends: [{uuid, presence}]}`: the cheap poll. */
        presence: () => call('GET', '/presence'),
        sendRequest: name => call('POST', '/requests', { name }),
        accept: uuid => call('POST', `/requests/${seg(uuid)}/accept`),
        decline: uuid => call('POST', `/requests/${seg(uuid)}/decline`),
        remove: uuid => call('DELETE', `/${seg(uuid)}`),
        block: uuid => call('POST', `/blocks/${seg(uuid)}`),
        unblock: uuid => call('DELETE', `/blocks/${seg(uuid)}`),
        /** @param {{showActivity?: boolean, appearOffline?: boolean, allowJoin?: boolean, receiveRequests?: boolean}} patch */
        settings: patch => call('PATCH', '/settings', patch),
        /** @returns {Promise<{ok: boolean, data?: {outcome: 'moved'|'launch'|'pack'|'refused', role?: string, release?: string, reason?: string, error?: string}}>} */
        join: (uuid, inGame) => call('POST', `/${seg(uuid)}/join`, { inGame: !!inGame }),
        invite: uuid => call('POST', `/${seg(uuid)}/invite`),
        dismissInvite: uuid => call('POST', `/invites/${seg(uuid)}/dismiss`),
        /** @param {{state: 'idle'|'playing'|'gone', release?: string}} presence */
        putPresence: presence => call('PUT', '/me/presence', presence),
        /** `{ticket, expiresIn}` for the live channel; single use, fetched right before connecting. */
        wsTicket: () => call('POST', '/ws-ticket'),
        /** `PartyResponse{party: PartyView|null, invites: [PartyInviteView]}`: my party and the invites addressed to me. */
        party: () => call('GET', '/party'),
        partyCreate: () => call('POST', '/party'),
        /** Friends only; creates the party when I have none. 403 NOT_FRIENDS · REFUSES_INVITES · NOT_LEADER, 409 IN_A_PARTY · FULL, 404 OFFLINE, 400 SELF. */
        partyInvite: uuid => call('POST', `/party/invite/${seg(uuid)}`),
        partyAccept: partyId => call('POST', `/party/invites/${seg(partyId)}/accept`),
        partyDecline: partyId => call('POST', `/party/invites/${seg(partyId)}/decline`),
        partyLeave: () => call('POST', '/party/leave'),
        partyKick: uuid => call('POST', `/party/kick/${seg(uuid)}`),
        partyPromote: uuid => call('POST', `/party/leader/${seg(uuid)}`),
        /** A `JoinResult` with the leader as target: `moved` / `launch` / `pack` / `refused`. */
        partyFollow: () => call('POST', '/party/follow'),
        /** The site path of a player's head picture. */
        headPath: uuid => `${BASE}/head/${seg(uuid)}`
    }
}

module.exports = { createFriendsApi, BASE }
