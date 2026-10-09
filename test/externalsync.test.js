const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')

const { SettingsSync } = require('../app/assets/js/settingssync')
const ExternalMC = require('../app/assets/js/externalmc')
const mc = require('../app/assets/js/mcoptions')

const OPTIONS_1_21 = 'version:3955\nfov:0.0\nlang:"en_us"\ngraphicsMode:1\nkey_key.forward:key.keyboard.w\nresourcePacks:["vanilla"]\nlastServer:\n'
const OPTIONS_1_8 = 'fov:0.0\nlang:en_US\nfancyGraphics:true\nkey_key.forward:17\n'

const PACK = { id: 'modern-pack', minecraftVersion: '1.21.1' }
const LEGACY = { id: 'legacy-pack', minecraftVersion: '1.8.9' }

let root
let sync

/** The outside Minecraft, as externalmc.participantFor builds it. */
function external(direction){
    return {
        id: 'external-test',
        dir: path.join(root, 'dot-minecraft'),
        minecraftVersion: '1.21.1',
        hasShaderLoader: false,
        external: true,
        readFrom: direction !== 'export',
        writeTo: direction !== 'import'
    }
}

function gameDir(server){
    return server.dir != null ? server.dir : path.join(root, 'instances', server.id)
}

async function writeOptions(server, text, age = 0){
    const file = path.join(gameDir(server), 'options.txt')
    await fs.outputFile(file, text)
    if(age > 0){
        const when = new Date(Date.now() - age)
        await fs.utimes(file, when, when)
    }
}

async function readEntries(server){
    return mc.entriesOf(mc.parseOptions(await fs.readFile(path.join(gameDir(server), 'options.txt'), 'utf8')))
}

async function makePack(server, name, format = 34){
    const zip = new AdmZip()
    zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: format } })))
    const file = path.join(gameDir(server), 'resourcepacks', name)
    await fs.ensureDir(path.dirname(file))
    await fs.writeFile(file, zip.toBuffer())
    return file
}

function hasPack(server, name){
    return fs.pathExists(path.join(gameDir(server), 'resourcepacks', name))
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ionexternal-'))
    for(const s of [PACK, LEGACY]){
        await fs.ensureDir(gameDir(s))
    }
    await fs.ensureDir(path.join(root, 'dot-minecraft'))
    sync = new SettingsSync({
        instanceDir: path.join(root, 'instances'),
        commonDir: path.join(root, 'common'),
        storePath: path.join(root, 'settingssync.json')
    })
})

afterEach(async () => {
    await fs.remove(root)
})

// Options

test('"from Minecraft": a newly paired folder wins even when older, and is never written', async () => {
    await writeOptions(PACK, OPTIONS_1_21.replace('fov:0.0', 'fov:10.0'))
    await writeOptions(LEGACY, OPTIONS_1_8)
    await writeOptions(external('import'), OPTIONS_1_21.replace('fov:0.0', 'fov:42.0').replace('key.keyboard.w', 'key.keyboard.up'), 60000)
    const before = await fs.readFile(path.join(gameDir(external('import')), 'options.txt'), 'utf8')

    await sync.reconcile([PACK, LEGACY, external('import')])

    assert.equal((await readEntries(PACK)).fov, '42.0')
    assert.equal((await readEntries(LEGACY)).fov, '42.0')
    assert.equal((await readEntries(LEGACY))['key_key.forward'], '200', 'translated to the legacy key code')

    // The player changes a setting in a modpack: it spreads to the modpacks only.
    await writeOptions(PACK, (await fs.readFile(path.join(gameDir(PACK), 'options.txt'), 'utf8')).replace('fov:42.0', 'fov:-5.0'))
    await sync.reconcile([PACK, LEGACY, external('import')], PACK)
    assert.equal((await readEntries(LEGACY)).fov, '-5.0')
    assert.equal(await fs.readFile(path.join(gameDir(external('import')), 'options.txt'), 'utf8'), before, 'the outside folder is untouched')

    // A later change in the outside Minecraft comes in again.
    await writeOptions(external('import'), before.replace('fov:42.0', 'fov:7.0'))
    await sync.reconcile([PACK, LEGACY, external('import')])
    assert.equal((await readEntries(PACK)).fov, '7.0')
})

