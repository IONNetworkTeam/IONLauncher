const { test } = require('node:test')
const assert = require('node:assert/strict')

const mc = require('../app/assets/js/mcoptions')

const OPTIONS_1_8 = [
    'invertYMouse:false',
    'mouseSensitivity:0.5',
    'fov:0.0',
    'gamma:1.0',
    'renderDistance:12',
    'guiScale:0',
    'fancyGraphics:true',
    'ao:2',
    'renderClouds:true',
    'resourcePacks:["Faithful.zip"]',
    'lastServer:play.example.org',
    'lang:en_US',
    'mainHand:right',
    'maxFps:120',
    'fullscreen:false',
    'key_key.attack:-100',
    'key_key.use:-99',
    'key_key.forward:17',
    'key_key.sneak:42',
    'key_key.sprint:29',
    'key_key.hotbar.1:2',
    'key_key.streamStartStop:64',
    'soundCategory_master:1.0',
    'modelPart_cape:true'
].join('\n') + '\n'

const OPTIONS_1_21_1 = [
    'version:3955',
    'autoJump:false',
    'invertYMouse:false',
    'mouseSensitivity:0.5',
    'fov:0.0',
    'gamma:0.5',
    'renderDistance:12',
    'guiScale:0',
    'graphicsMode:1',
    'ao:true',
    'renderClouds:"true"',
    'resourcePacks:["vanilla","fabric"]',
    'lastServer:',
    'lang:"en_us"',
    'mainHand:"right"',
    'maxFps:120',
    'fullscreen:false',
    'tutorialStep:"none"',
    'key_key.attack:key.mouse.left',
    'key_key.use:key.mouse.right',
    'key_key.forward:key.keyboard.w',
    'key_key.sneak:key.keyboard.left.shift',
    'key_key.sprint:key.keyboard.left.control',
    'key_key.swapOffhand:key.keyboard.f',
    'key_key.hotbar.1:key.keyboard.1',
    'soundCategory_master:1.0',
    'modelPart_cape:true'
].join('\n') + '\n'

test('detects the format from the version line, key binds, or the Minecraft version', () => {
    assert.deepEqual(mc.detectFormat(mc.entriesOf(mc.parseOptions(OPTIONS_1_21_1))), { modern: true, dataVersion: 3955 })
    assert.deepEqual(mc.detectFormat(mc.entriesOf(mc.parseOptions(OPTIONS_1_8)), '1.8.9'), { modern: false, dataVersion: 0 })
    assert.deepEqual(mc.detectFormat({ 'key_key.attack': '-100' }), { modern: false, dataVersion: null })
    assert.deepEqual(mc.detectFormat({ fov: '0.0' }, '1.16.5'), { modern: true, dataVersion: 2586 })
    assert.deepEqual(mc.detectFormat({ fov: '0.0' }, '1.12.2'), { modern: false, dataVersion: 1343 })
})

test('translates key codes in both directions', () => {
    assert.equal(mc.legacyCodeToKeyName(17), 'key.keyboard.w')
    assert.equal(mc.legacyCodeToKeyName(-100), 'key.mouse.left')
    assert.equal(mc.legacyCodeToKeyName(-97), 'key.mouse.4')
    assert.equal(mc.legacyCodeToKeyName(0), 'key.keyboard.unknown')
    assert.equal(mc.legacyCodeToKeyName(999), null)
    assert.equal(mc.keyNameToLegacyCode('key.keyboard.left.shift'), 42)
    assert.equal(mc.keyNameToLegacyCode('key.mouse.middle'), -98)
    assert.equal(mc.keyNameToLegacyCode('key.mouse.5'), -96)
    assert.equal(mc.keyNameToLegacyCode('key.keyboard.world.1'), null)
})

test('reads a 1.8 file into canonical form', () => {
    const parsed = mc.parseOptions(OPTIONS_1_8)
    const entries = mc.entriesOf(parsed)
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries, '1.8.9'))

    assert.equal(canonical.graphicsMode, '1')
    assert.equal(canonical.fancyGraphics, undefined)
    assert.equal(canonical.ao, '2')
    assert.equal(canonical.lang, 'en_us')
    assert.equal(canonical.mainHand, 'right')
    assert.equal(canonical['key_key.attack'], 'key.mouse.left')
    assert.equal(canonical['key_key.forward'], 'key.keyboard.w')
    assert.equal(canonical['key_key.sneak'], 'key.keyboard.left.shift')
    assert.equal(canonical['key_key.hotbar.1'], 'key.keyboard.1')
    assert.equal(canonical.resourcePacks, undefined)
    assert.equal(canonical.lastServer, undefined)
    assert.equal(canonical.version, undefined)
})

