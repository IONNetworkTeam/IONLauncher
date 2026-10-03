const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createGameState } = require('../app/assets/js/gamestate')

test('a launch goes idle → preparing → starting → running → idle', () => {
    const g = createGameState()
    const seen = []
    g.subscribe((s, id) => seen.push(`${s}:${id}`))
    assert.equal(g.canSwitch(), true)
    g.begin('pack')
    assert.equal(g.canSwitch(), false)
    g.spawned(); g.windowUp(); g.exited()
    assert.deepEqual(seen, ['preparing:pack', 'starting:pack', 'running:pack', 'idle:null'])
    assert.equal(g.canSwitch(), true)
})

test('a second Play click while busy does nothing', () => {
    const g = createGameState()
    g.begin('a'); g.begin('b')
    assert.equal(g.releaseId, 'a')
})

test('out-of-order signals are ignored', () => {
    const g = createGameState()
    g.windowUp(); g.spawned()
    assert.equal(g.state, 'idle')
    g.begin('a'); g.windowUp()
    assert.equal(g.state, 'preparing')
})

test('a failure anywhere unlocks', () => {
    const g = createGameState()
    g.begin('a'); g.spawned(); g.failed()
    assert.equal(g.state, 'idle')
    assert.equal(g.canSwitch(), true)
})

test('a game that exits while still starting unlocks too', () => {
    const g = createGameState()
    g.begin('a'); g.spawned(); g.exited()
    assert.equal(g.state, 'idle')
})