test('"to Minecraft": the outside folder gets the settings but is never read', async () => {
    await writeOptions(PACK, OPTIONS_1_21.replace('fov:0.0', 'fov:10.0'))
    await writeOptions(external('export'), OPTIONS_1_21.replace('fov:0.0', 'fov:42.0'))

    await sync.reconcile([PACK, external('export')])

    assert.equal((await readEntries(PACK)).fov, '10.0', 'the outside value never comes in')
    const out = await readEntries(external('export'))
    assert.equal(out.fov, '10.0')
    assert.equal(out.resourcePacks, '["vanilla"]', 'its own pack selection is kept')
})

test('"to Minecraft" creates options.txt in an outside folder that has none', async () => {
    await writeOptions(PACK, OPTIONS_1_21.replace('fov:0.0', 'fov:10.0'))
    await sync.reconcile([PACK, external('export')])
    const out = await readEntries(external('export'))
    assert.equal(out.fov, '10.0')
    assert.equal(out.version, '3955')
})

test('"both ways": changes travel in and out', async () => {
    await writeOptions(PACK, OPTIONS_1_21)
    await writeOptions(external('both'), OPTIONS_1_21.replace('fov:0.0', 'fov:42.0'), 60000)
    await sync.reconcile([PACK, external('both')])
    assert.equal((await readEntries(PACK)).fov, '42.0')

    await writeOptions(PACK, (await fs.readFile(path.join(gameDir(PACK), 'options.txt'), 'utf8')).replace('fov:42.0', 'fov:3.0'))
    await sync.reconcile([PACK, external('both')], PACK)
    assert.equal((await readEntries(external('both'))).fov, '3.0')
})

// Packs

test('"from Minecraft": outside packs are linked into modpacks, modpack packs stay out of it', async () => {
    await makePack(external('import'), 'Outside.zip')
    await makePack(PACK, 'Inside.zip')

    await sync.reconcile([PACK, LEGACY, external('import')])

    assert.equal(await hasPack(PACK, 'Outside.zip'), true)
    assert.equal(await hasPack(LEGACY, 'Outside.zip'), false, 'format 34 does not fit 1.8.9')
    assert.equal(await hasPack(external('import'), 'Inside.zip'), false)

    const listed = await sync.listSharedPacks([external('import')])
    const outside = listed.find(p => p.name === 'Outside.zip')
    assert.equal(outside.origin, 'external-test')
    assert.equal(outside.file, path.join(gameDir(external('import')), 'resourcepacks', 'Outside.zip'))
})

test('"to Minecraft": modpack packs go out, the folder\'s own packs are not shared', async () => {
    await makePack(external('export'), 'Outside.zip')
    await makePack(PACK, 'Inside.zip')

    await sync.reconcile([PACK, external('export')])

    assert.equal(await hasPack(external('export'), 'Inside.zip'), true)
    assert.equal(await hasPack(PACK, 'Outside.zip'), false)
})

test('switching from "both ways" to "from Minecraft" takes back the packs linked into the folder', async () => {
    await makePack(PACK, 'Inside.zip')
    await makePack(external('both'), 'Outside.zip')
    await sync.reconcile([PACK, external('both')])
    assert.equal(await hasPack(external('both'), 'Inside.zip'), true)
    assert.equal(await hasPack(PACK, 'Outside.zip'), true)

    await sync.reconcile([PACK, external('import')])
    assert.equal(await hasPack(external('import'), 'Inside.zip'), false)
    assert.equal(await hasPack(PACK, 'Outside.zip'), true)

    await sync.reconcile([PACK, external('export')])
    assert.equal(await hasPack(PACK, 'Outside.zip'), false, 'packs of a folder that no longer shares are taken back')
    assert.equal(await hasPack(external('export'), 'Outside.zip'), true, 'its own copy is never touched')
})

// Finding and describing the outside folder

