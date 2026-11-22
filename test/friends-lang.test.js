const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const toml = require('toml')
const Lang = require('../app/assets/js/langloader')

const read = id => toml.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'assets', 'lang', `${id}.toml`), 'utf8'))
const lang = read('en_US')
const de = read('de_DE')
const PARTY_KEYS = ['partyLabel', 'partyKicker', 'partyInvitedYou', 'partyMembers', 'joinParty', 'partyInviteHint', 'roundInviteHint',
    'partyInviteMore', 'partyMenu', 'partyLeader', 'partyLeave', 'partyKick', 'partyPromote', 'partyStart',
    'partyNobodyToInvite', 'partyCardTitle', 'partyInviteTitle', 'partyNotFriend', 'sectionParty', 'sectionPartyEmpty',
    'sectionPartyInvites', 'whereLauncher', 'whereNetwork', 'whereAway', 'followKicker', 'followWent', 'followHub', 'follow', 'partyRemoved',
    'you', 'network']
/** Every key the window, the strip and the settings tab read under js.friends.social. */
const SOCIAL_KEYS = ['sectionAll', 'noMatch', 'cancelRequestHint', 'blockHint', 'sectionPrivacy', 'sectionInvites', 'sectionNotices',
    'sectionBlocked', 'noBlocked', 'unblock', 'showActivity', 'appearOffline', 'allowJoin', 'allowJoinDesc', 'receiveRequests',
    'partyInvites', 'privateMessages', 'privateMessagesDesc', 'onlineNotices', 'clanNotices', 'optEveryone', 'optFriends',
    'optFriendsAndClan', 'optNobody', 'availableSoon', 'partySize', 'partyFull', 'partyDisband', 'partyWarp', 'partyWarpHint', 'warped',
    'awayFor', 'awayJustNow', 'roundTeam', 'roundWaiting', 'clanTitle', 'noClan', 'clanLoading', 'roleLeader', 'roleOfficer', 'addFriend', 'requested']
const EJS_SOCIAL_KEYS = ['tabFriends', 'tabClan', 'tabSettings', 'tabsLabel', 'searchPlaceholder', 'sortLabel', 'sortOnline', 'sortAz',
    'sortZa', 'sortLongest', 'sortRecent']

/** Every dotted key path of a parsed TOML table. */
function keys(table, prefix = ''){
    return Object.entries(table).flatMap(([k, v]) => v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`])
}
const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

test('every party text the strip, the toasts and the window read exists in English', () => {
    for(const k of PARTY_KEYS) assert.equal(typeof lang.js.friends[k], 'string', `js.friends.${k}`)
    assert.match(lang.js.friends.partyInvitedYou, /\{name\}/)
    assert.match(lang.js.friends.followWent, /\{name\}.*\{where\}/)
})

test('the idle countdown is gone with its text', () => {
    assert.equal(lang.js.friends.partyDisbandsIn, undefined)
})

test('the AFK badge has its text', () => {
    assert.equal(typeof lang.js.friends.afk, 'string')
})

test('every IONSocial text exists in English and in German', () => {
    for(const k of SOCIAL_KEYS){
        assert.equal(typeof lang.js.friends.social[k], 'string', `en js.friends.social.${k}`)
        assert.equal(typeof de.js.friends.social[k], 'string', `de js.friends.social.${k}`)
    }
    for(const k of EJS_SOCIAL_KEYS){
        assert.equal(typeof lang.ejs.friends.social[k], 'string', `en ejs.friends.social.${k}`)
        assert.equal(typeof de.ejs.friends.social[k], 'string', `de ejs.friends.social.${k}`)
    }
    assert.deepEqual(placeholders(lang.js.friends.social.warped), ['kept', 'moved'])
    assert.deepEqual(placeholders(lang.js.friends.social.partySize), ['max', 'n'])
})

test('German holds friends texts only, each one English has, with the same placeholders', () => {
    const en = new Set(keys(lang))
    for(const k of keys(de)){
        assert.ok(k.startsWith('js.friends.') || k.startsWith('ejs.friends.') || k.startsWith('ejs.settings.friends.'), `not a friends key: ${k}`)
        assert.ok(en.has(k), `German-only key: ${k}`)
        const get = (t, p) => p.split('.').reduce((o, x) => o[x], t)
        assert.deepEqual(placeholders(get(de, k)), placeholders(get(lang, k)), `placeholders of ${k}`)
    }
})

test('a German system picks de_DE; everything else stays English', () => {
    for(const l of ['de', 'de-DE', 'de-AT', 'de_CH.UTF-8', 'DE']) assert.equal(Lang.pickLanguage(l), 'de_DE', l)
    for(const l of ['en-US', 'fr-FR', '', null, undefined, 'deu', '__proto__']) assert.equal(Lang.pickLanguage(l), null, String(l))
})

test('a key German lacks still reads in English', () => {
    const before = process.env.ION_LANG
    process.env.ION_LANG = 'de-DE'
    try {
        Lang.setupLanguage()
        assert.equal(Lang.queryJS('friends.accept'), de.js.friends.accept)
        assert.equal(Lang.queryJS('landing.launch.pleaseWait'), lang.js.landing.launch.pleaseWait)
        assert.equal(Lang.queryEJS('friends.social.tabSettings'), 'Einstellungen')
    } finally {
        if(before === undefined) delete process.env.ION_LANG
        else process.env.ION_LANG = before
    }
})
