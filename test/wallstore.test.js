const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { createWallStore } = require('../app/assets/js/wallstore')

const quiet = { info(){}, warn(){}, error(){} }
async function tmp(){ return fs.mkdtemp(path.join(os.tmpdir(), 'walls-')) }
function remote(sets){
    return { releases: Object.entries(sets).map(([id, ws]) => ({ id, wallpapers: ws.map(([wid, v]) => ({ id: wid, version: v, url: `/api/launcher/wallpapers/${wid}?v=${v}` })) })) }
}

test('a fresh store lists nothing and does not throw offline', async () => {
    const dir = await tmp()
    const s = createWallStore({ dir, fetchJson: async () => null, fetchBytes: async () => null, onChange(){}, logger: quiet })
    await s.open()
    assert.deepEqual(s.list(), { releases: {} })
    assert.equal(await s.sync(), false)
})

test('sync downloads, lists absolute paths, and tells the window', async () => {
    const dir = await tmp()
    let changed = null
    const s = createWallStore({
        dir,
        fetchJson: async (p) => (assert.equal(p, '/api/launcher/releases'), remote({ R1: [['a', 'v1'], ['b', 'v1']] })),
        fetchBytes: async (p) => Buffer.from(p),
        onChange: (l) => { changed = l },
        logger: quiet
    })
    await s.open()
    assert.equal(await s.sync(), true)
    const files = s.list().releases.R1
    assert.equal(files.length, 2)
    assert.ok(path.isAbsolute(files[0]))
    assert.equal(await fs.readFile(files[0], 'utf8'), '/api/launcher/wallpapers/a?v=v1')
    assert.deepEqual(changed, s.list())
    assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.tmp')), [])
})

test('a removed picture keeps its file until the next start', async () => {
    const dir = await tmp()
    let sets = { R1: [['a', 'v1'], ['b', 'v1']] }
    const opts = { dir, fetchJson: async () => remote(sets), fetchBytes: async () => Buffer.from('x'), onChange(){}, logger: quiet }
    const s = createWallStore(opts)
    await s.open(); await s.sync()
    const bFile = s.list().releases.R1[1]
    sets = { R1: [['a', 'v1']] }
    await s.sync()
    assert.equal(s.list().releases.R1.length, 1)
    await fs.access(bFile)                       // still there this session
    const again = createWallStore(opts)
    await again.open()                           // next start
    await assert.rejects(fs.access(bFile))       // gone
})

test('a failed download keeps the old version and leaves no temp file', async () => {
    const dir = await tmp()
    let fail = false
    let sets = { R1: [['a', 'v1']] }
    const s = createWallStore({
        dir, fetchJson: async () => remote(sets),
        fetchBytes: async () => (fail ? null : Buffer.from('v1')),
        onChange(){}, logger: quiet
    })
    await s.open(); await s.sync()
    const before = s.list().releases.R1[0]
    sets = { R1: [['a', 'v2']] }; fail = true
    await s.sync()
    assert.deepEqual(s.list().releases.R1, [before])
    assert.deepEqual((await fs.readdir(dir)).filter(f => f.endsWith('.tmp')), [])
})

test('a corrupt manifest starts empty', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'manifest.json'), '{"files": {')
    await fs.writeFile(path.join(dir, 'stray.tmp'), 'half')
    const s = createWallStore({ dir, fetchJson: async () => null, fetchBytes: async () => null, onChange(){}, logger: quiet })
    await s.open()
    assert.deepEqual(s.list(), { releases: {} })
    await assert.rejects(fs.access(path.join(dir, 'stray.tmp')))
})
