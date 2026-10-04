const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFriendsModel, toMs, cleanPartyView } = require('../app/assets/js/friendsmodel')

const T0 = Date.parse('2026-10-04T12:00:00Z')
const MIN = 60000
/** Times travel as ISO-8601 text (spec "Contracts"); the model holds epoch ms. */
const iso = ms => new Date(ms).toISOString()
const presence = status => ({ status, since: null, lastOnline: null, activity: null, join: { play: false, spectate: false, reason: null } })
const friend = (uuid, name, status) => ({ uuid, name, bedrock: false, headUrl: `/h/${uuid}`, presence: presence(status) })
const view = () => ({
    me: { uuid: 'me', presence: presence('launcher') },
    friends: [friend('a', 'alice', 'playing'), friend('d', 'Dan', 'launcher'), friend('o', 'Olga', 'online'), friend('e', 'Eve', 'offline')],
    requests: [], invites: [], settings: {}, blocked: []
})
const member = (uuid, name, where, leader = false) => ({ uuid, name, headUrl: `/h/${uuid}`, leader, where, presence: presence('launcher') })
const partyView = (over = {}) => ({
    id: 'p1', leader: 'me', private: false, createdAt: iso(T0), lastActivity: iso(T0), idleDisbandAt: iso(T0 + 15 * MIN),
    members: [member('d', 'Dan', 'launcher'), member('me', 'Me', 'launcher', true), member('x', 'Xeno', 'network')],
    invites: [{ uuid: 'o', name: 'Olga', expiresAt: iso(T0 + MIN) }],
    ...over
})
const partyInvite = (partyId = 'p9', fromUuid = 'a') => ({ partyId, from: { uuid: fromUuid, name: 'alice', headUrl: '/h/a' }, members: 2, expiresAt: iso(T0 + MIN) })
const loaded = () => { const m = createFriendsModel(); m.load(view()); return m }

test('a PartyResponse from the main process sets the party and my invites; leader first, non-friends kept', () => {
    const m = loaded()
    m.apply('party', { party: partyView(), invites: [partyInvite()] })
    assert.equal(m.party.id, 'p1')
    assert.deepEqual(m.party.members.map(x => x.uuid), ['me', 'd', 'x'])
    assert.equal(m.party.members[0].leader, true)
    assert.equal(m.party.members.find(x => x.uuid === 'x').name, 'Xeno')
    assert.deepEqual(m.partyInvites.map(i => i.partyId), ['p9'])
    assert.equal(m.party.idleDisbandAt, T0 + 15 * MIN)                // ISO text in, epoch ms held
    assert.equal(m.partyInvites[0].expiresAt, T0 + MIN)
    m.apply('party', { party: null })
    assert.equal(m.party, null)
    assert.deepEqual(m.partyInvites, [])
})

test('pushed party events keep the model current', () => {
    const m = loaded()
    let changes = 0
    m.subscribe(() => changes++)
    m.apply('party_invite', { invite: partyInvite('p9') })
    m.apply('party_invite', { invite: partyInvite('p9') })          // the same party again replaces, never doubles
    m.apply('party_invite', { invite: partyInvite('p8', 'd') })
    assert.deepEqual(m.partyInvites.map(i => i.partyId), ['p9', 'p8'])
    m.apply('party_invite_expired', { partyId: 'p8', reason: 'expired' })
    m.apply('party_invite_expired', { partyId: 'nope', reason: 'expired' })   // nothing to drop: no change
    assert.deepEqual(m.partyInvites.map(i => i.partyId), ['p9'])
    m.apply('party_updated', { party: partyView({ id: 'p9', leader: 'a', members: [member('a', 'alice', 'network', true), member('me', 'Me', 'launcher')], invites: [] }) })
    assert.equal(m.party.id, 'p9')
    assert.deepEqual(m.partyInvites, [])                               // I am in it now: its invite is gone
    m.apply('party_follow', { partyId: 'p9', leader: { uuid: 'a', name: 'alice' }, where: { gamemode: 'bowbash', release: 'ion_net', server: 'must-not-stay' } })
    assert.deepEqual(m.partyFollow, { partyId: 'p9', leader: { uuid: 'a', name: 'alice' }, where: { gamemode: 'bowbash', release: 'ion_net' } })
    m.clearFollow()
    assert.equal(m.partyFollow, null)
    m.apply('party_disbanded', { partyId: 'p9', reason: 'idle' })
    assert.equal(m.party, null)
    m.apply('party_disbanded', { partyId: 'p9', reason: 'idle' })    // already gone: no change
    assert.equal(changes, 8)
})

