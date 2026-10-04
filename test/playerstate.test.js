const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

const { PlayerStateGuard, PLAYER_STATE_FILES } = require('../app/assets/js/playerstate')

let dir

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ionstate-'))
})

afterEach(async () => {
    await fs.remove(dir)
})

test('protects the files Minecraft writes for the player', () => {
    for(const f of ['options.txt', 'servers.dat', 'servers.dat_old', 'optionsshaders.txt']){
        assert.ok(PLAYER_STATE_FILES.includes(f), f)
    }
})

test('restores files the distribution overwrote, and only those', async () => {
    await fs.outputFile(path.join(dir, 'servers.dat'), 'my servers')
    await fs.outputFile(path.join(dir, 'options.txt'), 'fov:30.0\nskipMultiplayerWarning:true\n')
    await fs.outputFile(path.join(dir, 'hotbar.nbt'), 'bar')

    const guard = new PlayerStateGuard(dir)
    assert.equal(await guard.capture(), 3)

    // Validation replaces two of them with the modpack's copies and deletes one.
    await fs.outputFile(path.join(dir, 'servers.dat'), 'modpack servers')
    await fs.outputFile(path.join(dir, 'options.txt'), '')
    await fs.remove(path.join(dir, 'hotbar.nbt'))

    const restored = await guard.restore()
    assert.deepEqual(restored.sort(), ['hotbar.nbt', 'options.txt', 'servers.dat'])
    assert.equal(await fs.readFile(path.join(dir, 'servers.dat'), 'utf8'), 'my servers')
    assert.equal(await fs.readFile(path.join(dir, 'options.txt'), 'utf8'), 'fov:30.0\nskipMultiplayerWarning:true\n')
    assert.equal(await fs.readFile(path.join(dir, 'hotbar.nbt'), 'utf8'), 'bar')
})

test('leaves untouched files and files that did not exist before alone', async () => {
    await fs.outputFile(path.join(dir, 'options.txt'), 'fov:0.0\n')
    const guard = new PlayerStateGuard(dir)
    await guard.capture()

    // A fresh install receives the modpack's server list; nothing to restore.
    await fs.outputFile(path.join(dir, 'servers.dat'), 'modpack servers')
    const before = await fs.stat(path.join(dir, 'options.txt'))

    assert.deepEqual(await guard.restore(), [])
    assert.equal(await fs.readFile(path.join(dir, 'servers.dat'), 'utf8'), 'modpack servers')
    assert.equal((await fs.stat(path.join(dir, 'options.txt'))).mtimeMs, before.mtimeMs)
})