test('reads a 1.21.1 file into canonical form', () => {
    const parsed = mc.parseOptions(OPTIONS_1_21_1)
    const entries = mc.entriesOf(parsed)
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries))

    assert.equal(canonical.graphicsMode, '1')
    assert.equal(canonical.ao, '2')
    assert.equal(canonical.renderClouds, 'true')
    assert.equal(canonical.lang, 'en_us')
    assert.equal(canonical['key_key.swapOffhand'], 'key.keyboard.f')
    assert.equal(canonical.tutorialStep, undefined)
    assert.equal(canonical.gamma, '0.5')
})

test('applies 1.21.1 changes to a 1.8 file, translating and touching only known keys', () => {
    const entries = mc.entriesOf(mc.parseOptions(OPTIONS_1_21_1))
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries))
    canonical.fov = '30.0'
    canonical['key_key.forward'] = 'key.keyboard.up'
    canonical['key_key.attack'] = 'key.mouse.4'
    canonical.graphicsMode = '0'
    canonical.ao = '0'
    canonical.autoJump = 'true'
    canonical.renderClouds = 'fast'

    const result = mc.applyCanonical(OPTIONS_1_8, canonical, '1.8.9')
    assert.ok(result.changed)
    const out = mc.entriesOf(mc.parseOptions(result.text))
    assert.equal(out.fov, '30.0')
    assert.equal(out['key_key.forward'], '200')
    assert.equal(out['key_key.attack'], '-97')
    assert.equal(out.fancyGraphics, 'false')
    assert.equal(out.ao, '0')
    assert.equal(out.gamma, '0.5')
    assert.equal(out.lang, 'en_US')
    assert.equal(out.mainHand, 'right')
    assert.equal(out.renderClouds, 'true')
    assert.equal(out.autoJump, undefined, 'unknown options are not added')
    assert.equal(out.graphicsMode, undefined)
    assert.equal(out.resourcePacks, '["Faithful.zip"]')
    assert.equal(out.lastServer, 'play.example.org')
    assert.equal(out['key_key.streamStartStop'], '64', 'options the source lacks are left alone')
    assert.equal(out['key_key.swapOffhand'], undefined)
    assert.equal(out['key_key.swapHands'], undefined)
})

test('applies 1.8 changes to a 1.21.1 file, translating and quoting like the target', () => {
    const entries = mc.entriesOf(mc.parseOptions(OPTIONS_1_8))
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries, '1.8.9'))
    canonical['key_key.sneak'] = 'key.keyboard.c'
    canonical.graphicsMode = '0'
    canonical.ao = '0'
    canonical.mainHand = 'left'
    canonical.gamma = '1.0'

    const result = mc.applyCanonical(OPTIONS_1_21_1, canonical)
    assert.ok(result.changed)
    const out = mc.entriesOf(mc.parseOptions(result.text))
    assert.equal(out['key_key.sneak'], 'key.keyboard.c')
    assert.equal(out.graphicsMode, '0')
    assert.equal(out.ao, 'false')
    assert.equal(out.mainHand, '"left"')
    assert.equal(out.lang, '"en_us"')
    assert.equal(out.gamma, '1.0')
    assert.equal(out.version, '3955')
    assert.equal(out.tutorialStep, '"none"')
    assert.equal(out.resourcePacks, '["vanilla","fabric"]')
})

test('reports no change when the target already matches', () => {
    const entries = mc.entriesOf(mc.parseOptions(OPTIONS_1_21_1))
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries))
    const result = mc.applyCanonical(OPTIONS_1_21_1, canonical)
    assert.equal(result.changed, false)
    assert.equal(result.text, OPTIONS_1_21_1)
})

test('preserves CRLF line endings and unknown lines', () => {
    const text = 'version:3955\r\nfov:0.0\r\n\r\ngarbage line\r\n'
    const result = mc.applyCanonical(text, { fov: '10.0' })
    assert.equal(result.text, 'version:3955\r\nfov:10.0\r\n\r\ngarbage line\r\n')
})