test('a removed member\'s disbanded frame clears my party; only "kicked" leaves a note', () => {
    const m = loaded()
    m.apply('party', { party: partyView(), invites: [] })
    m.apply('party_disbanded', { partyId: 'p2', reason: 'kicked' })    // not my party: nothing
    assert.equal(m.party.id, 'p1')
    assert.equal(m.partyKicked, null)
    m.apply('party_disbanded', { partyId: 'p1', reason: 'left' })
    assert.equal(m.party, null)
    assert.equal(m.partyKicked, null)                                  // I left: nothing to tell me
    m.apply('party', { party: partyView(), invites: [] })
    m.apply('party_disbanded', { partyId: 'p1', reason: 'kicked' })
    assert.equal(m.party, null)
    assert.equal(m.partyKicked, 'p1')
    m.apply('party', { party: null, invites: [] })                     // the poll's re-read keeps the note
    assert.equal(m.partyKicked, 'p1')
    m.clearKicked()
    assert.equal(m.partyKicked, null)
    m.apply('party_disbanded', { partyId: 'p1', reason: 'kicked' })    // gone already: no second note
    assert.equal(m.partyKicked, null)
    m.apply('party', { party: partyView(), invites: [] })
    m.apply('party_disbanded', { partyId: 'p1', reason: 'kicked' })
    m.apply('party', { party: partyView({ id: 'p3' }), invites: [] }) // a new party: the note is stale
    assert.equal(m.partyKicked, null)
})

test('safety net: an update that no longer lists me clears my party; another party never replaces mine', () => {
    const m = loaded()
    m.apply('party', { party: partyView(), invites: [] })
    m.apply('party_updated', { party: partyView({ id: 'p2', members: [member('a', 'alice', 'network', true)] }) })
    assert.equal(m.party.id, 'p1')
    m.apply('party_updated', { party: partyView({ leader: 'd', members: [member('d', 'Dan', 'launcher', true), member('x', 'Xeno', 'network')] }) })
    assert.equal(m.party, null)
})

test('a follow from myself or for another party is ignored', () => {
    const m = loaded()
    m.apply('party', { party: partyView(), invites: [] })
    m.apply('party_follow', { partyId: 'p1', leader: { uuid: 'me', name: 'Me' }, where: { gamemode: 'lobby', release: null } })
    m.apply('party_follow', { partyId: 'p2', leader: { uuid: 'd', name: 'Dan' }, where: { gamemode: 'lobby', release: null } })
    m.apply('party_follow', { partyId: 'p1', leader: 'garbage' })
    assert.equal(m.partyFollow, null)
    m.apply('party_follow', { partyId: 'p1', leader: { uuid: 'd', name: 'Dan' }, where: 'nowhere' })
    assert.deepEqual(m.partyFollow.where, { gamemode: 'network', release: null })   // an odd where reads as the network
})

test('garbage party payloads are cleaned or dropped, and times may be ms or ISO text', () => {
    assert.equal(cleanPartyView(null), null)
    assert.equal(cleanPartyView({ members: [] }), null)
    const p = cleanPartyView({ id: 'p1', leader: 'b', lastActivity: '2026-10-04T12:00:00Z', idleDisbandAt: 'soon', members: [null, { uuid: 1 }, { uuid: 'a', name: 'A', where: 'mars' }, { uuid: 'b', name: 'B', where: 'network' }], invites: 'no' })
    assert.deepEqual(p.members.map(x => [x.uuid, x.where, x.leader]), [['b', 'network', true], ['a', 'away', false]])
    assert.equal(p.lastActivity, T0)
    assert.equal(p.idleDisbandAt, null)
    assert.deepEqual(p.invites, [])
    assert.equal(p.members[1].headUrl, null)
    assert.equal(p.members[1].presence.status, 'offline')
    assert.equal(toMs(T0), T0)
    assert.equal(toMs('2026-10-04T12:00:00Z'), T0)
    assert.equal(toMs('x'), null)
    assert.equal(toMs(NaN), null)
    const m = loaded()
    m.apply('party_invite', { invite: { partyId: 'p1' } })                 // no sender: dropped
    m.apply('party_updated', { party: { members: [] } })                  // no id: dropped
    assert.deepEqual(m.partyInvites, [])
    assert.equal(m.party, null)
})

