const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
    createFriendsModel, cleanPresence, cleanFriend, cleanSettings, cleanSettingsPatch, sortFriends, cleanSort, searchFriends, roundLines, clock,
    cleanClanMembers, SORTS
} = require('../app/assets/js/friendsmodel')

const T0 = Date.parse('2026-11-22T12:00:00Z')
const DAY = 86400000
const iso = ms => new Date(ms).toISOString()
const presence = (status, over = {}) => ({ status, since: null, lastOnline: null, activity: null, join: { play: false, spectate: false, reason: null }, ...over })
const friend = (uuid, name, status, over = {}) => ({ uuid, name, bedrock: false, headUrl: `/h/${uuid}`, presence: presence(status), ...over })
const ROUND_TEXTS = { map: m => m, team: t => `Team ${t}`, waiting: (c, m) => `Waiting ${c}/${m}` }

test('a round on a network activity is kept, trimmed to the contract; anything else is dropped', () => {
    const p = cleanPresence(presence('playing', { activity: {
        kind: 'network', gamemode: 'bowbash', inMatch: true, phase: 'match', release: 'ion_net', server: 'bb-3',
        round: { map: 'Sakura', team: 'Red', elapsedSeconds: 724, waiting: null, standings: ['1. Red 12', '2. Blue 9', 3, '', '3. Green 4', '4. Gold 1', '5. Aqua 0'], secret: 'x' }
    } }))
    assert.equal(p.activity.server, undefined)
    assert.deepEqual(p.activity.round, { map: 'Sakura', team: 'Red', elapsedSeconds: 724, waiting: null, standings: ['1. Red 12', '2. Blue 9', '3. Green 4', '4. Gold 1'] })
    const waiting = cleanPresence(presence('playing', { activity: { kind: 'network', round: { waiting: { count: 5, max: 8 }, standings: 'no' } } }))
    assert.deepEqual(waiting.activity.round, { map: null, team: null, elapsedSeconds: null, waiting: { count: 5, max: 8 }, standings: [] })
    const odd = cleanPresence(presence('playing', { activity: { kind: 'network', round: { elapsedSeconds: -4, waiting: { count: 2, max: 0 }, map: '  ' } } }))
    assert.deepEqual(odd.activity.round, { map: null, team: null, elapsedSeconds: null, waiting: null, standings: [] })
    // A pack has no round, and an activity without one reads null.
    assert.equal(cleanPresence(presence('playing', { activity: { kind: 'pack', release: 'p', round: { map: 'x' } } })).activity.round, null)
    assert.equal(cleanPresence(presence('playing', { activity: { kind: 'network' } })).activity.round, null)
})

test('a friend keeps a clan tag and since; absent or odd ones read null', () => {
    const f = cleanFriend(friend('a', 'alice', 'online', { clanTag: 'ION', since: '2026-01-02T00:00:00Z', extra: 1 }))
    assert.equal(f.clanTag, 'ION')
    assert.equal(f.since, Date.parse('2026-01-02T00:00:00Z'))
    assert.equal(f.extra, undefined)
    const g = cleanFriend(friend('b', 'bob', 'online', { clanTag: 7, since: 'long ago' }))
    assert.equal(g.clanTag, null)
    assert.equal(g.since, null)
})

test('the round line: map · team · time, or the waiting fill; standings as sent', () => {
    assert.deepEqual(roundLines({ map: 'Sakura', team: 'Red', elapsedSeconds: 724, waiting: null, standings: ['1. Red'] }, ROUND_TEXTS),
        { line: 'Sakura · Team Red · 12:04', standings: ['1. Red'] })
    assert.deepEqual(roundLines({ map: 'Sakura', team: null, elapsedSeconds: 30, waiting: { count: 5, max: 8 }, standings: [] }, ROUND_TEXTS),
        { line: 'Sakura · Waiting 5/8', standings: [] })
    assert.equal(roundLines({ map: null, team: null, elapsedSeconds: null, waiting: null, standings: [] }, ROUND_TEXTS), null)
    assert.equal(roundLines(null, ROUND_TEXTS), null)
    assert.equal(clock(0), '0:00')
    assert.equal(clock(65), '1:05')
    assert.equal(clock(3729), '1:02:09')
})

test('settings: the four switches default, the IONSocial keys are null while absent and normalised when sent', () => {
    assert.deepEqual(cleanSettings({}), {
        showActivity: true, appearOffline: false, allowJoin: true, receiveRequests: true,
        onlineNotices: null, clanNotices: null, partyInvites: null, privateMessages: null, hideMode: null, friendSort: null
    })
    const s = cleanSettings({ partyInvites: 'friends_and_clan', privateMessages: 'NOBODY', onlineNotices: false, clanNotices: true, hideMode: 'party', friendSort: 'NAME_DESC', allowJoin: false })
    assert.equal(s.partyInvites, 'FRIENDS_AND_CLAN')
    assert.equal(s.privateMessages, 'NOBODY')
    assert.equal(s.onlineNotices, false)
    assert.equal(s.clanNotices, true)
    assert.equal(s.hideMode, 'PARTY')
    assert.equal(s.friendSort, 'NAME_DESC')
    assert.equal(s.allowJoin, false)
    // EVERYONE is a party-invite policy, not a message policy.
    assert.equal(cleanSettings({ privateMessages: 'EVERYONE' }).privateMessages, null)
    assert.equal(cleanSettings({ partyInvites: 'toString' }).partyInvites, null)
})

