const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')

const packsync = require('../app/assets/js/packsync')
const { SettingsSync } = require('../app/assets/js/settingssync')

const OLD = { id: 'legacy-pack', minecraftVersion: '1.8.9' }
const NEW = { id: 'modern-pack', minecraftVersion: '1.21.1' }
const SHADERS = { id: 'shader-pack', minecraftVersion: '1.21.1', hasShaderLoader: true }

let root
let sync

function instanceDir(server){
    return path.join(root, 'instances', server.id)
}

async function makeZipPack(server, name, mcmeta, extra = {}){
    const zip = new AdmZip()
    if(mcmeta != null){
        zip.addFile('pack.mcmeta', Buffer.from(typeof mcmeta === 'string' ? mcmeta : JSON.stringify(mcmeta)))
    }
    for(const [file, content] of Object.entries(extra)){
        zip.addFile(file, Buffer.from(content))
    }
    const file = path.join(instanceDir(server), 'resourcepacks', name)
    await fs.ensureDir(path.dirname(file))
    await fs.writeFile(file, zip.toBuffer())
    return file
}

async function makeShaderZip(server, name){
    const zip = new AdmZip()
    zip.addFile('shaders/shaders.properties', Buffer.from('# shaders'))
    const file = path.join(instanceDir(server), 'shaderpacks', name)
    await fs.ensureDir(path.dirname(file))
    await fs.writeFile(file, zip.toBuffer())
    return file
}

async function exists(server, dir, name){
    return fs.pathExists(path.join(instanceDir(server), dir, name))
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ionpacks-'))
    for(const s of [OLD, NEW, SHADERS]){
        await fs.ensureDir(instanceDir(s))
    }
    sync = new SettingsSync({
        instanceDir: path.join(root, 'instances'),
        commonDir: path.join(root, 'common'),
        storePath: path.join(root, 'settingssync.json')
    })
})

afterEach(async () => {
    await fs.remove(root)
})

test('reads pack formats in every pack.mcmeta flavour', () => {
    assert.deepEqual(packsync.formatRangeOf({ pack: { pack_format: 1 } }), { min: 1, max: 1 })
    assert.deepEqual(packsync.formatRangeOf({ pack: { pack_format: 34, supported_formats: [15, 34] } }), { min: 15, max: 34 })
    assert.deepEqual(packsync.formatRangeOf({ pack: { pack_format: 34, supported_formats: { min_inclusive: 32, max_inclusive: 48 } } }), { min: 32, max: 48 })
    assert.deepEqual(packsync.formatRangeOf({ pack: { pack_format: 69, min_format: [64, 0], max_format: [69, 1] } }), { min: 64, max: 69 })
    assert.deepEqual(packsync.formatRangeOf({ pack: { pack_format: [69, 0] } }), { min: 69, max: 69 })
    assert.equal(packsync.formatRangeOf({ pack: {} }), null)
    assert.equal(packsync.formatRangeOf({}), null)
})

test('knows resource pack formats per Minecraft version, from the table and from version.json', () => {
    assert.equal(packsync.resourceFormatForMinecraft('1.8.9'), 1)
    assert.equal(packsync.resourceFormatForMinecraft('1.12.2'), 3)
    assert.equal(packsync.resourceFormatForMinecraft('1.20.1'), 15)
    assert.equal(packsync.resourceFormatForMinecraft('1.21.1'), 34)
    assert.equal(packsync.resourceFormatForMinecraft('1.21.10'), 69)
    assert.equal(packsync.resourceFormatFromVersionJson({ pack_version: 15 }), 15)
    assert.equal(packsync.resourceFormatFromVersionJson({ pack_version: { resource: 34, data: 48 } }), 34)
    assert.equal(packsync.resourceFormatFromVersionJson({ pack_version: { resource_major: 69, resource_minor: 0 } }), 69)
    assert.equal(packsync.resourceFormatFromVersionJson(null), null)
})

test('judges compatibility', () => {
    const meta = { formats: { min: 15, max: 34 } }
    assert.equal(packsync.isCompatible('resource', meta, { resourceFormat: 34 }), true)
    assert.equal(packsync.isCompatible('resource', meta, { resourceFormat: 1 }), false)
    assert.equal(packsync.isCompatible('resource', { formats: null }, { resourceFormat: 34 }), false)
    assert.equal(packsync.isCompatible('shader', { formats: null }, { hasShaderLoader: true }), true)
    assert.equal(packsync.isCompatible('shader', { formats: null }, { hasShaderLoader: false }), false)
})