test('tells a Prism / MultiMC instance from a plain game folder', async () => {
    const inst = path.join(root, 'prism', 'instances', 'Fabulously Optimized')
    await fs.outputFile(path.join(inst, 'instance.cfg'), '[General]\nname=Fabulously Optimized\nInstanceType=OneSix\n')
    await fs.outputJson(path.join(inst, 'mmc-pack.json'), { components: [{ uid: 'org.lwjgl3', version: '3.3.3' }, { uid: 'net.minecraft', version: '1.21.4' }] })
    await fs.ensureDir(path.join(inst, 'minecraft'))

    for(const picked of [inst, path.join(inst, 'minecraft')]){
        const info = await ExternalMC.resolveFolder(picked)
        assert.equal(info.kind, 'mmc')
        assert.equal(info.gameDir, path.join(inst, 'minecraft'))
        assert.equal(info.name, 'Fabulously Optimized')
        assert.equal(info.minecraftVersion, '1.21.4')
    }

    const vanilla = path.join(root, 'dot-minecraft')
    await fs.outputFile(path.join(vanilla, 'options.txt'), 'version:3955\nfov:0.0\n')
    const info = await ExternalMC.resolveFolder(vanilla)
    assert.equal(info.kind, 'vanilla')
    assert.equal(info.gameDir, vanilla)
    assert.equal(info.minecraftVersion, '1.21.1', 'from the data version options.txt was written with')
})

test('lists Prism instances, including a custom instance folder', { skip: process.platform === 'win32' || process.platform === 'darwin' }, async () => {
    const home = path.join(root, 'home')
    const data = path.join(home, '.local', 'share', 'PrismLauncher')
    await fs.outputFile(path.join(data, 'prismlauncher.cfg'), 'InstanceDir=elsewhere\n')
    const inst = path.join(data, 'elsewhere', 'Vanilla Plus')
    await fs.outputFile(path.join(inst, 'instance.cfg'), 'name=Vanilla+\n')
    await fs.outputJson(path.join(inst, 'mmc-pack.json'), { components: [{ uid: 'net.minecraft', version: '1.20.1' }] })
    await fs.ensureDir(path.join(data, 'elsewhere', '_LAUNCHER_TEMP'))

    const saved = process.env.XDG_DATA_HOME
    delete process.env.XDG_DATA_HOME
    try {
        const found = await ExternalMC.listMmcInstances(home)
        assert.deepEqual(found, [{ name: 'Vanilla+', path: inst, minecraftVersion: '1.20.1', launcher: 'Prism Launcher' }])
    } finally {
        if(saved != null){
            process.env.XDG_DATA_HOME = saved
        }
    }
})

test('turns the saved choice into a participant, import by default', async () => {
    const dir = path.join(root, 'dot-minecraft')
    assert.equal(await ExternalMC.participantFor({ path: '', direction: 'both' }), null)
    assert.equal(await ExternalMC.participantFor({ path: path.join(root, 'gone'), direction: 'both' }), null)

    const p = await ExternalMC.participantFor({ path: dir, direction: 'nonsense' })
    assert.equal(p.dir, dir)
    assert.equal(p.readFrom, true)
    assert.equal(p.writeTo, false)
    assert.equal(p.id, ExternalMC.participantId(dir))
    assert.notEqual(p.id, ExternalMC.participantId(path.join(root, 'other')), 'another folder is another participant')

    const both = await ExternalMC.participantFor({ path: dir, direction: 'both' })
    assert.deepEqual([both.readFrom, both.writeTo], [true, true])
    const out = await ExternalMC.participantFor({ path: dir, direction: 'export' })
    assert.deepEqual([out.readFrom, out.writeTo], [false, true])
})

test('an outside folder whose version is unknown still syncs options', async () => {
    const unknown = { ...external('import'), minecraftVersion: null }
    await writeOptions(PACK, OPTIONS_1_21)
    await writeOptions(unknown, OPTIONS_1_21.replace('fov:0.0', 'fov:42.0'))
    await makePack(unknown, 'Outside.zip')
    await sync.reconcile([PACK, unknown])
    assert.equal((await readEntries(PACK)).fov, '42.0')
    assert.equal(await hasPack(PACK, 'Outside.zip'), true)
})

test('maps a data version to the newest release at or below it', () => {
    assert.equal(mc.minecraftForDataVersion(3955), '1.21.1')
    assert.equal(mc.minecraftForDataVersion(3956), '1.21.1')
    assert.equal(mc.minecraftForDataVersion(1343), '1.12.2')
    assert.equal(mc.minecraftForDataVersion(99999), '1.21.8')
    assert.equal(mc.minecraftForDataVersion(0), null)
    assert.equal(mc.minecraftForDataVersion(Number.NaN), null)
})
