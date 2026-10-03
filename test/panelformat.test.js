const { test } = require('node:test')
const assert = require('node:assert/strict')
const { playtime, since, size } = require('../app/assets/js/panelformat')

test('playtime', () => {
    assert.equal(playtime(111600), '31 h')
    assert.equal(playtime(1500), '25 min')
    assert.equal(playtime(20), '1 min')
    assert.equal(playtime(0), '0 h')
    assert.equal(playtime(null), '—')
    assert.equal(playtime(-5), '—')
})

test('since', () => {
    const now = Date.parse('2026-10-03T15:00:00')
    assert.equal(since('2026-10-03T01:00:00', now), 'today')
    assert.equal(since('2026-10-02T23:00:00', now), 'yesterday')
    assert.equal(since('2026-10-01T12:00:00', now), '2 days')
    assert.equal(since('2026-09-10T12:00:00', now), '3 weeks')
    assert.equal(since('2026-01-03T12:00:00', now), '9 months')
    assert.equal(since('2023-10-03T12:00:00', now), '3 years')
    assert.equal(since(null, now), 'never')
    assert.equal(since('garbage', now), 'never')
})

test('size', () => {
    assert.equal(size(1.8e9), '1.8 GB')
    assert.equal(size(512e6), '512 MB')
    assert.equal(size(10), '1 MB')
    assert.equal(size(null), '—')
})
