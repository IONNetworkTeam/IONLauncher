const { test } = require('node:test')
const assert = require('node:assert/strict')

const lp = require('../app/assets/js/launchprofile')

const JAVA21_1_8_9 = {
    id: 'ion-1.8.9',
    ion: {
        launch: {
            mainClass: 'com.gtnewhorizons.retrofuturabootstrap.Main',
            jvmArgs: ['-Dfile.encoding=UTF-8', '-Djava.system.class.loader=com.gtnewhorizons.retrofuturabootstrap.RfbSystemClassLoader', '--enable-native-access', 'ALL-UNNAMED'],
            platformJvmArgs: { darwin: ['-XstartOnFirstThread'] },
            excludeLibraries: ['org.lwjgl.lwjgl:*', 'net.java.jinput:*', 'net.java.jutils:*', 'net.minecraft:launchwrapper', 'org.ow2.asm:asm-all'],
            options: { useNativeTransport: false }
        }
    }
}

test('servers without ion.launch have no profile', () => {
    assert.equal(lp.getLaunchProfile({ id: 'a' }), null)
    assert.equal(lp.getLaunchProfile({ id: 'a', ion: { settingsSync: false } }), null)
    assert.equal(lp.getLaunchProfile(null), null)
})

test('reads a full profile', () => {
    const profile = lp.getLaunchProfile(JAVA21_1_8_9)
    assert.equal(profile.mainClass, 'com.gtnewhorizons.retrofuturabootstrap.Main')
    assert.deepEqual(profile.options, { useNativeTransport: 'false' })
})

test('ignores malformed fields instead of failing the launch', () => {
    const profile = lp.getLaunchProfile({ ion: { launch: { mainClass: 5, jvmArgs: 'x', excludeLibraries: [1, 'a:b'], options: { 'bad key': 'x', ok: {} } } } })
    assert.equal(profile.mainClass, null)
    assert.deepEqual(profile.jvmArgs, [])
    assert.deepEqual(profile.excludeLibraries, ['a:b'])
    assert.deepEqual(profile.options, {})
})

test('platform JVM args are added only on their platform', () => {
    const profile = lp.getLaunchProfile(JAVA21_1_8_9)
    assert.equal(lp.jvmArgsFor(profile, 'linux').length, 4)
    assert.deepEqual(lp.jvmArgsFor(profile, 'darwin').slice(-1), ['-XstartOnFirstThread'])
    assert.deepEqual(lp.jvmArgsFor(null, 'darwin'), [])
})

test('excludes LWJGL 2 but keeps LWJGL 3', () => {
    const profile = lp.getLaunchProfile(JAVA21_1_8_9)
    assert.equal(lp.isLibraryExcluded(profile, 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209'), true)
    assert.equal(lp.isLibraryExcluded(profile, 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209'), true)
    assert.equal(lp.isLibraryExcluded(profile, 'net.java.jinput:jinput-platform:2.0.5'), true)
    assert.equal(lp.isLibraryExcluded(profile, 'net.minecraft:launchwrapper:1.12@jar'), true)
    assert.equal(lp.isLibraryExcluded(profile, 'org.lwjgl:lwjgl:3.3.3'), false)
    assert.equal(lp.isLibraryExcluded(profile, 'org.lwjgl:lwjgl-glfw:3.3.3:natives-linux@jar'), false)
    assert.equal(lp.isLibraryExcluded(profile, 'org.ow2.asm:asm:9.10.1'), false)
    assert.equal(lp.isLibraryExcluded(null, 'org.lwjgl.lwjgl:lwjgl:2.9.4'), false)
})

test('applyOptions replaces existing values and appends missing ones', () => {
    const options = { useNativeTransport: 'false' }
    assert.equal(lp.applyOptions('fov:0.0\nuseNativeTransport:true\nlang:en_US\n', options), 'fov:0.0\nuseNativeTransport:false\nlang:en_US\n')
    assert.equal(lp.applyOptions('fov:0.0\n', options), 'fov:0.0\nuseNativeTransport:false\n')
    assert.equal(lp.applyOptions('', options), 'useNativeTransport:false\n')
})

test('applyOptions returns the same text when nothing changes', () => {
    const text = 'fov:0.0\r\nuseNativeTransport:false\r\n'
    assert.equal(lp.applyOptions(text, {}), text)
    const unix = 'fov:0.0\nuseNativeTransport:false\n'
    assert.equal(lp.applyOptions(unix, { useNativeTransport: 'false' }), unix)
})
