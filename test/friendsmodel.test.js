const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFriendsModel, activityLine, ago, compareFriends, NAME } = require('../app/assets/js/friendsmodel')

const presence = (status, extra = {}) => ({ status, since: null, lastOnline: null, activity: null, join: { play: false, spectate: false, reason: null }, ...extra })
const friend = (uuid, name, status, extra) => ({ uuid, name, bedrock: false, headUrl: `/api/launcher/friends/head/${uuid}`, presence: presence(status, extra) })
const network = (gamemode, inMatch, phase = inMatch ? 'match' : 'lobby') => ({ kind: 'network', gamemode, inMatch, phase, matchId: null, release: null })
const pack = release => ({ kind: 'pack', gamemode: null, inMatch: false, phase: null, matchId: null, release })

const view = () => ({
    me: { uuid: 'me', presence: presence('launcher') },
    friends: [
        friend('e', 'Eve', 'offline', { lastOnline: '2026-10-02T10:00:00Z' }),
        friend('a', 'alice', 'playing', { since: '2026-10-03T11:48:00Z', activity: network('bowbash', true), join: { play: true, spectate: true, reason: null } }),
        friend('d', 'Dan', 'launcher'),
        friend('c', 'Carl', 'playing', { activity: pack('create6') }),
        friend('b', 'Bob', 'playing', { activity: network('crystalhunt', false), join: { play: false, spectate: true, reason: null } }),
        friend('o', 'Olga', 'online')
    ],
    requests: [{ uuid: 'f', name: 'Fred', headUrl: '/h/f', direction: 'incoming', sentAt: '2026-10-03T10:00:00Z' }],
    invites: [{ from: { uuid: 'a', name: 'alice', headUrl: '/h/a' }, activity: network('bowbash', false), expiresAt: '2026-10-03T12:05:00Z' }],
    settings: { showActivity: true, appearOffline: false, allowJoin: true, receiveRequests: true },
    blocked: [{ uuid: 'z', name: 'Zed' }]
})

test('sorts playing → launcher (with online) → offline, then by name regardless of case', () => {
    const m = createFriendsModel()
    m.load(view())
    assert.deepEqual(m.friends().map(f => f.name), ['alice', 'Bob', 'Carl', 'Dan', 'Olga', 'Eve'])
    const s = m.sections()
    assert.deepEqual(s.playing.map(f => f.uuid), ['a', 'b', 'c'])
    assert.deepEqual(s.launcher.map(f => f.uuid), ['d', 'o'])
    assert.deepEqual(s.offline.map(f => f.uuid), ['e'])
    // online and launcher share a section, so only the name decides between them.
    assert.ok(compareFriends(friend('x', 'x', 'online'), friend('y', 'y', 'launcher')) < 0)
    assert.ok(compareFriends(friend('x', 'x', 'offline'), friend('y', 'y', 'online')) > 0)
})

test('counts: online friends (0 while appearing offline), friends per gamemode, friends on a release', () => {
    const m = createFriendsModel()
    m.load(view())
    assert.equal(m.onlineCount(), 5)
    assert.deepEqual(m.modeCounts(), { bowbash: 1, crystalhunt: 1 })
    assert.deepEqual(m.playingOn('ion_net', 'ion_net').map(f => f.uuid), ['a', 'b'])
    assert.deepEqual(m.playingOn('create6', 'ion_net').map(f => f.uuid), ['c'])
    m.setSettings({ appearOffline: true })
    assert.equal(m.onlineCount(), 0)
    assert.equal(m.settings.appearOffline, true)
})

