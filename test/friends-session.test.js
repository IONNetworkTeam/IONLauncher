const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createSessionStore, MOJANG_JOIN_URL, START_PATH, COMPLETE_PATH, SESSION_PATH, RATE_LIMIT_BACKOFF_MS } = require('../app/assets/js/friends/session')

const UUID = 'a900acbf-ffc1-4ebc-899c-e1e17141cf5d'
const TOKEN = 'ab'.repeat(32)
const account = { uuid: UUID, displayName: 'Player_1', accessToken: 'mc-secret' }

/** A website that answers in order, recording every call. */
function fakeWeb(answers){
    const calls = []
    const fetchJson = async (path, init = {}) => {
        calls.push({ path, ...init })
        const next = answers.shift()
        if(next instanceof Error) throw next
        return next ?? { ok: false, status: 500 }
    }
    return { calls, fetchJson }
}

function fakeMojang(status = 204){
    const calls = []
    return { calls, fetchMojang: async (url, init) => { calls.push({ url, ...init }); return { status } } }
}

function store(web, mojang, extra = {}){
    let saved = extra.saved ?? null
    const s = createSessionStore({
        fetchJson: web.fetchJson, fetchMojang: mojang.fetchMojang,
        load: () => saved, save: t => { saved = t },
        now: extra.now ?? (() => 1000), ...extra.deps
    })
    return { s, saved: () => saved }
}

const started = { ok: true, status: 200, data: { serverId: 'srv-1' } }
const completed = { ok: true, status: 200, data: { token: TOKEN, expiresAt: '2026-11-02T00:00:00.000Z' } }

test('mints a session: start, Mojang join with the undashed uuid, complete; then reuses it', async () => {
    const web = fakeWeb([started, completed])
    const mojang = fakeMojang()
    const { s, saved } = store(web, mojang)

    assert.deepEqual(await s.ensure(account), { token: TOKEN })
    assert.equal(web.calls[0].path, START_PATH)
    assert.deepEqual(web.calls[0].body, { uuid: UUID, name: 'Player_1' })
    assert.equal(mojang.calls[0].url, MOJANG_JOIN_URL)
    assert.deepEqual(JSON.parse(mojang.calls[0].body), { accessToken: 'mc-secret', selectedProfile: 'a900acbfffc14ebc899ce1e17141cf5d', serverId: 'srv-1' })
    assert.equal(web.calls[1].path, COMPLETE_PATH)
    assert.deepEqual(web.calls[1].body, { uuid: UUID, serverId: 'srv-1' })
    // The Minecraft token never reaches the website.
    assert.ok(!JSON.stringify(web.calls).includes('mc-secret'))
    assert.equal(JSON.parse(saved())[UUID].token, TOKEN)

    assert.deepEqual(await s.ensure(account), { token: TOKEN })
    assert.equal(web.calls.length, 2)
    assert.equal(s.get(UUID), TOKEN)
})

test('a stored session is used without a handshake; garbage in the store is ignored', async () => {
    const web = fakeWeb([])
    const { s } = store(web, fakeMojang(), { saved: JSON.stringify({ [UUID]: { token: TOKEN, expiresAt: 10 ** 12 }, other: { token: 'nope' } }) })
    assert.deepEqual(await s.ensure(account), { token: TOKEN })
    assert.deepEqual(s.accounts(), [UUID])
    assert.equal(web.calls.length, 0)

    const { s: s2 } = store(fakeWeb([]), fakeMojang(), { saved: '{not json' })
    assert.equal(s2.get(UUID), null)
})

test('an expired or nearly expired token is minted again', async () => {
    const web = fakeWeb([started, completed])
    const { s } = store(web, fakeMojang(), { saved: JSON.stringify({ [UUID]: { token: 'cd'.repeat(32), expiresAt: 1000 + 60000 } }) })
    assert.deepEqual(await s.ensure(account), { token: TOKEN })
    assert.equal(web.calls.length, 2)
})

test('429 on start backs off for a minute without touching Mojang', async () => {
    let t = 1000
    const web = fakeWeb([{ ok: false, status: 429 }, started, completed])
    const mojang = fakeMojang()
    const { s } = store(web, mojang, { now: () => t })
    assert.deepEqual(await s.ensure(account), { token: null, reason: 'rate_limited' })
    assert.equal(mojang.calls.length, 0)
    assert.equal(s.blockedUntil, 1000 + RATE_LIMIT_BACKOFF_MS)
    assert.deepEqual(await s.ensure(account), { token: null, reason: 'rate_limited' })
    assert.equal(web.calls.length, 1)
    t += RATE_LIMIT_BACKOFF_MS
    assert.deepEqual(await s.ensure(account), { token: TOKEN })
})

test('a refused Mojang join means the Minecraft token is stale; nothing is stored', async () => {
    const web = fakeWeb([started])
    const { s, saved } = store(web, fakeMojang(403))
    assert.deepEqual(await s.ensure(account), { token: null, reason: 'mojang' })
    assert.equal(web.calls.length, 1)
    assert.equal(saved(), null)
})

test('503 and network failures degrade with their own reasons', async () => {
    const { s } = store(fakeWeb([{ ok: false, status: 503, data: { error: 'Friends are unavailable right now.' } }]), fakeMojang())
    assert.deepEqual(await s.ensure(account), { token: null, reason: 'unavailable' })
    const { s: s2 } = store(fakeWeb([new Error('ENOTFOUND')]), fakeMojang())
    assert.deepEqual(await s2.ensure(account), { token: null, reason: 'offline' })
    const { s: s3 } = store(fakeWeb([started, { ok: false, status: 400, data: { error: 'That handshake is not valid.', code: 'BAD_REQUEST' } }]), fakeMojang())
    assert.deepEqual(await s3.ensure(account), { token: null, reason: 'invalid' })
})

test('concurrent callers share one handshake', async () => {
    const web = fakeWeb([started, completed])
    const { s } = store(web, fakeMojang())
    const [a, b] = await Promise.all([s.ensure(account), s.ensure(account)])
    assert.deepEqual([a, b], [{ token: TOKEN }, { token: TOKEN }])
    assert.equal(web.calls.length, 2)
})

test('end tells the website with the bearer and drops the token even when that fails', async () => {
    const web = fakeWeb([started, completed, new Error('offline')])
    const { s, saved } = store(web, fakeMojang())
    await s.ensure(account)
    await s.end(UUID)
    assert.equal(web.calls[2].path, SESSION_PATH)
    assert.equal(web.calls[2].method, 'DELETE')
    assert.equal(web.calls[2].bearer, TOKEN)
    assert.equal(s.get(UUID), null)
    assert.deepEqual(JSON.parse(saved()), {})
    // Nothing stored: nothing to tell.
    await s.end(UUID)
    assert.equal(web.calls.length, 3)
})

test('invalidate forgets a token the website refused, so the next call mints again', async () => {
    const web = fakeWeb([started, completed, started, { ok: true, status: 200, data: { token: 'ef'.repeat(32), expiresAt: '2026-11-02T00:00:00.000Z' } }])
    const { s } = store(web, fakeMojang())
    await s.ensure(account)
    s.invalidate(UUID)
    assert.deepEqual(await s.ensure(account), { token: 'ef'.repeat(32) })
})

test('no account, no handshake', async () => {
    const web = fakeWeb([])
    const { s } = store(web, fakeMojang())
    assert.deepEqual(await s.ensure(null), { token: null, reason: 'invalid' })
    assert.deepEqual(await s.ensure({ uuid: UUID, displayName: 'x' }), { token: null, reason: 'invalid' })
    assert.equal(web.calls.length, 0)
})