test('versions: a lower view of the held party is ignored, an equal one accepted', () => {
    const m = loaded()
    m.apply('party', { party: partyView({ version: 5 }), invites: [] })
    m.apply('party_updated', { party: partyView({ version: 4, private: true }) })
    assert.equal(m.party.version, 5)
    assert.equal(m.party.private, false)
    m.apply('party_updated', { party: partyView({ version: 5, private: true }) })
    assert.equal(m.party.private, true)
    m.apply('party_updated', { party: partyView({ version: 6, private: false }) })
    assert.equal(m.party.version, 6)
})

test('versions: a late pre-join update (without me) does not clear a newer party', () => {
    const m = loaded()
    m.apply('party', { party: partyView({ version: 7 }), invites: [] })
    m.apply('party_updated', { party: partyView({ version: 6, leader: 'd', members: [member('d', 'Dan', 'launcher', true), member('x', 'Xeno', 'network')] }) })
    assert.equal(m.party.id, 'p1')
    assert.equal(m.party.version, 7)
})

test('versions: a pushed update after the party ended is dropped whatever its version; a party response shows it again', () => {
    const m = loaded()
    m.apply('party', { party: partyView({ version: 7 }), invites: [] })
    m.apply('party_disbanded', { partyId: 'p1', reason: 'idle' })
    m.apply('party_updated', { party: partyView({ version: 7 }) })
    m.apply('party_updated', { party: partyView({ version: 3 }) })
    m.apply('party_updated', { party: partyView({ version: 8 }) })
    assert.equal(m.party, null)
    m.apply('party', { party: partyView({ version: 8 }), invites: [] })
    assert.equal(m.party.version, 8)
    m.apply('party_updated', { party: partyView({ version: 9 }) })     // revived: pushes work again
    assert.equal(m.party.version, 9)
})

test('a party response naming another party ends the held one (remembered); follow needs my party', () => {
    const m = loaded()
    m.apply('party_follow', { partyId: 'p1', leader: { uuid: 'd', name: 'Dan' }, where: { gamemode: 'lobby', release: null } })
    assert.equal(m.partyFollow, null)                                  // not in any party
    m.apply('party', { party: partyView({ version: 2 }), invites: [] })
    m.apply('party', { party: partyView({ id: 'p2', version: 1 }), invites: [] })
    m.apply('party_updated', { party: partyView({ version: 5 }) })     // p1 was ended by the switch
    assert.equal(m.party.id, 'p2')
})

test('versions: the ended memory is bounded', () => {
    const m = loaded()
    for(let n = 0; n < 40; n++){
        m.apply('party', { party: partyView({ id: `q${n}`, version: 1 }), invites: [] })
        m.apply('party_disbanded', { partyId: `q${n}`, reason: 'idle' })
    }
    m.apply('party_updated', { party: partyView({ id: 'q39', version: 1 }) })   // remembered
    assert.equal(m.party, null)
    m.apply('party_updated', { party: partyView({ id: 'q0', version: 1 }) })    // forgotten
    assert.equal(m.party.id, 'q0')
})

test('"kicked_all" leaves the removed note; idle, empty and admin do not', () => {
    for(const [reason, note] of [['kicked_all', 'p1'], ['kicked', 'p1'], ['idle', null], ['empty', null], ['admin', null]]){
        const m = loaded()
        m.apply('party', { party: partyView(), invites: [] })
        m.apply('party_disbanded', { partyId: 'p1', reason })
        assert.equal(m.partyKicked, note, reason)
    }
})
