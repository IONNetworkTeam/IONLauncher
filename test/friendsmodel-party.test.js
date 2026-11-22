const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFriendsModel, toMs, cleanPartyView, toastMs, followPlace, modeLabel, partyWhereKey, partySeats, confirmStep, CROWN_SVG, PARTY_TICK_MS, PARTY_WHERE_KEYS } = require('../app/assets/js/friendsmodel')

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
    id: 'p1', leader: 'me', private: false, createdAt: iso(T0), lastActivity: iso(T0), idleDisbandAt: null,
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
    assert.equal(m.party.lastActivity, T0)                            // ISO text in, epoch ms held
    assert.equal('idleDisbandAt' in m.party, false)                    // there is no idle disband: nothing to count down
    assert.equal(m.party.maxSize, null)                               // no cap named
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
    const p = cleanPartyView({ id: 'p1', leader: 'b', lastActivity: '2026-10-04T12:00:00Z', idleDisbandAt: 'soon', maxSize: -3, members: [null, { uuid: 1 }, { uuid: 'a', name: 'A', where: 'mars' }, { uuid: 'b', name: 'B', where: 'network' }], invites: 'no' })
    assert.deepEqual(p.members.map(x => [x.uuid, x.where, x.leader]), [['b', 'network', true], ['a', 'away', false]])
    assert.equal(p.lastActivity, T0)
    assert.equal(p.maxSize, null)
    assert.equal(p.members[1].awaySince, null)
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

test('who I can invite, and how: a party invite outside a round, the round invite in one', () => {
    const m = loaded()
    // No party yet: anyone not offline gets a party invite (the first invite creates the party).
    assert.equal(m.inviteAction('a', false), 'party')   // playing
    assert.equal(m.inviteAction('d', false), 'party')   // launcher
    assert.equal(m.inviteAction('o', false), 'party')   // online
    assert.equal(m.inviteAction('e', false), null)      // offline
    assert.equal(m.inviteAction('nobody', false), null)
    m.apply('party', { party: partyView(), invites: [] })
    assert.equal(m.amLeader(), true)
    assert.equal(m.isInMyParty('d'), true)
    assert.equal(m.isInMyParty('a'), false)
    assert.equal(m.isMe('ME'), true)
    assert.equal(m.inviteAction('d', false), null)      // already in my party
    assert.equal(m.inviteAction('a', false), 'party')
    assert.equal(m.invitedToMyParty('o'), true)
    assert.equal(m.invitedToMyParty('a'), false)
    // In a round: friends in the launcher get the round invite ("come where I am"), as before.
    assert.equal(m.inviteAction('o', true), 'round')
    assert.equal(m.inviteAction('d', true), 'round')
    assert.equal(m.inviteAction('a', true), 'party')
    // A member who is not the leader cannot party-invite (the route answers NOT_LEADER).
    m.apply('party', { party: partyView({ leader: 'd' }), invites: [] })
    assert.equal(m.amLeader(), false)
    assert.equal(m.inviteAction('a', false), null)
    assert.equal(m.inviteAction('o', true), 'round')
})

test('"3/8": the cap counts members and open invites; a full party offers no party invite', () => {
    const m = loaded()
    assert.equal(m.partySeats(), null)                               // no party
    m.apply('party', { party: partyView({ maxSize: 8 }), invites: [] })
    assert.deepEqual(m.partySeats(), { members: 3, max: 8, full: false })
    assert.equal(m.inviteAction('a', false), 'party')
    m.apply('party', { party: partyView({ maxSize: 4 }), invites: [] })   // 3 members + Olga's open invite
    assert.deepEqual(m.partySeats(), { members: 3, max: 4, full: true })
    assert.equal(m.inviteAction('a', false), null)
    assert.equal(m.inviteAction('o', true), 'round')                // the round invite is not a seat
    m.apply('party', { party: partyView({ maxSize: '8' }), invites: [] })
    assert.deepEqual(m.partySeats(), { members: 3, max: null, full: false })
    assert.equal(partySeats(null), null)
})

test('an away member keeps when they went ("offline since"); others carry no awaySince', () => {
    const p = cleanPartyView(partyView({
        members: [
            { ...member('me', 'Me', 'launcher', true), awaySince: iso(T0) },
            { ...member('d', 'Dan', 'away'), awaySince: iso(T0 - 5 * MIN) },
            { ...member('x', 'Xeno', 'away'), awaySince: 'yesterday' }
        ]
    }))
    assert.deepEqual(p.members.map(x => [x.uuid, x.awaySince]), [['me', null], ['d', T0 - 5 * MIN], ['x', null]])
})

test('the follow toast names a mode, the hub or ION Network, never a server', () => {
    const texts = { hub: 'the hub', network: 'ION Network' }
    assert.equal(followPlace({ gamemode: 'bowbash', release: 'ion_net' }, texts), 'Bowbash')
    assert.equal(followPlace({ gamemode: 'newmode', release: 'ion_net' }, texts), 'newmode')
    assert.equal(followPlace({ gamemode: 'lobby', release: 'ion_net' }, texts), 'the hub')
    assert.equal(followPlace({ gamemode: 'network', release: null }, texts), 'ION Network')
    assert.equal(followPlace(null, texts), 'ION Network')
    assert.equal(followPlace({ gamemode: '__proto__' }, texts), '__proto__')
})

