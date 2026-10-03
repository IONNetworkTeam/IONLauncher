const { test } = require('node:test')
const assert = require('node:assert/strict')
const { HOUSE, NETWORK, SIGNAL_PLAY, splitTitle, mergeReleases, shelfAfterPick, initialShelf } = require('../app/assets/js/releasemodel')

test('splitTitle sets a trailing number apart', () => {
    assert.deepEqual(splitTitle('VelonaSMP 2025'), ['VelonaSMP', '2025'])
    assert.deepEqual(splitTitle('Create 6 Survival'), ['Create 6 Survival', ''])
    assert.deepEqual(splitTitle('ION Network'), ['ION Network', ''])
    assert.deepEqual(splitTitle(''), ['', ''])
})

const servers = [
    { id: 'net', name: 'ION Network', description: 'Gamemodes', minecraftVersion: '1.21.10', address: 'play.example:25565', mainServer: true },
    { id: 'pack', name: 'VelonaSMP 2025', minecraftVersion: '1.21.10' },
    { id: 'bare', name: 'Plain', minecraftVersion: '1.20.1' }
]
const pres = [
    { id: 'net', kind: 'gameserver', accent: null, mapUrl: null, announcement: null },
    { id: 'pack', kind: 'modpack', accent: { base: '#068CDB', deep: '#1A76B5', text: '#86C5FA' }, mapUrl: 'https://map.example', announcement: { text: 'Hi', date: null, url: null } }
]

test('mergeReleases keeps distribution order and dresses each release', () => {
    const [n, p, b] = mergeReleases(servers, pres)
    assert.deepEqual([n.id, p.id, b.id], ['net', 'pack', 'bare'])
    assert.equal(n.net, true)
    assert.deepEqual(n.accent, NETWORK)
    assert.equal(n.playBg, SIGNAL_PLAY)
    assert.equal(p.net, false)
    assert.equal(p.playBg, '#1A76B5')
    assert.equal(p.edition, '2025')
    assert.equal(p.mapUrl, 'https://map.example')
    assert.deepEqual(b.accent, HOUSE)
    assert.equal(b.kind, 'modpack')
    assert.equal(b.announcement, null)
})

test('mergeReleases works with no presentation at all (offline)', () => {
    const out = mergeReleases(servers, null)
    assert.equal(out.length, 3)
    assert.ok(out.every(r => !r.net))
})

test('shelfAfterPick moves a library pick to the front and drops the oldest', () => {
    assert.deepEqual(shelfAfterPick(['a', 'b', 'c', 'd'], 'e'), ['e', 'a', 'b', 'c'])
    assert.deepEqual(shelfAfterPick(['a', 'b', 'c', 'd'], 'c'), ['a', 'b', 'c', 'd'])
})

test('initialShelf drops vanished releases and tops up from the main one', () => {
    assert.deepEqual(initialShelf(['gone', 'b'], ['a', 'b', 'c', 'd', 'e'], 'c'), ['b', 'c', 'a', 'd'])
    assert.deepEqual(initialShelf(null, ['a', 'b'], 'b'), ['b', 'a'])
    assert.deepEqual(initialShelf([], [], null), [])
})

const { sanitizePresentation } = require('../app/assets/js/releasemodel')

test('sanitizePresentation drops what the site should never have sent', () => {
    const out = sanitizePresentation([
        null, 7, { kind: 'gameserver' },
        { id: 'a', kind: 'gameserver', accent: { base: '#6E8CF0', deep: '#4F6EE0', text: '#A9B9FA' }, mapUrl: 'https://map.example', announcement: { text: 'Hi', date: '2026-10-02', url: 'https://x.example' } },
        { id: 'b', kind: 'evil', accent: { base: '"><img src=x onerror=alert(1)>', deep: '#000000', text: '#ffffff' }, mapUrl: 'javascript:alert(1)', announcement: { text: 42, url: 'file:///etc/passwd' } },
        { id: 'c', accent: { base: '#C86900' }, announcement: { text: 'No link', url: 'smb://host/share' } }
    ])
    assert.deepEqual(out.map(r => r.id), ['a', 'b', 'c'])
    assert.deepEqual(out[0].accent, { base: '#6E8CF0', deep: '#4F6EE0', text: '#A9B9FA' })
    assert.equal(out[0].mapUrl, 'https://map.example')
    assert.deepEqual(out[0].announcement, { text: 'Hi', date: '2026-10-02', url: 'https://x.example' })
    assert.equal(out[1].kind, 'modpack')
    assert.equal(out[1].accent, null)
    assert.equal(out[1].mapUrl, null)
    assert.equal(out[1].announcement, null)
    assert.equal(out[2].accent, null, 'half a palette is no palette')
    assert.deepEqual(out[2].announcement, { text: 'No link', date: null, url: null })
})

test('sanitizePresentation of something that is not a list is an empty list', () => {
    assert.deepEqual(sanitizePresentation(null), [])
    assert.deepEqual(sanitizePresentation({ releases: [] }), [])
})
