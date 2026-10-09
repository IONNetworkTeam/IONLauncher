const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { ModrinthIcons, packSearchName } = require('../app/assets/js/modrinthicons')

let root

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modrinthicons-'))
})

afterEach(async () => {
    await fs.remove(root)
})

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex')

/**
 * A fake Modrinth: `versions` maps file hashes to project ids, `projects` project ids to icons,
 * `search` search hits. Every call is recorded.
 */
function fakeModrinth({ versions = {}, projects = {}, search = [], status = 200 } = {}){
    const calls = []
    const request = async (url, options) => {
        calls.push({ url, json: options.json })
        if(status !== 200){
            return { statusCode: status, body: null }
        }
        const u = new URL(url)
        if(u.pathname.endsWith('/version_files')){
            const body = {}
            for(const h of options.json.hashes){
                if(versions[h]) body[h] = { project_id: versions[h] }
            }
            return { statusCode: 200, body }
        }
        if(u.pathname.endsWith('/projects')){
            const ids = JSON.parse(u.searchParams.get('ids'))
            return { statusCode: 200, body: ids.map(id => ({ id, icon_url: projects[id] ?? null })) }
        }
        if(u.pathname.endsWith('/search')){
            return { statusCode: 200, body: { hits: search } }
        }
        throw new Error(`unexpected ${url}`)
    }
    return { request, calls }
}

async function pack(name, content){
    const file = path.join(root, 'shaderpacks', name)
    await fs.outputFile(file, content)
    return file
}

test('packSearchName keeps the name a pack file starts with', () => {
    assert.equal(packSearchName('ComplementaryReimagined_r5.6.1.zip'), 'Complementary Reimagined')
    assert.equal(packSearchName('ComplementaryUnbound_r5.6.1 + EuphoriaPatches_1.7.7'), 'Complementary Unbound')
    assert.equal(packSearchName('Bliss-Shader-main.zip'), 'Bliss Shader')
    assert.equal(packSearchName('BSL_v8.4.02.2.zip'), 'BSL')
    assert.equal(packSearchName('rethinking-voxels_r0.1-beta5.zip'), 'rethinking voxels')
})

test('matches zips by hash, several in one batch', async () => {
    const a = await pack('a.zip', 'aaa')
    const b = await pack('b.zip', 'bbb')
    const fake = fakeModrinth({ versions: { [sha1('aaa')]: 'P1', [sha1('bbb')]: 'P2' }, projects: { P1: 'https://cdn/p1.png', P2: 'https://cdn/p2.png' } })
    const icons = new ModrinthIcons({ cacheFile: path.join(root, 'cache.json'), request: fake.request })
    assert.deepEqual(await Promise.all([icons.lookupPackIcon(a, 'shader'), icons.lookupPackIcon(b, 'shader')]), ['https://cdn/p1.png', 'https://cdn/p2.png'])
    assert.equal(fake.calls.filter(c => c.url.includes('/version_files')).length, 1)
    assert.deepEqual(fake.calls[0].json.hashes.sort(), [sha1('aaa'), sha1('bbb')].sort())
})

test('falls back to a search only accepting an exact name', async () => {
    const file = await pack('ComplementaryReimagined_r5.6.1.zip', 'unknown to modrinth')
    const fake = fakeModrinth({ search: [
        { slug: 'nova-reimagined', title: 'Nova Reimagined', icon_url: 'https://cdn/wrong.png' },
        { slug: 'complementary-reimagined', title: 'Complementary Shaders - Reimagined', icon_url: 'https://cdn/right.png' }
    ] })
    const icons = new ModrinthIcons({ cacheFile: path.join(root, 'cache.json'), request: fake.request })
    assert.equal(await icons.lookupPackIcon(file, 'shader'), 'https://cdn/right.png')
    const search = new URL(fake.calls.find(c => c.url.includes('/search')).url)
    assert.equal(search.searchParams.get('query'), 'Complementary Reimagined')
    assert.deepEqual(JSON.parse(search.searchParams.get('facets')), [['project_type:shader']])
})

test('a search without an exact match gives null', async () => {
    const dir = path.join(root, 'shaderpacks', 'MyOwnShader')
    await fs.ensureDir(dir)
    const fake = fakeModrinth({ search: [{ slug: 'my-own-shader-plus', title: 'My Own Shader Plus', icon_url: 'https://cdn/x.png' }] })
    const icons = new ModrinthIcons({ cacheFile: path.join(root, 'cache.json'), request: fake.request })
    assert.equal(await icons.lookupPackIcon(dir, 'shader'), null)
    // Folders are not hashed.
    assert.equal(fake.calls.some(c => c.url.includes('/version_files')), false)
})

test('results are cached on disk; failures are not', async () => {
    const cacheFile = path.join(root, 'cache.json')
    const file = await pack('a.zip', 'aaa')

    const down = fakeModrinth({ status: 503 })
    assert.equal(await new ModrinthIcons({ cacheFile, request: down.request }).lookupPackIcon(file, 'shader'), null)

    const up = fakeModrinth({ versions: { [sha1('aaa')]: 'P1' }, projects: { P1: 'https://cdn/p1.png' } })
    const first = new ModrinthIcons({ cacheFile, request: up.request })
    assert.equal(await first.lookupPackIcon(file, 'shader'), 'https://cdn/p1.png')
    await new Promise(r => setTimeout(r, 700))

    const offline = fakeModrinth({ status: 503 })
    assert.equal(await new ModrinthIcons({ cacheFile, request: offline.request }).lookupPackIcon(file, 'shader'), 'https://cdn/p1.png')
    assert.equal(offline.calls.length, 0)
})
