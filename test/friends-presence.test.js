const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createPresence, INTERVAL_MS } = require('../app/assets/js/friends/presence')

function clock(){
    const timers = []
    return {
        timers,
        setInterval: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
        clearInterval: t => { const i = timers.indexOf(t); if(i >= 0) timers.splice(i, 1) },
        tick: () => timers.forEach(t => t.fn())
    }
}

function harness(){
    const sent = []
    const c = clock()
    const p = createPresence({ put: async body => { sent.push(body); return { ok: true, status: 204 } }, setInterval: c.setInterval, clearInterval: c.clearInterval })
    return { p, sent, c }
}

const flush = () => new Promise(r => setImmediate(r))

test('starts idle, beats every 30 s, and stops', async () => {
    const { p, sent, c } = harness()
    assert.equal(INTERVAL_MS, 30000)
    p.set('idle', 'pack_1')
    p.start()
    await flush()
    assert.deepEqual(sent, [{ state: 'idle', release: 'pack_1' }])
    assert.equal(c.timers[0].ms, 30000)
    c.tick(); await flush()
    assert.equal(sent.length, 2)
    p.stop()
    assert.equal(c.timers.length, 0)
    c.tick(); await flush()
    assert.equal(sent.length, 2)
})

test('a change is sent at once; the same state again is not', async () => {
    const { p, sent } = harness()
    p.start(); await flush()
    p.set('playing', 'pack_1'); await flush()
    p.set('playing', 'pack_1'); await flush()
    p.set('idle', 'pack_1'); await flush()
    assert.deepEqual(sent, [{ state: 'idle' }, { state: 'playing', release: 'pack_1' }, { state: 'idle', release: 'pack_1' }])
    assert.equal(p.state, 'idle')
    assert.equal(p.release, 'pack_1')
})

test('nothing is sent before start, and a release of null is left out', async () => {
    const { p, sent } = harness()
    p.set('playing', 'x'); await flush()
    assert.deepEqual(sent, [])
    p.set('idle', null)
    p.start(); await flush()
    assert.deepEqual(sent, [{ state: 'idle' }])
})

test('gone stops the beat and says so once', async () => {
    const { p, sent, c } = harness()
    p.start(); await flush()
    await p.gone()
    assert.deepEqual(sent.at(-1), { state: 'gone' })
    assert.equal(c.timers.length, 0)
    assert.equal(p.running, false)
})

test('a failing put never throws out of the beat', async () => {
    const c = clock()
    const p = createPresence({ put: async () => { throw new Error('boom') }, setInterval: c.setInterval, clearInterval: c.clearInterval })
    p.start()
    await flush()
    c.tick()
    await flush()
    assert.equal(p.running, true)
})