test('handles swapHands/swapOffhand and fancyGraphics across intermediate versions', () => {
    const text1_12 = 'version:1343\nfancyGraphics:true\nkey_key.swapHands:33\nlang:en_us\n'
    const result = mc.applyCanonical(text1_12, { 'key_key.swapOffhand': 'key.keyboard.g', graphicsMode: '2', lang: 'de_de' })
    const out = mc.entriesOf(mc.parseOptions(result.text))
    assert.equal(out['key_key.swapHands'], '34')
    assert.equal(out.fancyGraphics, 'true')
    assert.equal(out.lang, 'de_de', '1.11+ keeps lowercase language codes')

    const text1_18 = 'version:2860\nao:2\ngraphicsMode:1\nrenderClouds:"fast"\n'
    const r2 = mc.applyCanonical(text1_18, { ao: '0', graphicsMode: '2', renderClouds: 'true' })
    const out2 = mc.entriesOf(mc.parseOptions(r2.text))
    assert.equal(out2.ao, '0')
    assert.equal(out2.graphicsMode, '2')
    assert.equal(out2.renderClouds, '"true"')
})

test('builds a fresh 1.21.1 file from a 1.8 instance', () => {
    const entries = mc.entriesOf(mc.parseOptions(OPTIONS_1_8))
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries, '1.8.9'))
    const text = mc.buildOptionsFile(canonical, { modern: true, dataVersion: mc.dataVersionForMinecraft('1.21.1') })
    const out = mc.entriesOf(mc.parseOptions(text))
    assert.equal(text.split('\n')[0], 'version:3955')
    assert.equal(out.lang, '"en_us"')
    assert.equal(out.mainHand, '"right"')
    assert.equal(out.renderClouds, '"true"')
    assert.equal(out.graphicsMode, '1')
    assert.equal(out.ao, 'true')
    assert.equal(out.fov, '0.0')
    assert.equal(out.fullscreen, 'false')
    assert.equal(out['key_key.attack'], 'key.mouse.left')
    assert.equal(out['key_key.forward'], 'key.keyboard.w')
    assert.equal(out.resourcePacks, undefined)
    assert.equal(out.lastServer, undefined)
})

test('builds a fresh 1.8 file from a 1.21.1 instance', () => {
    const entries = mc.entriesOf(mc.parseOptions(OPTIONS_1_21_1))
    const canonical = mc.entriesToCanonical(entries, mc.detectFormat(entries))
    const text = mc.buildOptionsFile(canonical, { modern: false, dataVersion: mc.dataVersionForMinecraft('1.8.9') })
    const out = mc.entriesOf(mc.parseOptions(text))
    assert.ok(!text.startsWith('version:'), '1.8 has no version line')
    assert.equal(out.lang, 'en_US')
    assert.equal(out.mainHand, 'right')
    assert.equal(out.fancyGraphics, 'true')
    assert.equal(out.ao, '2')
    assert.equal(out['key_key.attack'], '-100')
    assert.equal(out['key_key.sneak'], '42')
    assert.equal(out['key_key.swapOffhand'], undefined)
    assert.equal(out['key_key.swapHands'], undefined, '1.8 has no off hand')
})

test('refuses to build a modern file without a data version', () => {
    assert.equal(mc.buildOptionsFile({ fov: '0.0' }, { modern: true, dataVersion: null }), null)
    assert.ok(mc.buildOptionsFile({ fov: '0.0' }, { modern: false, dataVersion: null }))
})

test('knows release data versions', () => {
    assert.equal(mc.dataVersionForMinecraft('1.8.9'), 0)
    assert.equal(mc.dataVersionForMinecraft('1.12.2'), 1343)
    assert.equal(mc.dataVersionForMinecraft('1.21.1'), 3955)
    assert.equal(mc.dataVersionForMinecraft('1.99'), null)
})

test('applies plain key/value files such as optionsshaders.txt', () => {
    const text = '#Thu Jan 01 00:00:00 CET 2026\nshaderPack=Sildurs.zip\nshadowResolution=2048\n'
    const result = mc.applyPlain(text, { shadowResolution: '4096', unknownKey: '1' }, '=')
    assert.equal(result.text, '#Thu Jan 01 00:00:00 CET 2026\nshaderPack=Sildurs.zip\nshadowResolution=4096\n')
})
