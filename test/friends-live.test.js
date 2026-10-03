const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLiveChannel, PING_MS, POLL_MS, CHANNEL } = require('../app/assets/js/friends/live')

/** Deterministic timers: every scheduled callback with its delay, fired by hand. */
function clock(){
    const timeouts = []
    const intervals = []
    return {
        timeouts, intervals,
        timers: {
            setTimeout: (fn, ms) => { const h = { fn, ms }; timeouts.push(h); return h },
            clearTimeout: h => { const i = timeouts.indexOf(h); if(i >= 0) timeouts.splice(i, 1) },
            setInterval: (fn, ms) => { const h = { fn, ms }; intervals.push(h); return h },
            clearInterval: h => { const i = intervals.indexOf(h); if(i >= 0) intervals.splice(i, 1) }
        },
        fireTimeouts(){ const list = timeouts.splice(0); list.forEach(h => h.fn()) },
        fireIntervals(){ intervals.forEach(h => h.fn()) }
    }
}

/** A WebSocket class that records instances and lets the test play the server. */
function fakeSocketClass(){
    const sockets = []
    class FakeWS {
        constructor(url){ this.url = url; this.sent = []; sockets.push(this) }
        send(s){ this.sent.push(JSON.parse(s)) }
        close(){ this.closed = true }
        open(){ this.onopen?.() }
        receive(frame){ this.onmessage?.({ data: JSON.stringify(frame) }) }
        drop(){ this.onclose?.() }
    }
    return { FakeWS, sockets }
}

const flush = () => new Promise(r => setImmediate(r))

function harness(opts = {}){
    const c = clock()
    const { FakeWS, sockets } = fakeSocketClass()
    const events = []
    const snapshots = []
    const statuses = []
    let tickets = opts.tickets ?? [{ ok: true, data: { ticket: 'tk1' } }, { ok: true, data: { ticket: 'tk2' } }, { ok: true, data: { ticket: 'tk3' } }]
    const ticketCalls = []
    const live = createLiveChannel({
        ticket: async () => { ticketCalls.push(1); return tickets.length > 1 ? tickets.shift() : tickets[0] },
        poll: async () => opts.poll ?? { ok: true, data: { friends: [{ uuid: 'u1', presence: { status: 'online' } }] } },
        url: 'wss://example.test/api/launcher/friends/ws',
        onEvent: (e, f) => events.push([e, f]),
        onSnapshot: f => snapshots.push(f),
        onStatus: up => statuses.push(up),
        WebSocket: FakeWS,
        timers: c.timers
    })
    return { live, c, sockets, events, snapshots, statuses, ticketCalls }
}

test('connects with a fresh ticket, authenticates, subscribes and pings every 30 s', async () => {
    const h = harness()
    h.live.start()
    await flush()
    assert.equal(h.sockets.length, 1)
    const s = h.sockets[0]
    assert.equal(s.url, 'wss://example.test/api/launcher/friends/ws')
    s.open()
    assert.deepEqual(s.sent, [{ type: 'auth', ticket: 'tk1' }])
    s.receive({ type: 'auth_ok', mcUuid: 'me' })
    assert.deepEqual(s.sent[1], { type: 'subscribe', channel: CHANNEL })
    assert.deepEqual(h.statuses, [true])
    const ping = h.c.intervals.find(i => i.ms === PING_MS)
    assert.ok(ping)
    ping.fn()
    assert.deepEqual(s.sent[2], { type: 'ping' })
    s.receive({ type: 'pong' })
    assert.equal(h.events.length, 0)
})

test('dispatches only friends frames from the notifications channel, by event', async () => {
    const h = harness()
    h.live.start(); await flush()
    const s = h.sockets[0]
    s.open(); s.receive({ type: 'auth_ok' })
    s.receive({ channel: CHANNEL, data: { type: 'friends', event: 'presence', friend: { uuid: 'u1', presence: { status: 'playing' } } } })
    s.receive({ channel: CHANNEL, data: { type: 'coins', event: 'presence', balance: 3 } })
    s.receive({ channel: 'other', data: { type: 'friends', event: 'presence' } })
    s.receive({ channel: CHANNEL, data: { type: 'friends', event: 'made_up' } })
    s.receive({ channel: CHANNEL, data: { type: 'friends', event: 'invite_expired', from: 'u2' } })
    s.onmessage({ data: 'not json' })
    assert.deepEqual(h.events.map(([e]) => e), ['presence', 'invite_expired'])
    assert.equal(h.events[0][1].friend.uuid, 'u1')
})

test('reconnects with a doubling backoff and a new ticket each time; auth_ok resets it', async () => {
    const h = harness()
    h.live.start(); await flush()
    h.sockets[0].open(); h.sockets[0].receive({ type: 'auth_ok' })
    h.sockets[0].drop()
    assert.deepEqual(h.statuses, [true, false])
    assert.equal(h.c.timeouts[0].ms, 1000)
    h.c.fireTimeouts(); await flush()
    assert.equal(h.sockets.length, 2)
    assert.equal(h.ticketCalls.length, 2)
    h.sockets[1].open()
    assert.deepEqual(h.sockets[1].sent[0], { type: 'auth', ticket: 'tk2' })
    h.sockets[1].drop()
    assert.equal(h.c.timeouts[0].ms, 2000)
    h.c.fireTimeouts(); await flush()
    h.sockets[2].drop()
    assert.equal(h.c.timeouts[0].ms, 4000)
    h.c.fireTimeouts(); await flush()
    h.sockets[3].open(); h.sockets[3].receive({ type: 'auth_ok' })
    h.sockets[3].drop()
    assert.equal(h.c.timeouts[0].ms, 1000)
})

test('the backoff tops out at 30 s', async () => {
    const h = harness()
    h.live.start(); await flush()
    const waits = []
    for(let i = 0; i < 8; i++){
        h.sockets.at(-1).drop()
        waits.push(h.c.timeouts[0].ms)
        h.c.fireTimeouts(); await flush()
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('a refused ticket closes the socket and retries; no ticket at all just waits', async () => {
    const h = harness()
    h.live.start(); await flush()
    h.sockets[0].open(); h.sockets[0].receive({ type: 'auth_error', message: 'expired' })
    assert.equal(h.sockets[0].closed, true)
    assert.equal(h.c.timeouts.length, 1)

    const h2 = harness({ tickets: [{ ok: false, status: 0, code: 'NO_SESSION' }] })
    h2.live.start(); await flush()
    assert.equal(h2.sockets.length, 0)
    assert.equal(h2.c.timeouts[0].ms, 1000)
    assert.equal(h2.live.connected, false)
})

test('polls presence every 60 s whatever the socket does, and on demand', async () => {
    const h = harness()
    h.live.start(); await flush()
    const pollTimer = h.c.intervals.find(i => i.ms === POLL_MS)
    assert.ok(pollTimer)
    pollTimer.fn(); await flush()
    assert.equal(h.snapshots.length, 1)
    assert.equal(h.snapshots[0][0].uuid, 'u1')
    await h.live.poll()
    assert.equal(h.snapshots.length, 2)
})

test('stop closes everything and nothing fires afterwards', async () => {
    const h = harness()
    h.live.start(); await flush()
    h.sockets[0].open(); h.sockets[0].receive({ type: 'auth_ok' })
    h.live.stop()
    assert.equal(h.sockets[0].closed, true)
    assert.deepEqual(h.c.intervals, [])
    assert.deepEqual(h.c.timeouts, [])
    assert.deepEqual(h.statuses, [true, false])
    h.sockets[0].drop()
    assert.equal(h.sockets.length, 1)
})