test('the toast time follows expiresAt, clamped against a launcher clock that is off', () => {
    assert.equal(toastMs(T0 + 60000, T0), 60000)
    assert.equal(toastMs(T0 + 42000, T0), 42000)
    assert.equal(toastMs(T0 + 10 * MIN, T0), 60000)                 // launcher clock behind
    assert.equal(toastMs(T0 - 10 * MIN, T0), 5000)                  // launcher clock ahead
    assert.equal(toastMs(null, T0), 60000)
})

test('one toast at a time: party invite, then follow, then round invite; dismissed keys are skipped', () => {
    const m = loaded()
    assert.equal(m.pickToast(new Set()), null)
    m.apply('invite', { invite: { from: { uuid: 'a', name: 'alice', headUrl: '/h/a' }, activity: null, expiresAt: 'x' } })
    m.apply('party', { party: partyView({ leader: 'd', members: [member('d', 'Dan', 'launcher', true), member('me', 'Me', 'launcher')] }), invites: [partyInvite('p9')] })
    m.apply('party_follow', { partyId: 'p1', leader: { uuid: 'd', name: 'Dan' }, where: { gamemode: 'bowbash', release: 'ion_net' } })
    const first = m.pickToast(new Set())
    assert.equal(first.kind, 'party')
    assert.equal(first.key, 'party:p9')
    assert.equal(first.item.from.uuid, 'a')
    const second = m.pickToast(new Set(['party:p9']))
    assert.deepEqual([second.kind, second.key], ['follow', 'follow:p1:bowbash:ion_net'])
    const third = m.pickToast(new Set(['party:p9', 'follow:p1:bowbash:ion_net']))
    assert.deepEqual([third.kind, third.key], ['round', 'round:a'])
    assert.equal(m.pickToast(new Set(['party:p9', 'follow:p1:bowbash:ion_net', 'round:a'])), null)
    // A move to another gamemode is a new follow: a new key.
    m.apply('party_follow', { partyId: 'p1', leader: { uuid: 'd', name: 'Dan' }, where: { gamemode: 'lobby', release: 'ion_net' } })
    assert.equal(m.pickToast(new Set(['party:p9', 'follow:p1:bowbash:ion_net'])).key, 'follow:p1:lobby:ion_net')
})

test('the kicked note comes right after party invites, before a follow or a round invite', () => {
    const m = loaded()
    m.apply('invite', { invite: { from: { uuid: 'a', name: 'alice', headUrl: '/h/a' }, activity: null, expiresAt: 'x' } })
    m.apply('party', { party: partyView({ leader: 'd', members: [member('d', 'Dan', 'launcher', true), member('me', 'Me', 'launcher')] }), invites: [partyInvite('p9')] })
    m.apply('party_disbanded', { partyId: 'p1', reason: 'kicked' })
    const next = m.pickToast(new Set(['party:p9']))
    assert.deepEqual([next.kind, next.key, next.item], ['kicked', 'kicked:p1', { partyId: 'p1' }])
    assert.equal(m.pickToast(new Set(['party:p9', 'kicked:p1'])).kind, 'round')
    m.clearKicked()
    assert.equal(m.pickToast(new Set(['party:p9'])).kind, 'round')
})

test('shared helpers both renderers use: place keys, crown, two-click confirm', () => {
    assert.deepEqual(PARTY_WHERE_KEYS, { launcher: 'whereLauncher', network: 'whereNetwork', away: 'whereAway' })
    assert.equal(partyWhereKey('network'), 'whereNetwork')
    assert.equal(partyWhereKey('__proto__'), 'whereAway')
    assert.equal(partyWhereKey('constructor'), 'whereAway')
    assert.equal(partyWhereKey(undefined), 'whereAway')
    assert.equal(modeLabel('bowbash'), 'Bowbash')
    assert.equal(modeLabel('constructor'), 'constructor')
    assert.equal(modeLabel('toString'), 'toString')
    assert.match(CROWN_SVG, /^<svg .*<\/svg>$/)
    assert.equal(PARTY_TICK_MS, 30000)
    // The first click arms, the second on the same target confirms; another target re-arms.
    assert.deepEqual(confirmStep(null, 'leave'), { confirmed: false, next: 'leave' })
    assert.deepEqual(confirmStep('leave', 'leave'), { confirmed: true, next: null })
    assert.deepEqual(confirmStep('kick:a', 'kick:b'), { confirmed: false, next: 'kick:b' })
    assert.deepEqual(confirmStep('leave', 'kick:a'), { confirmed: false, next: 'kick:a' })
})

test('followKey is the key pickToast uses for a follow frame', () => {
    const { followKey } = require('../app/assets/js/friendsmodel')
    assert.equal(followKey({ partyId: 'p1', where: { gamemode: 'bedwars', release: 'r1' } }), 'follow:p1:bedwars:r1')
    assert.equal(followKey({ partyId: 'p1', where: { gamemode: 'lobby' } }), 'follow:p1:lobby:')
})