test('reads metadata from zip and folder packs, including nested zips and lenient JSON', async () => {
    const zipFile = await makeZipPack(NEW, 'a.zip', '{"pack": {"pack_format": 34, "description": "A",}}')
    assert.deepEqual(await packsync.readPackMeta(zipFile, 'resource'), { formats: { min: 34, max: 34 }, description: 'A', valid: true })

    const nested = new AdmZip()
    nested.addFile('Pack Folder/pack.mcmeta', Buffer.from('{"pack":{"pack_format":1}}'))
    const nestedFile = path.join(instanceDir(OLD), 'resourcepacks', 'nested.zip')
    await fs.outputFile(nestedFile, nested.toBuffer())
    assert.deepEqual((await packsync.readPackMeta(nestedFile, 'resource')).formats, { min: 1, max: 1 })

    const folder = path.join(instanceDir(NEW), 'resourcepacks', 'Folder Pack')
    await fs.outputFile(path.join(folder, 'pack.mcmeta'), '﻿{"pack":{"pack_format":34,"description":{"text":"F"}}}')
    assert.deepEqual(await packsync.readPackMeta(folder, 'resource'), { formats: { min: 34, max: 34 }, description: 'F', valid: true })

    const notAPack = path.join(instanceDir(NEW), 'resourcepacks', 'junk.zip')
    await fs.outputFile(notAPack, new AdmZip().toBuffer())
    assert.equal((await packsync.readPackMeta(notAPack, 'resource')).valid, false)

    const shaderFolder = path.join(instanceDir(SHADERS), 'shaderpacks', 'Shady')
    await fs.outputFile(path.join(shaderFolder, 'shaders', 'composite.fsh'), '')
    assert.equal((await packsync.readPackMeta(shaderFolder, 'shader')).valid, true)
})

test('links compatible resource packs into other instances and skips incompatible ones', async () => {
    const src = await makeZipPack(NEW, 'Modern.zip', { pack: { pack_format: 34 } })
    await makeZipPack(NEW, 'Wide.zip', { pack: { pack_format: 34, supported_formats: [1, 99] } })
    await makeZipPack(OLD, 'Ancient.zip', { pack: { pack_format: 1 } })

    await sync.reconcile([OLD, NEW, SHADERS])

    assert.equal(await exists(SHADERS, 'resourcepacks', 'Modern.zip'), true, 'same version gets the pack')
    assert.equal(await exists(OLD, 'resourcepacks', 'Modern.zip'), false, '1.8 does not get a format 34 pack')
    assert.equal(await exists(OLD, 'resourcepacks', 'Wide.zip'), true, 'a pack declaring a wide range goes everywhere')
    assert.equal(await exists(NEW, 'resourcepacks', 'Ancient.zip'), false)

    const linked = await fs.stat(path.join(instanceDir(SHADERS), 'resourcepacks', 'Modern.zip'))
    assert.equal(linked.ino, (await fs.stat(src)).ino, 'zip packs are hard linked')

    const store = await fs.readJson(path.join(root, 'settingssync.json'))
    const rec = store.packs.resourcepacks['Modern.zip']
    assert.equal(rec.origin, NEW.id)
    assert.deepEqual(rec.linked, [SHADERS.id])
})

test('"everywhere" forces a pack into every instance and "off" pulls it back out', async () => {
    await makeZipPack(NEW, 'Forced.zip', { pack: { pack_format: 34 } })

    sync.packs.modes = { 'Forced.zip': 'everywhere' }
    await sync.reconcile([OLD, NEW])
    assert.equal(await exists(OLD, 'resourcepacks', 'Forced.zip'), true)

    sync.packs.modes = {}
    await sync.reconcile([OLD, NEW])
    assert.equal(await exists(OLD, 'resourcepacks', 'Forced.zip'), false, 'back to compatible-only removes it from 1.8')

    sync.packs.modes = { 'Forced.zip': 'everywhere' }
    await sync.reconcile([OLD, NEW])
    sync.packs.modes = { 'Forced.zip': 'off' }
    await sync.reconcile([OLD, NEW])
    assert.equal(await exists(OLD, 'resourcepacks', 'Forced.zip'), false)
    assert.equal(await exists(NEW, 'resourcepacks', 'Forced.zip'), true, 'the origin copy is never touched')
})

