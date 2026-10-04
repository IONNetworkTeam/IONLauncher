const { test } = require('node:test')
const assert = require('node:assert/strict')

const flags = require('../app/assets/js/jvmflags')

test('the old Java 8 defaults are recognized', () => {
    assert.equal(flags.hasJava8Defaults(flags.JAVA8_DEFAULTS), true)
    // As a player ended up with them: the defaults pasted in twice
    assert.equal(flags.hasJava8Defaults(['-XX:+UseConcMarkSweepGC', '-XX:+CMSIncrementalMode', ...flags.JAVA8_DEFAULTS]), true)
})

test('modern options are left alone', () => {
    const modern = ['-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC', '-XX:G1NewSizePercent=20', '-XX:MaxGCPauseMillis=50']
    assert.equal(flags.hasJava8Defaults(modern), false)
    assert.equal(flags.hasJava8Defaults([]), false)
    assert.equal(flags.hasJava8Defaults(undefined), false)
})

test('recognizes every option Java dropped after 8', () => {
    for (const option of ['-XX:+UseConcMarkSweepGC', '-XX:-UseConcMarkSweepGC', '-XX:+CMSIncrementalMode', '-XX:CMSInitiatingOccupancyFraction=75',
        '-XX:+CMSClassUnloadingEnabled', '-XX:+UseParNewGC', '-XX:PermSize=128M', '-XX:MaxPermSize=256M', ' -XX:+UseConcMarkSweepGC ']) {
        assert.equal(flags.isRemovedAfterJava8(option), true, option)
    }
    for (const option of ['-XX:-UseAdaptiveSizePolicy', '-Xmn128M', '-XX:+UseG1GC', '-XX:+UseZGC', '-Dfoo=CMS', '-XX:MaxMetaspaceSize=256M']) {
        assert.equal(flags.isRemovedAfterJava8(option), false, option)
    }
})

test('dropRemovedAfterJava8 keeps the rest in order', () => {
    const { kept, dropped } = flags.dropRemovedAfterJava8(['-XX:+UseConcMarkSweepGC', '-XX:+CMSIncrementalMode', '-XX:-UseAdaptiveSizePolicy', '-Xmn128M'])
    assert.deepEqual(kept, ['-XX:-UseAdaptiveSizePolicy', '-Xmn128M'])
    assert.deepEqual(dropped, ['-XX:+UseConcMarkSweepGC', '-XX:+CMSIncrementalMode'])
    assert.deepEqual(flags.dropRemovedAfterJava8(undefined), { kept: [], dropped: [] })
})
