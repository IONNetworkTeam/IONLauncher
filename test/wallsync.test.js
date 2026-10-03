const { test } = require('node:test')
const assert = require('node:assert/strict')
const { emptyManifest, parseManifest, fileNameFor, planSync, settle } = require('../app/assets/js/wallsync')

const w = (id, version = 'v1') => ({ id, version, url: `/api/launcher/wallpapers/${id}?v=${version}` })

test('parseManifest survives garbage', () => {
    assert.deepEqual(parseManifest(null), emptyManifest())
    assert.deepEqual(parseManifest('{"files": {'), emptyManifest())
    assert.deepEqual(parseManifest('[]'), emptyManifest())
})

test('file names are safe and change with the version', () => {
    const a = fileNameFor('lobby_a1b2', '2026-10-03T10:00:00.000Z', '/x/lobby_a1b2?v=1')
    const b = fileNameFor('lobby_a1b2', '2026-10-04T10:00:00.000Z', '/x/lobby_a1b2?v=2')
    assert.match(a, /^lobby_a1b2-[0-9a-f]{8}\.jpg$/)
    assert.notEqual(a, b)
    assert.match(fileNameFor('../../evil', 'v', '/x'), /^\.\._\.\._evil-[0-9a-f]{8}\.jpg$|^[A-Za-z0-9_.-]+\.jpg$/)
    assert.ok(!fileNameFor('../../evil', 'v', '/x').includes('/'))
})

test('first sync downloads everything', () => {
    const { downloads, next } = planSync(emptyManifest(), [{ id: 'R1', wallpapers: [w('a'), w('b')] }])
    assert.deepEqual(downloads.map(d => d.id), ['a', 'b'])
    assert.deepEqual(next.releases, { R1: ['a', 'b'] })
    assert.deepEqual(next.retired, [])
})

test('an unchanged set downloads nothing', () => {
    const first = planSync(emptyManifest(), [{ id: 'R1', wallpapers: [w('a')] }]).next
    const { downloads, next } = planSync(first, [{ id: 'R1', wallpapers: [w('a')] }])
    assert.deepEqual(downloads, [])
    assert.deepEqual(next.files, first.files)
})

test('a removed picture is retired, not deleted', () => {
    const first = planSync(emptyManifest(), [{ id: 'R1', wallpapers: [w('a'), w('b')] }]).next
    const { next } = planSync(first, [{ id: 'R1', wallpapers: [w('a')] }])
    assert.deepEqual(next.releases.R1, ['a'])
    assert.equal(next.files.b, undefined)
    assert.deepEqual(next.retired, [first.files.b.file])
})

test('a new version is a new file; the old one retires', () => {
    const first = planSync(emptyManifest(), [{ id: 'R1', wallpapers: [w('a', 'v1')] }]).next
    const { downloads, next } = planSync(first, [{ id: 'R1', wallpapers: [w('a', 'v2')] }])
    assert.equal(downloads.length, 1)
    assert.notEqual(next.files.a.file, first.files.a.file)
    assert.deepEqual(next.retired, [first.files.a.file])
})

test('a picture shared by two releases is downloaded once', () => {
    const { downloads, next } = planSync(emptyManifest(), [
        { id: 'R1', wallpapers: [w('a')] }, { id: 'R2', wallpapers: [w('a'), w('b')] }
    ])
    assert.deepEqual(downloads.map(d => d.id), ['a', 'b'])
    assert.deepEqual(next.releases, { R1: ['a'], R2: ['a', 'b'] })
})

test('settle: a failed new download drops out; a failed update keeps the old file', () => {
    const prev = planSync(emptyManifest(), [{ id: 'R1', wallpapers: [w('a', 'v1')] }]).next
    const { next } = planSync(prev, [{ id: 'R1', wallpapers: [w('a', 'v2'), w('b')] }])
    const done = settle(next, ['a', 'b'], prev)
    assert.deepEqual(done.releases.R1, ['a'])
    assert.deepEqual(done.files.a, prev.files.a)
    assert.equal(done.files.b, undefined)
    assert.deepEqual(done.retired, [])
})

test('retired files carry over until the store deletes them', () => {
    const m = { ...emptyManifest(), retired: ['old.jpg'] }
    assert.deepEqual(planSync(m, []).next.retired, ['old.jpg'])
})

test('only the site\'s wallpaper path is ever fetched (the fetch carries the site login)', () => {
    const remote = [{ id: 'R1', wallpapers: [
        { id: 'ok', version: 'v1', url: '/api/launcher/wallpapers/ok?v=v1' },
        { id: 'evil', version: 'v1', url: '@other.host/steal' },
        { id: 'abs', version: 'v1', url: 'https://other.host/x.jpg' },
        { id: 'up', version: 'v1', url: '/api/launcher/../admin' }
    ] }]
    const { downloads, next } = planSync(emptyManifest(), remote)
    assert.deepEqual(downloads.map(d => d.id), ['ok'])
    assert.deepEqual(next.releases.R1, ['ok'])
})
