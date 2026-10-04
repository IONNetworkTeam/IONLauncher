const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const toml = require('toml')

const lang = toml.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'lang', 'en_US.toml'), 'utf8'))
const PARTY_KEYS = ['partyLabel', 'partyKicker', 'partyInvitedYou', 'partyMembers', 'joinParty', 'partyInviteHint', 'roundInviteHint',
    'partyInviteMore', 'partyMenu', 'partyLeader', 'partyLeave', 'partyKick', 'partyPromote', 'partyDisbandsIn', 'partyStart',
    'partyNobodyToInvite', 'partyCardTitle', 'partyInviteTitle', 'partyNotFriend', 'sectionParty', 'sectionPartyEmpty',
    'sectionPartyInvites', 'whereLauncher', 'whereNetwork', 'whereAway', 'followKicker', 'followWent', 'followHub', 'follow', 'partyRemoved',
    'you', 'network']

test('every party text the strip, the toasts and the window read exists in English', () => {
    for(const k of PARTY_KEYS) assert.equal(typeof lang.js.friends[k], 'string', `js.friends.${k}`)
    assert.match(lang.js.friends.partyInvitedYou, /\{name\}/)
    assert.match(lang.js.friends.followWent, /\{name\}.*\{where\}/)
    assert.match(lang.js.friends.partyDisbandsIn, /\{n\}/)
})
