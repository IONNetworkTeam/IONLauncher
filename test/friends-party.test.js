const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPartyHandlers } = require('../app/assets/js/friends/party')

/** Stands in for index.js's guard, which the handlers are handed. */
const UUID_GUARD = v => typeof v === 'string' && /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v)

const U = 'a900acbf-ffc1-4ebc-899c-e1e17141cf5d'
const P = 'b6c6c0a8-3f7e-4c43-9a51-6d1f0e2f9a10'
const RESPONSE = { ok: true, status: 200, data: { party: { id: P }, invites: [{ partyId: 'q' }] } }

/** A fake api where every route records its call and answers `answer(name)`. */
function harness(answer = () => RESPONSE, extra = {}){
    const calls = []
    const sent = []
    const noted = []
    const api = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(answer(name)) } })
    const handlers = createPartyHandlers({ api, isId: UUID_GUARD, note: r => { noted.push(r); return r }, broadcast: (event, payload) => sent.push([event, payload]), ...extra })
    return { handlers, calls, sent, noted }
}

test('every friends:party* handler calls its route with the checked argument and notes the answer', async () => {
    const h = harness()
    const e = {}
    await h.handlers.party(e)
    await h.handlers.partyCreate(e)
    await h.handlers.partyInvite(e, U)
    await h.handlers.partyAccept(e, P)
    await h.handlers.partyDecline(e, P)
    await h.handlers.partyLeave(e)
    await h.handlers.partyKick(e, U)
    await h.handlers.partyPromote(e, U)
    await h.handlers.partyFollow(e)
    assert.deepEqual(h.calls, [['party'], ['partyCreate'], ['partyInvite', U], ['partyAccept', P], ['partyDecline', P], ['partyLeave'], ['partyKick', U], ['partyPromote', U], ['partyFollow']])
    assert.equal(h.noted.length, 9)
    assert.deepEqual(Object.keys(h.handlers).sort(), ['party', 'partyAccept', 'partyCreate', 'partyDecline', 'partyFollow', 'partyInvite', 'partyKick', 'partyLeave', 'partyPromote'])
})

test('a PartyResponse goes to every window as `party`; a JoinResult and a refusal do not', async () => {
    const h = harness(name =>
        name === 'partyFollow' ? { ok: true, status: 200, data: { outcome: 'launch', release: 'ion_net' } }
            : name === 'partyKick' ? { ok: false, status: 403, code: 'NOT_LEADER', error: 'Only the leader can kick.', data: null }
                : RESPONSE)
    await h.handlers.partyInvite({}, U)
    const kicked = await h.handlers.partyKick({}, U)
    const followed = await h.handlers.partyFollow({})
    assert.deepEqual(h.sent, [['party', { party: { id: P }, invites: [{ partyId: 'q' }] }]])
    assert.equal(kicked.code, 'NOT_LEADER')
    assert.equal(followed.data.outcome, 'launch')
})

test('leaving the party broadcasts party: null; a body without invites reads as none', async () => {
    const h = harness(() => ({ ok: true, status: 200, data: { party: null } }))
    await h.handlers.partyLeave({})
    assert.deepEqual(h.sent, [['party', { party: null, invites: [] }]])
})

test('a bad uuid or party id never reaches the website', async () => {
    const h = harness()
    for(const [name, arg] of [['partyInvite', 'nope'], ['partyAccept', '../x'], ['partyDecline', 42], ['partyKick', null], ['partyPromote', 'x'.repeat(40)]]){
        const r = await h.handlers[name]({}, arg)
        assert.equal(r.code, 'BAD_REQUEST', name)
        assert.equal(r.status, 400)
    }
    assert.equal(h.calls.length, 0)
    assert.equal(h.sent.length, 0)
})

test('a party read that was in flight when a party event arrived is not broadcast', async () => {
    let epoch = 0
    let release
    const gate = new Promise(r => { release = r })
    const sent = []
    const api = { party: () => gate }
    const handlers = createPartyHandlers({ api, isId: UUID_GUARD, note: r => r, broadcast: (e, p) => sent.push([e, p]), epoch: () => epoch })
    const read = handlers.party({})
    epoch++ // a party_updated frame lands while GET /party is out
    release(RESPONSE)
    const res = await read
    assert.equal(res.ok, true)
    assert.deepEqual(sent, [])
    // A read started after the event is current again.
    api.party = () => Promise.resolve(RESPONSE)
    await handlers.party({})
    assert.equal(sent.length, 1)
})
