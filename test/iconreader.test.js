const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')

const { readPackIcon, readModIcon, pickSizedIcon } = require('../app/assets/js/iconreader')

// Not a real image; the reader only cares about the name and the bytes.
const PNG = Buffer.from('\x89PNG fake icon', 'binary')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`

let root

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'iconreader-'))
})

afterEach(async () => {
    await fs.remove(root)
})

function makeZip(name, files){
    const zip = new AdmZip()
    for(const [file, content] of Object.entries(files)){
        zip.addFile(file, Buffer.isBuffer(content) ? content : Buffer.from(content))
    }
    const file = path.join(root, name)
    zip.writeZip(file)
    return file
}

test('reads pack.png from a zipped resource pack', async () => {
    const file = makeZip('pack.zip', { 'pack.mcmeta': '{}', 'pack.png': PNG })
    assert.equal(await readPackIcon(file), PNG_URL)
})

test('reads pack.png from a pack zipped with a top level folder', async () => {
    const file = makeZip('nested.zip', { 'Nested/pack.mcmeta': '{}', 'Nested/pack.png': PNG })
    assert.equal(await readPackIcon(file), PNG_URL)
})

test('reads pack.png from a folder pack', async () => {
    const dir = path.join(root, 'folder')
    await fs.outputFile(path.join(dir, 'pack.png'), PNG)
    assert.equal(await readPackIcon(dir), PNG_URL)
})

test('a pack without an icon or a missing file gives null', async () => {
    assert.equal(await readPackIcon(makeZip('plain.zip', { 'shaders/final.fsh': '' })), null)
    assert.equal(await readPackIcon(path.join(root, 'missing.zip')), null)
})

test('reads the icon a fabric.mod.json names', async () => {
    const file = makeZip('fabric.jar', {
        'fabric.mod.json': JSON.stringify({ id: 'x', icon: 'assets/x/icon.png' }),
        'assets/x/icon.png': PNG
    })
    assert.equal(await readModIcon(file), PNG_URL)
})

test('reads the logoFile of a mods.toml, top level or per mod', async () => {
    const top = makeZip('forge.jar', {
        'META-INF/mods.toml': 'modLoader="javafml"\nlogoFile="logo.png"\n[[mods]]\nmodId="x"\n',
        'logo.png': PNG
    })
    assert.equal(await readModIcon(top), PNG_URL)
    const perMod = makeZip('neoforge.jar', {
        'META-INF/neoforge.mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="x"\nlogoFile="x_logo.png"\n',
        'x_logo.png': PNG
    })
    assert.equal(await readModIcon(perMod), PNG_URL)
})

test('reads the logoFile of an mcmod.info', async () => {
    const file = makeZip('legacy.jar', {
        'mcmod.info': JSON.stringify([{ modid: 'x', logoFile: '/assets/x/logo.png' }]),
        'assets/x/logo.png': PNG
    })
    assert.equal(await readModIcon(file), PNG_URL)
})

test('falls through to later candidates when the named icon is missing', async () => {
    const file = makeZip('broken.jar', {
        'fabric.mod.json': JSON.stringify({ id: 'x', icon: 'nope.png' }),
        'pack.png': PNG
    })
    assert.equal(await readModIcon(file), PNG_URL)
})

test('falls back to an undeclared assets/<modid>/icon.png', async () => {
    const file = makeZip('multiloader.jar', {
        'META-INF/mods.toml': 'modLoader="javafml"\n[[mods]]\nmodId="multi"\n',
        'assets/other/textures/a.png': Buffer.from('not it'),
        'assets/multi/icon.png': PNG
    })
    assert.equal(await readModIcon(file), PNG_URL)
})

test('a mod without an icon gives null', async () => {
    assert.equal(await readModIcon(makeZip('bare.jar', { 'fabric.mod.json': '{"id":"x"}' })), null)
})

test('pickSizedIcon prefers the smallest icon of at least 64px', () => {
    assert.equal(pickSizedIcon('a.png'), 'a.png')
    assert.equal(pickSizedIcon({ 16: 's.png', 64: 'm.png', 512: 'l.png' }), 'm.png')
    assert.equal(pickSizedIcon({ 16: 's.png', 32: 'm.png' }), 'm.png')
    assert.equal(pickSizedIcon(null), null)
})