test('a settings PATCH keeps only known keys with valid values', () => {
    assert.deepEqual(cleanSettingsPatch({ allowJoin: false, receiveRequests: true, onlineNotices: true, partyInvites: 'nobody', token: 'x', showActivity: 'yes' }),
        { allowJoin: false, receiveRequests: true, onlineNotices: true, partyInvites: 'NOBODY' })
    assert.deepEqual(cleanSettingsPatch({ privateMessages: 'FRIENDS', clanNotices: false }), { privateMessages: 'FRIENDS', clanNotices: false })
    assert.equal(cleanSettingsPatch({ privateMessages: 'EVERYONE' }), null)
    assert.equal(cleanSettingsPatch({ __proto__: { allowJoin: true } }), null)
    assert.equal(cleanSettingsPatch(null), null)
    assert.equal(cleanSettingsPatch('allowJoin'), null)
})

test('the model flips a new setting locally and keeps the IONSocial keys across a view', () => {
    const m = createFriendsModel()
    m.load({ me: { uuid: 'me' }, friends: [], requests: [], invites: [], blocked: [], settings: { partyInvites: 'FRIENDS', onlineNotices: true } })
    assert.equal(m.settings.partyInvites, 'FRIENDS')
    m.setSettings({ partyInvites: 'everyone' })
    assert.equal(m.settings.partyInvites, 'EVERYONE')
    m.setSettings({ onlineNotices: false })
    assert.equal(m.settings.onlineNotices, false)
    assert.equal(m.settings.partyInvites, 'EVERYONE')
})

test('the window\'s sorts and search', () => {
    const now = T0
    const list = [
        cleanFriend(friend('a', 'alice', 'offline', { since: iso(T0 - 300 * DAY) })),
        cleanFriend({ ...friend('b', 'Bob', 'playing'), since: iso(T0 - 10 * DAY), clanTag: 'ION' }),
        cleanFriend({ ...friend('c', 'carl', 'offline'), presence: presence('offline', { lastOnline: iso(T0 - DAY) }) }),
        cleanFriend({ ...friend('d', 'Dora', 'online'), since: iso(T0 - 400 * DAY) }),
        cleanFriend({ ...friend('e', 'eve', 'offline'), presence: presence('offline', { lastOnline: iso(T0 - 9 * DAY) }) })
    ]
    const names = l => l.map(f => f.name)
    assert.deepEqual(names(sortFriends(list, 'online', now)), ['Bob', 'Dora', 'alice', 'carl', 'eve'])
    assert.deepEqual(names(sortFriends(list, 'az', now)), ['alice', 'Bob', 'carl', 'Dora', 'eve'])
    assert.deepEqual(names(sortFriends(list, 'za', now)), ['eve', 'Dora', 'carl', 'Bob', 'alice'])
    assert.deepEqual(names(sortFriends(list, 'longest', now)), ['Dora', 'alice', 'Bob', 'carl', 'eve'])   // unknown since last, by name
    assert.deepEqual(names(sortFriends(list, 'recent', now)), ['Bob', 'Dora', 'carl', 'eve', 'alice'])    // on first, then by lastOnline
    assert.deepEqual(names(sortFriends(list, 'nonsense', now)), names(sortFriends(list, 'online', now)))
    assert.deepEqual(names(list), ['alice', 'Bob', 'carl', 'Dora', 'eve'])                                 // the input is not sorted in place
    assert.deepEqual(names(searchFriends(list, ' AR ')), ['carl'])
    assert.deepEqual(names(searchFriends(list, 'ion')), ['Bob'])                                           // the clan tag matches too
    assert.equal(searchFriends(list, '').length, 5)
    assert.equal(searchFriends(list, null).length, 5)
    assert.deepEqual(SORTS, ['online', 'az', 'za', 'longest', 'recent'])
    assert.equal(cleanSort('za'), 'za')
    assert.equal(cleanSort('__proto__'), 'online')
    assert.equal(cleanSort(undefined), 'online')
})

test('the clan answer: leaders first, then on before off, then name; no clan reads as none', () => {
    const c = cleanClanMembers({
        clan: { id: 4, name: 'Ionians', tag: 'ION' },
        members: [
            { uuid: 'm', name: 'mia', headUrl: '/h/m', role: 'MEMBER', friend: true, presence: presence('playing') },
            { uuid: 'z', name: 'zed', role: 'LEADER', friend: false, presence: presence('offline') },
            { uuid: 'o', name: 'Otto', role: 'OFFICER', friend: 'yes', presence: presence('launcher') },
            { uuid: 'k', name: 'kim', role: 'KING', presence: presence('offline') },
            { uuid: 7 }
        ]
    })
    assert.deepEqual(c.clan, { id: 4, name: 'Ionians', tag: 'ION' })
    assert.deepEqual(c.members.map(m => [m.name, m.role, m.friend]), [['zed', 'LEADER', false], ['Otto', 'OFFICER', false], ['mia', 'MEMBER', true], ['kim', 'MEMBER', false]])
    assert.equal(c.members[3].headUrl, null)
    assert.deepEqual(cleanClanMembers({ clan: null, members: [{ uuid: 'a', name: 'a' }] }), { clan: null, members: [] })
    assert.deepEqual(cleanClanMembers(null), { clan: null, members: [] })
})
