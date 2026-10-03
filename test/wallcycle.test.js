const { test } = require('node:test')
const assert = require('node:assert/strict')
const { WallCycle } = require('../app/assets/js/wallcycle')

test('cycles in order and wraps', () => {
    const c = new WallCycle(['a', 'b', 'c'])
    assert.equal(c.current, 'a')
    assert.deepEqual([c.advance(), c.advance(), c.advance()], ['b', 'c', 'a'])
})

test('an empty set has no current', () => {
    const c = new WallCycle([])
    assert.equal(c.current, null)
    assert.equal(c.advance(), null)
})

test('a new picture joins at the end of the cycle, quietly', () => {
    const c = new WallCycle(['a', 'b'])
    c.update(['a', 'b', 'n'])
    assert.equal(c.current, 'a')
    assert.deepEqual([c.advance(), c.advance(), c.advance()], ['b', 'n', 'a'])
})

test('a removed picture that is on screen lingers until its turn ends', () => {
    const c = new WallCycle(['a', 'b', 'c'], 1)
    assert.equal(c.current, 'b')
    c.update(['a', 'c'])
    assert.equal(c.current, 'b', 'still on screen')
    assert.equal(c.advance(), 'c', 'continues with what followed it')
    assert.deepEqual([c.advance(), c.advance()], ['a', 'c'], 'never comes back')
})

test('a removed picture that is not on screen just leaves', () => {
    const c = new WallCycle(['a', 'b', 'c'])
    c.update(['a', 'c'])
    assert.equal(c.advance(), 'c')
})

test('removing the on-screen picture and everything after it wraps to the start', () => {
    const c = new WallCycle(['a', 'b', 'c'], 2)
    c.update(['a', 'b'])
    assert.equal(c.current, 'c')
    assert.equal(c.advance(), 'a')
})

test('removing everything keeps the lingering picture, then shows nothing new', () => {
    const c = new WallCycle(['a'])
    c.update([])
    assert.equal(c.current, 'a')
    assert.equal(c.advance(), null)
})

test('a set that was empty starts with the first new picture', () => {
    const c = new WallCycle([])
    c.update(['x', 'y'])
    assert.equal(c.current, 'x')
})