test('the kicker texts of the boards', () => {
    const names = id => ({ create6: 'Create 6 Survival' })[id] ?? null
    const now = Date.parse('2026-10-03T12:00:00Z')
    assert.equal(activityLine(presence('playing', { activity: network('bowbash', true) }), names), 'Bowbash · in a match')
    assert.equal(activityLine(presence('playing', { activity: network('crystalhunt', false) }), names), 'CrystalHunt · lobby')
    assert.equal(activityLine(presence('playing', { activity: network('ionjumps', false, 'podium') }), names), 'IONJumps · on the podium')
    assert.equal(activityLine(presence('playing', { activity: network('lobby', false) }), names), 'In the hub')
    assert.equal(activityLine(presence('playing', { activity: pack('create6') }), names), 'Create 6 Survival')
    assert.equal(activityLine(presence('playing', { activity: pack('unknown') }), names), 'Playing')
    assert.equal(activityLine(presence('launcher'), names), 'In the launcher')
    assert.equal(activityLine(presence('online'), names), 'Online')
    assert.equal(activityLine(presence('offline', { lastOnline: '2026-10-02T10:00:00Z' }), names, undefined, now), 'Last online yesterday')
    assert.equal(activityLine(presence('offline', { lastOnline: '2026-09-18T10:00:00Z' }), names, undefined, now), 'Last online 2 weeks ago')
    assert.equal(activityLine(presence('offline'), names), 'Offline')
    assert.equal(ago('2026-10-03T11:48:00Z', now), '12 min')
    assert.equal(ago('2026-10-03T10:30:00Z', now), '1 h')
    assert.equal(ago('2026-10-03T11:59:50Z', now), 'now')
    assert.equal(ago(null, now), '')
})

test('pushed events keep the model current', () => {
    const m = createFriendsModel()
    let changes = 0
    m.subscribe(() => changes++)
    m.load(view())
    m.apply('presence', { friend: { uuid: 'd', presence: presence('playing', { activity: network('bedwars', true) }) } })
    assert.equal(m.friend('d').presence.status, 'playing')
    assert.deepEqual(m.modeCounts(), { bowbash: 1, crystalhunt: 1, bedwars: 1 })
    m.apply('presence', { friend: { uuid: 'nobody', presence: presence('playing') } })
    m.apply('request', { request: { uuid: 'g', name: 'Gus', headUrl: '/h/g', direction: 'incoming', sentAt: 'x' } })
    assert.deepEqual(m.incomingRequests().map(r => r.uuid), ['f', 'g'])
    m.apply('request_resolved', { uuid: 'f', accepted: false })
    assert.deepEqual(m.requests.map(r => r.uuid), ['g'])
    m.apply('friend_added', { friend: friend('g', 'Gus', 'launcher') })
    assert.deepEqual(m.requests, [])
    assert.equal(m.friend('g').name, 'Gus')
    m.apply('friend_removed', { uuid: 'e' })
    assert.equal(m.friend('e'), null)
    m.apply('invite', { invite: { from: { uuid: 'b', name: 'Bob', headUrl: '/h/b' }, activity: network('crystalhunt', false), expiresAt: 'x' } })
    assert.deepEqual(m.invites.map(i => i.from.uuid), ['a', 'b'])
    m.apply('invite_expired', { from: 'a' })
    assert.deepEqual(m.invites.map(i => i.from.uuid), ['b'])
    m.apply('snapshot', { friends: [{ uuid: 'a', presence: presence('offline') }, { uuid: 'nobody', presence: presence('online') }] })
    assert.equal(m.friend('a').presence.status, 'offline')
    m.apply('made_up', {})
    assert.equal(changes, 9)  // the unknown friend and the unknown event changed nothing
})

test('a 503 marks the model stale without losing the view; a new view clears it', () => {
    const m = createFriendsModel()
    m.load(view())
    m.setStale(true)
    assert.equal(m.stale, true)
    assert.equal(m.friends().length, 6)
    m.apply('view', { view: view() })
    assert.equal(m.stale, false)
})

test('garbage from the website is dropped, not drawn', () => {
    const m = createFriendsModel()
    m.load({ friends: [null, { uuid: 1 }, friend('a', 'A', 'weird', { activity: { kind: 'other' }, join: null })], requests: 'no', settings: { appearOffline: 'yes' } })
    assert.equal(m.friends().length, 1)
    assert.equal(m.friend('a').presence.status, 'offline')
    assert.equal(m.friend('a').presence.activity, null)
    assert.deepEqual(m.friend('a').presence.join, { play: false, spectate: false, reason: null })
    assert.equal(m.settings.appearOffline, false)
    assert.equal(m.loaded, true)
    assert.ok(NAME.test('Juli0q') && !NAME.test('ab') && !NAME.test('has space'))
})
