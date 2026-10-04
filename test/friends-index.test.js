const { test } = require('node:test')
const assert = require('node:assert/strict')
const { rendererMessage } = require('../app/assets/js/friends/index')

test('party frames reach the renderer as party_<event>; friends frames keep their names', () => {
    assert.deepEqual(
        rendererMessage('invite', { type: 'party', event: 'invite', invite: { partyId: 'p1' } }),
        { type: 'party', event: 'party_invite', invite: { partyId: 'p1' } }
    )
    for(const e of ['invite_expired', 'updated', 'disbanded', 'follow']){
        assert.equal(rendererMessage(e, { type: 'party', event: e }).event, `party_${e}`)
    }
    assert.equal(rendererMessage('invite', { type: 'friends', event: 'invite', invite: { from: { uuid: 'a' } } }).event, 'invite')
    assert.equal(rendererMessage('presence', { type: 'friends', event: 'presence' }).event, 'presence')
})
