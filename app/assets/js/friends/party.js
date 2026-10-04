/**
 * The party half of the `friends:*` IPC surface (index.js registers these beside the friends
 * handlers). Each handler checks its argument, calls the route (api.js), records session and
 * reachability (`note`), and sends every PartyResponse to every window as `party` {party,
 * invites}, so the strip and the friends window always draw the same party. `partyFollow`
 * answers a JoinResult, which only the caller needs.
 *
 * @module friends/party
 */
const badRequest = () => ({ ok: false, status: 400, code: 'BAD_REQUEST', error: null })

/**
 * @param {Object} deps
 * @param {Object} deps.api The friends client (api.js).
 * @param {(v: *) => boolean} deps.isId index.js's uuid guard, so the pattern lives in one place.
 * @param {(res: Object) => Object} deps.note index.js's session/reachability bookkeeping; returns its argument.
 * @param {(event: string, payload: Object) => void} deps.broadcast To every window.
 * @param {() => number} [deps.epoch] Counts the pushed party events. A `party` read whose answer
 *   arrives after the count moved is older than the push, so it is returned but not broadcast.
 */
function createPartyHandlers({ api, isId, note, broadcast, epoch = () => 0 }){
    function publish(res){
        if(res?.ok && res.data && typeof res.data === 'object'){
            broadcast('party', { party: res.data.party ?? null, invites: Array.isArray(res.data.invites) ? res.data.invites : [] })
        }
        return res
    }
    const run = promise => promise.then(note).then(publish)
    const withId = fn => (_e, id) => isId(id) ? run(fn(id)) : badRequest()

    return {
        party: () => {
            const at = epoch()
            return api.party().then(note).then(res => epoch() === at ? publish(res) : res)
        },
        partyCreate: () => run(api.partyCreate()),
        partyInvite: withId(uuid => api.partyInvite(uuid)),
        partyAccept: withId(partyId => api.partyAccept(partyId)),
        partyDecline: withId(partyId => api.partyDecline(partyId)),
        partyLeave: () => run(api.partyLeave()),
        partyKick: withId(uuid => api.partyKick(uuid)),
        partyPromote: withId(uuid => api.partyPromote(uuid)),
        partyFollow: () => api.partyFollow().then(note)
    }
}

module.exports = { createPartyHandlers }
