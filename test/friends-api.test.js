const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createFriendsApi, BASE } = require('../app/assets/js/friends/api')

const UUID = 'a900acbf-ffc1-4ebc-899c-e1e17141cf5d'
const account = { uuid: UUID, displayName: 'Player_1', accessToken: 'mc' }

function harness(answers, sessionAnswers = [{ token: 't1' }]){
    const calls = []
    const invalidated = []
    const fetchJson = async (path, init) => {
        calls.push({ path, ...init })
        const next = answers.shift()
        if(next instanceof Error) throw next
        return next
    }
    const session = {
        ensure: async () => sessionAnswers.length > 1 ? sessionAnswers.shift() : sessionAnswers[0],
        invalidate: uuid => invalidated.push(uuid)
    }
    const api = createFriendsApi({ fetchJson, session, account: () => account })
    return { api, calls, invalidated }
}

test('each route sends the contract\'s method, path, body and the bearer', async () => {
    const ok = { ok: true, status: 204, data: null }
    const h = harness(Array(13).fill(ok))
    await h.api.view()
    await h.api.presence()
    await h.api.sendRequest('Friend_B')
    await h.api.accept('u/1')
    await h.api.decline('u2')
    await h.api.remove('u3')
    await h.api.block('u4')
    await h.api.unblock('u4')
    await h.api.settings({ appearOffline: true })
    await h.api.join('u5', true)
    await h.api.invite('u6')
    await h.api.dismissInvite('u7')
    await h.api.putPresence({ state: 'playing', release: 'pack_1' })
    assert.deepEqual(h.calls.map(c => [c.method, c.path, c.body]), [
        ['GET', BASE, undefined],
        ['GET', `${BASE}/presence`, undefined],
        ['POST', `${BASE}/requests`, { name: 'Friend_B' }],
        ['POST', `${BASE}/requests/u%2F1/accept`, undefined],
        ['POST', `${BASE}/requests/u2/decline`, undefined],
        ['DELETE', `${BASE}/u3`, undefined],
        ['POST', `${BASE}/blocks/u4`, undefined],
        ['DELETE', `${BASE}/blocks/u4`, undefined],
        ['PATCH', `${BASE}/settings`, { appearOffline: true }],
        ['POST', `${BASE}/u5/join`, { inGame: true }],
        ['POST', `${BASE}/u6/invite`, undefined],
        ['POST', `${BASE}/invites/u7/dismiss`, undefined],
        ['PUT', `${BASE}/me/presence`, { state: 'playing', release: 'pack_1' }]
    ])
    assert.ok(h.calls.every(c => c.bearer === 't1'))
    assert.equal(h.api.headPath('u 8'), `${BASE}/head/u%208`)
})

test('answers carry the data, or the site\'s code and sentence', async () => {
    const h = harness([
        { ok: true, status: 200, data: { friends: [] } },
        { ok: false, status: 409, data: { error: 'You are already friends.', code: 'ALREADY_FRIENDS' }, error: 'You are already friends.', code: 'ALREADY_FRIENDS' }
    ])
    assert.deepEqual(await h.api.view(), { ok: true, status: 200, data: { friends: [] } })
    const r = await h.api.sendRequest('x')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ALREADY_FRIENDS')
    assert.equal(r.error, 'You are already friends.')
})

test('503, 429 and no answer have their own codes', async () => {
    const h = harness([
        { ok: false, status: 503, error: 'Friends are unavailable right now.' },
        { ok: false, status: 429, retryAfter: 30 },
        new Error('ECONNRESET')
    ])
    assert.equal((await h.api.view()).code, 'UNAVAILABLE')
    const limited = await h.api.view()
    assert.equal(limited.code, 'RATE_LIMITED')
    assert.equal(limited.retryAfter, 30)
    assert.deepEqual(await h.api.view(), { ok: false, status: 0, code: 'OFFLINE', error: null, data: null })
})

test('without a session nothing is sent', async () => {
    const h = harness([], [{ token: null, reason: 'rate_limited' }])
    const r = await h.api.view()
    assert.deepEqual(r, { ok: false, status: 0, code: 'NO_SESSION', reason: 'rate_limited', error: null })
    assert.equal(h.calls.length, 0)
})

test('a 401 drops the session, mints once and repeats the call; a second 401 gives up', async () => {
    const h = harness([
        { ok: false, status: 401, code: 'UNAUTHENTICATED' },
        { ok: true, status: 200, data: { friends: [1] } },
        { ok: false, status: 401, code: 'UNAUTHENTICATED' },
        { ok: false, status: 401, code: 'UNAUTHENTICATED' }
    ], [{ token: 'old' }, { token: 'new' }, { token: 'new' }, { token: 'new' }])
    const first = await h.api.view()
    assert.deepEqual(first, { ok: true, status: 200, data: { friends: [1] } })
    assert.deepEqual(h.invalidated, [UUID])
    assert.deepEqual(h.calls.map(c => c.bearer), ['old', 'new'])
    const second = await h.api.view()
    assert.equal(second.code, 'NO_SESSION')
    assert.equal(h.calls.length, 4)
})
