const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createMinecraftLink, serverIdFor, SERVER_ID_PREFIX, MOJANG_JOIN_URL, START_PATH, COMPLETE_PATH } = require('../app/assets/js/mclink')

const UUID = 'a900acbf-ffc1-4ebc-899c-e1e17141cf5d'
const CHALLENGE = 'c'.repeat(64)
const SESSION = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6N30.c2ln'
const account = { uuid: UUID, displayName: 'Player_1', accessToken: 'mc-secret' }

/** A website that answers in order, recording every call. */
function fakeWeb(answers){
    const calls = []
    const fetchJson = async (path, init = {}) => {
        calls.push({ path, ...init })
        const next = answers.shift()
        if(next instanceof Error) throw next
        return next ?? { ok: false, status: 500, code: 'UNAVAILABLE' }
    }
    return { calls, fetchJson }
}

function fakeMojang(status = 204){
    const calls = []
    return { calls, fetchMojang: async (url, init) => { calls.push({ url, ...init }); return { status } } }
}

function link(web, mojang, session = SESSION){
    return createMinecraftLink({ fetchJson: web.fetchJson, fetchMojang: mojang.fetchMojang, readSession: async () => session })
}

const started = { ok: true, status: 200, data: { challenge: CHALLENGE, username: 'IonUser', expiresAt: null } }
const linked = { ok: true, status: 200, data: { linked: true, minecraftName: 'Player_1', transferredFrom: null } }
const elsewhere = { ok: false, status: 409, code: 'LINKED_ELSEWHERE', error: 'This Minecraft account is linked to another ION account.', data: { existingUser: 'Other' } }

test('the server id is SHA-1 over the shared prefix and the challenge', () => {
    assert.equal(SERVER_ID_PREFIX, 'ion-website-link:')
    assert.equal(serverIdFor(CHALLENGE), crypto.createHash('sha1').update(SERVER_ID_PREFIX + CHALLENGE).digest('hex'))
})

test('links: start with the cookie session, join Mojang for the derived id, complete', async () => {
    const web = fakeWeb([started, linked])
    const mojang = fakeMojang(204)
    const l = link(web, mojang)

    assert.deepEqual(await l.start(), { ok: true, username: 'IonUser' })
    assert.deepEqual(web.calls[0], { path: START_PATH, method: 'POST', body: { session: SESSION } })

    assert.deepEqual(await l.confirm(account), { ok: true, minecraftName: 'Player_1', transferredFrom: null })
    assert.equal(mojang.calls[0].url, MOJANG_JOIN_URL)
    assert.deepEqual(JSON.parse(mojang.calls[0].body), {
        accessToken: 'mc-secret',
        selectedProfile: UUID.replace(/-/g, ''),
        serverId: serverIdFor(CHALLENGE)
    })
    assert.deepEqual(web.calls[1], { path: COMPLETE_PATH, method: 'POST', body: { session: SESSION, challenge: CHALLENGE, name: 'Player_1', confirmTransfer: false } })
    // The Minecraft token goes to Mojang only.
    assert.ok(!JSON.stringify(web.calls).includes('mc-secret'))
})

test('no website session: nothing is asked of the website', async () => {
    const web = fakeWeb([])
    assert.deepEqual(await link(web, fakeMojang(), null).start(), { ok: false, code: 'SIGNED_OUT', error: null })
    assert.equal(web.calls.length, 0)
})

test('a start the website refuses carries its code and sentence; a malformed challenge is an outage', async () => {
    const refused = fakeWeb([{ ok: false, status: 401, code: 'SIGNED_OUT', error: 'Sign in again.' }])
    assert.deepEqual(await link(refused, fakeMojang()).start(), { ok: false, code: 'SIGNED_OUT', error: 'Sign in again.' })
    const odd = fakeWeb([{ ok: true, status: 200, data: { challenge: 'x', username: 'IonUser' } }])
    assert.equal((await link(odd, fakeMojang()).start()).code, 'UNAVAILABLE')
    const down = fakeWeb([new Error('ECONNREFUSED')])
    assert.equal((await link(down, fakeMojang()).start()).code, 'UNAVAILABLE')
})

test('confirm without a start, or without a usable account, never reaches Mojang', async () => {
    const mojang = fakeMojang()
    const l = link(fakeWeb([started]), mojang)
    assert.equal((await l.confirm(account)).code, 'EXPIRED')
    await l.start()
    assert.equal((await l.confirm({ ...account, accessToken: '' })).code, 'NO_ACCOUNT')
    assert.equal((await l.confirm({ ...account, displayName: 'not a name' })).code, 'NO_ACCOUNT')
    assert.equal(mojang.calls.length, 0)
})

test('Mojang refusing the token keeps the challenge for a retry after a refresh', async () => {
    const web = fakeWeb([started, linked])
    let status = 403
    const mojang = { calls: [], fetchMojang: async () => ({ status }) }
    const l = link(web, mojang)
    await l.start()
    assert.equal((await l.confirm(account)).code, 'MOJANG')
    status = 204
    assert.equal((await l.confirm({ ...account, accessToken: 'fresh' })).ok, true)
    assert.equal(web.calls.length, 2)
})

test('linked to another ION account: transfer completes with confirmTransfer and no second join', async () => {
    const web = fakeWeb([started, elsewhere, { ...linked, data: { ...linked.data, transferredFrom: 'Other' } }])
    const mojang = fakeMojang(204)
    const l = link(web, mojang)
    await l.start()
    assert.deepEqual(await l.confirm(account), { ok: false, code: 'LINKED_ELSEWHERE', error: elsewhere.error, existingUser: 'Other' })
    assert.deepEqual(await l.transfer(), { ok: true, minecraftName: 'Player_1', transferredFrom: 'Other' })
    assert.equal(mojang.calls.length, 1)
    assert.equal(web.calls[2].body.confirmTransfer, true)
    // Done: nothing is left to transfer.
    assert.equal((await l.transfer()).code, 'EXPIRED')
})

test('cancel drops the verification', async () => {
    const l = link(fakeWeb([started]), fakeMojang())
    await l.start()
    l.cancel()
    assert.equal((await l.confirm(account)).code, 'EXPIRED')
})
