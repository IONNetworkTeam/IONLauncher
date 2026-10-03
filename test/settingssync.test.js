const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { SettingsSync } = require('../app/assets/js/settingssync')
const mc = require('../app/assets/js/mcoptions')

const OLD = { id: 'legacy-pack', minecraftVersion: '1.8.9' }
const NEW = { id: 'modern-pack', minecraftVersion: '1.21.1' }
const FRESH = { id: 'fresh-pack', minecraftVersion: '1.20.1' }

const OPTIONS_1_8 = 'fov:0.0\nlang:en_US\nfancyGraphics:true\nkey_key.forward:17\nresourcePacks:["A.zip"]\nlastServer:old\n'
const OPTIONS_1_21 = 'version:3955\nfov:0.0\nlang:"en_us"\ngraphicsMode:1\nkey_key.forward:key.keyboard.w\nresourcePacks:["vanilla"]\nlastServer:\n'

let root
let sync

function instanceFile(server, name = 'options.txt'){
    return path.join(root, 'instances', server.id, name)
}

async function writeInstance(server, text, name = 'options.txt'){
    await fs.outputFile(instanceFile(server, name), text)
}

async function readEntries(server, name = 'options.txt'){
    const parsed = mc.parseOptions(await fs.readFile(instanceFile(server, name), 'utf8'), name === 'optionsshaders.txt' ? '=' : ':')
    return mc.entriesOf(parsed)
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ionsync-'))
    sync = new SettingsSync({
        instanceDir: path.join(root, 'instances'),
        commonDir: path.join(root, 'common'),
        storePath: path.join(root, 'settingssync.json')
    })
})

afterEach(async () => {
    await fs.remove(root)
})

test('first reconcile takes the newest instance as the source and aligns the others', async () => {
    await writeInstance(OLD, OPTIONS_1_8)
    await writeInstance(NEW, OPTIONS_1_21.replace('fov:0.0', 'fov:25.0').replace('key.keyboard.w', 'key.keyboard.up'))
    const past = new Date(Date.now() - 60000)
    await fs.utimes(instanceFile(OLD), past, past)

    await sync.reconcile([OLD, NEW])

    const old = await readEntries(OLD)
    assert.equal(old.fov, '25.0')
    assert.equal(old['key_key.forward'], '200')
    assert.equal(old.lang, 'en_US')
    assert.equal(old.resourcePacks, '["A.zip"]')
    assert.equal(old.lastServer, 'old')

    const store = await fs.readJson(path.join(root, 'settingssync.json'))
    assert.equal(store.files['options.txt'].values.fov, '25.0')
    assert.equal(store.files['options.txt'].source, NEW.id)
    assert.ok(store.instances[OLD.id]['options.txt'].hash)
    assert.ok(store.instances[NEW.id]['options.txt'].hash)
})

test('changes made by the game propagate after exit and win over older files', async () => {
    await writeInstance(OLD, OPTIONS_1_8)
    await writeInstance(NEW, OPTIONS_1_21)
    await sync.reconcile([OLD, NEW])

    // The player plays the legacy pack and changes two settings.
    await writeInstance(OLD, OPTIONS_1_8.replace('fov:0.0', 'fov:-10.0').replace('fancyGraphics:true', 'fancyGraphics:false'))
    await sync.reconcile([OLD, NEW], OLD)

    const modern = await readEntries(NEW)
    assert.equal(modern.fov, '-10.0')
    assert.equal(modern.graphicsMode, '0')
    assert.equal(modern.lang, '"en_us"')
    assert.equal(modern.version, '3955')
})

test('an unchanged instance is not rewritten', async () => {
    await writeInstance(OLD, OPTIONS_1_8)
    await writeInstance(NEW, OPTIONS_1_21)
    await sync.reconcile([OLD, NEW])
    const before = await fs.stat(instanceFile(NEW))
    await new Promise(r => setTimeout(r, 20))

    await sync.reconcile([OLD, NEW])
    const after = await fs.stat(instanceFile(NEW))
    assert.equal(after.mtimeMs, before.mtimeMs)
})

test('a new instance gets an options.txt seeded in its own format', async () => {
    await writeInstance(OLD, OPTIONS_1_8.replace('fov:0.0', 'fov:30.0'))
    await sync.reconcile([OLD, FRESH])

    const fresh = await readEntries(FRESH)
    assert.equal(fresh.version, String(mc.dataVersionForMinecraft('1.20.1')))
    assert.equal(fresh.fov, '30.0')
    assert.equal(fresh.lang, '"en_us"')
    assert.equal(fresh.graphicsMode, '1')
    assert.equal(fresh['key_key.forward'], 'key.keyboard.w')
    assert.equal(fresh.resourcePacks, undefined)
    assert.equal(fresh.lastServer, undefined)

    // Minecraft then rewrites the file on exit with the same values; nothing is ingested back.
    await sync.reconcile([OLD, FRESH], FRESH)
    assert.equal((await readEntries(OLD)).fov, '30.0')
})

test('a new instance with an unknown data version is left alone', async () => {
    const unknown = { id: 'future-pack', minecraftVersion: '1.99.1' }
    await writeInstance(OLD, OPTIONS_1_8)
    await sync.reconcile([OLD, unknown])
    assert.equal(await fs.pathExists(instanceFile(unknown)), false)
})

test('instances that do not take part are neither read nor written', async () => {
    await writeInstance(OLD, OPTIONS_1_8)
    await writeInstance(NEW, OPTIONS_1_21.replace('fov:0.0', 'fov:50.0'))
    await sync.reconcile([OLD])
    assert.equal((await readEntries(OLD)).fov, '0.0')
    assert.equal((await readEntries(NEW)).fov, '50.0')
})

test('OptiFine and shader option files sync by key, except the selected shader pack', async () => {
    await writeInstance(OLD, OPTIONS_1_8)
    await writeInstance(NEW, OPTIONS_1_21)
    await writeInstance(OLD, 'ofFogType:1\nofAoLevel:1.0\n', 'optionsof.txt')
    await writeInstance(NEW, 'ofFogType:3\nofAoLevel:1.0\nofNewKey:true\n', 'optionsof.txt')
    await writeInstance(OLD, 'shaderPack=A.zip\nshadowResolution=1024\n', 'optionsshaders.txt')
    await writeInstance(NEW, 'shaderPack=B.zip\nshadowResolution=4096\n', 'optionsshaders.txt')
    const past = new Date(Date.now() - 60000)
    for(const name of ['options.txt', 'optionsof.txt', 'optionsshaders.txt']){
        await fs.utimes(instanceFile(OLD, name), past, past)
    }

    await sync.reconcile([OLD, NEW])

    const of = await readEntries(OLD, 'optionsof.txt')
    assert.equal(of.ofFogType, '3')
    assert.equal(of.ofNewKey, undefined)
    const shaders = await readEntries(OLD, 'optionsshaders.txt')
    assert.equal(shaders.shaderPack, 'A.zip')
    assert.equal(shaders.shadowResolution, '4096')
})

test('survives a corrupt store file', async () => {
    await fs.outputFile(path.join(root, 'settingssync.json'), '{not json')
    await writeInstance(OLD, OPTIONS_1_8)
    await sync.reconcile([OLD])
    const store = await fs.readJson(path.join(root, 'settingssync.json'))
    assert.equal(store.version, 1)
})