test('a copy the player deletes is not linked again, and a deleted origin removes the links', async () => {
    await makeZipPack(NEW, 'P.zip', { pack: { pack_format: 34 } })
    await sync.reconcile([NEW, SHADERS])
    assert.equal(await exists(SHADERS, 'resourcepacks', 'P.zip'), true)

    await fs.remove(path.join(instanceDir(SHADERS), 'resourcepacks', 'P.zip'))
    await sync.reconcile([NEW, SHADERS])
    assert.equal(await exists(SHADERS, 'resourcepacks', 'P.zip'), false)

    const other = { id: 'third', minecraftVersion: '1.21.1' }
    await fs.ensureDir(instanceDir(other))
    await sync.reconcile([NEW, SHADERS, other])
    assert.equal(await exists(other, 'resourcepacks', 'P.zip'), true)

    await fs.remove(path.join(instanceDir(NEW), 'resourcepacks', 'P.zip'))
    await sync.reconcile([NEW, SHADERS, other])
    assert.equal(await exists(other, 'resourcepacks', 'P.zip'), false, 'origin deleted: links go too')
    const store = await fs.readJson(path.join(root, 'settingssync.json'))
    assert.equal(store.packs.resourcepacks['P.zip'], undefined)
})

test('a replaced origin pack is re-linked', async () => {
    const src = await makeZipPack(NEW, 'P.zip', { pack: { pack_format: 34 } })
    await sync.reconcile([NEW, SHADERS])

    await fs.remove(src)
    await new Promise(r => setTimeout(r, 20))
    await makeZipPack(NEW, 'P.zip', { pack: { pack_format: 34, description: 'v2' } })
    await sync.reconcile([NEW, SHADERS])

    const a = await fs.stat(src)
    const b = await fs.stat(path.join(instanceDir(SHADERS), 'resourcepacks', 'P.zip'))
    assert.equal(a.ino, b.ino)
})

test('the player\'s own copy of a pack with the same name is left alone', async () => {
    await makeZipPack(NEW, 'Same.zip', { pack: { pack_format: 34, description: 'theirs' } })
    await makeZipPack(SHADERS, 'Same.zip', { pack: { pack_format: 34, description: 'mine' } })
    await sync.reconcile([NEW, SHADERS])
    const meta = await packsync.readPackMeta(path.join(instanceDir(SHADERS), 'resourcepacks', 'Same.zip'), 'resource')
    assert.equal(meta.description, 'mine')
})

test('shader packs go only to instances with a shader loader; folder packs are symlinked', async () => {
    const src = await makeShaderZip(SHADERS, 'Shiny.zip')
    const folder = path.join(instanceDir(SHADERS), 'shaderpacks', 'Folder Shader')
    await fs.outputFile(path.join(folder, 'shaders', 'composite.fsh'), '')
    await fs.outputFile(path.join(instanceDir(NEW), 'mods', 'iris-1.7.jar'), '')

    await sync.reconcile([OLD, NEW, SHADERS])

    assert.equal(await exists(NEW, 'shaderpacks', 'Shiny.zip'), true, 'a drop-in Iris jar counts as a loader')
    assert.equal(await exists(OLD, 'shaderpacks', 'Shiny.zip'), false)
    assert.equal((await fs.stat(path.join(instanceDir(NEW), 'shaderpacks', 'Shiny.zip'))).ino, (await fs.stat(src)).ino)
    const link = path.join(instanceDir(NEW), 'shaderpacks', 'Folder Shader')
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
    assert.equal(await fs.pathExists(path.join(link, 'shaders', 'composite.fsh')), true)
})

test('invalid or unreadable packs are never shared', async () => {
    await fs.outputFile(path.join(instanceDir(NEW), 'resourcepacks', 'empty.zip'), '')
    await makeZipPack(NEW, 'nometa.zip', null, { 'assets/x.png': 'x' })
    await sync.reconcile([NEW, SHADERS])
    assert.equal(await exists(SHADERS, 'resourcepacks', 'empty.zip'), false)
    assert.equal(await exists(SHADERS, 'resourcepacks', 'nometa.zip'), false)
})

test('pack sharing can be switched off and the UI listing reports modes and formats', async () => {
    await makeZipPack(NEW, 'P.zip', { pack: { pack_format: 34 } })
    sync.packs.enabled = false
    await sync.reconcile([NEW, SHADERS])
    assert.equal(await exists(SHADERS, 'resourcepacks', 'P.zip'), false)

    sync.packs.enabled = true
    sync.packs.modes = { 'P.zip': 'everywhere' }
    await sync.reconcile([NEW, SHADERS])
    const list = await sync.listSharedPacks()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'P.zip')
    assert.equal(list[0].kind, 'resource')
    assert.equal(list[0].mode, 'everywhere')
    assert.deepEqual(list[0].formats, { min: 34, max: 34 })
    assert.deepEqual(list[0].linked, [SHADERS.id])
})
