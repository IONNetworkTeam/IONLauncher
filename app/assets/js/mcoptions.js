/**
 * Minecraft options file format handling.
 *
 * Minecraft stores its settings in options.txt as `key:value` lines, but the file is not the
 * same across versions. Up to 1.12 key binds are LWJGL 2 key codes, from 1.13 they are GLFW key
 * names (`key.keyboard.w`). From 1.13 string values are JSON quoted. A few options were renamed
 * or changed type along the way. This module converts between those formats through a single
 * canonical representation (the modern one) so that settings can be copied between instances
 * running different Minecraft versions.
 *
 * This module has no Electron or filesystem dependencies so it can be tested on its own.
 */

/** Data version of 1.13, the first version with GLFW key names and quoted strings. */
const MODERN_DATA_VERSION = 1519
/** Data version of 1.11, the first version with lowercase language codes (en_us). */
const LOWERCASE_LANG_DATA_VERSION = 819
/** Data version of 1.16, which replaced the fancyGraphics boolean with graphicsMode. */
const GRAPHICS_MODE_DATA_VERSION = 2566
/** Data version of 1.16, which renamed key.swapHands to key.swapOffhand. */
const SWAP_OFFHAND_DATA_VERSION = 2566
/** Data version of 1.9, which introduced the off hand. */
const OFFHAND_DATA_VERSION = 169
/** Data version of 1.19.4, which turned the three-level ao setting into a boolean. */
const AO_BOOLEAN_DATA_VERSION = 3337

/**
 * Data versions of Minecraft releases. Minecraft writes this as the `version` line of
 * options.txt and uses it to decide which data fixers to run on the file, so a seeded file must
 * carry the right value. Releases before 1.9 have no data version and write no version line.
 */
const DATA_VERSIONS = {
    '1.9': 169, '1.9.1': 175, '1.9.2': 176, '1.9.3': 183, '1.9.4': 184,
    '1.10': 510, '1.10.1': 511, '1.10.2': 512,
    '1.11': 819, '1.11.1': 921, '1.11.2': 922,
    '1.12': 1139, '1.12.1': 1241, '1.12.2': 1343,
    '1.13': 1519, '1.13.1': 1628, '1.13.2': 1631,
    '1.14': 1952, '1.14.1': 1957, '1.14.2': 1963, '1.14.3': 1968, '1.14.4': 1976,
    '1.15': 2225, '1.15.1': 2227, '1.15.2': 2230,
    '1.16': 2566, '1.16.1': 2567, '1.16.2': 2578, '1.16.3': 2580, '1.16.4': 2584, '1.16.5': 2586,
    '1.17': 2724, '1.17.1': 2730,
    '1.18': 2860, '1.18.1': 2865, '1.18.2': 2975,
    '1.19': 3105, '1.19.1': 3117, '1.19.2': 3120, '1.19.3': 3218, '1.19.4': 3337,
    '1.20': 3463, '1.20.1': 3465, '1.20.2': 3578, '1.20.3': 3698, '1.20.4': 3700, '1.20.5': 3837, '1.20.6': 3839,
    '1.21': 3953, '1.21.1': 3955, '1.21.2': 4080, '1.21.3': 4082, '1.21.4': 4189, '1.21.5': 4325,
    '1.21.6': 4435, '1.21.7': 4438, '1.21.8': 4440
}

/**
 * Options that are per-instance or per-machine state rather than preferences. They are never
 * copied between instances.
 */
const EXCLUDED_KEYS = new Set([
    'version',
    'lastServer',
    'resourcePacks',
    'incompatibleResourcePacks',
    'tutorialStep',
    'joinedFirstServer',
    'skipMultiplayerWarning',
    'onboardAccessibility',
    'telemetryOptInExtra',
    'syncChunkWrites',
    'fullscreenResolution',
    'glDebugVerbosity'
])

/**
 * Options whose value is a string in every version. Needed when seeding a modern file, where
 * strings must be quoted, because a string like "true" (renderClouds) would otherwise look like
 * a boolean.
 */
const STRING_KEYS = new Set(['lang', 'mainHand', 'renderClouds', 'soundDevice'])

/**
 * LWJGL 2 key codes (used by Minecraft up to 1.12) and their GLFW key names (1.13+). This is the
 * same table Minecraft's own 1.13 options data fixer uses.
 */
const LEGACY_KEY_NAMES = {
    0: 'key.keyboard.unknown',
    1: 'key.keyboard.escape',
    2: 'key.keyboard.1', 3: 'key.keyboard.2', 4: 'key.keyboard.3', 5: 'key.keyboard.4', 6: 'key.keyboard.5',
    7: 'key.keyboard.6', 8: 'key.keyboard.7', 9: 'key.keyboard.8', 10: 'key.keyboard.9', 11: 'key.keyboard.0',
    12: 'key.keyboard.minus',
    13: 'key.keyboard.equal',
    14: 'key.keyboard.backspace',
    15: 'key.keyboard.tab',
    16: 'key.keyboard.q', 17: 'key.keyboard.w', 18: 'key.keyboard.e', 19: 'key.keyboard.r', 20: 'key.keyboard.t',
    21: 'key.keyboard.y', 22: 'key.keyboard.u', 23: 'key.keyboard.i', 24: 'key.keyboard.o', 25: 'key.keyboard.p',
    26: 'key.keyboard.left.bracket',
    27: 'key.keyboard.right.bracket',
    28: 'key.keyboard.enter',
    29: 'key.keyboard.left.control',
    30: 'key.keyboard.a', 31: 'key.keyboard.s', 32: 'key.keyboard.d', 33: 'key.keyboard.f', 34: 'key.keyboard.g',
    35: 'key.keyboard.h', 36: 'key.keyboard.j', 37: 'key.keyboard.k', 38: 'key.keyboard.l',
    39: 'key.keyboard.semicolon',
    40: 'key.keyboard.apostrophe',
    41: 'key.keyboard.grave.accent',
    42: 'key.keyboard.left.shift',
    43: 'key.keyboard.backslash',
    44: 'key.keyboard.z', 45: 'key.keyboard.x', 46: 'key.keyboard.c', 47: 'key.keyboard.v', 48: 'key.keyboard.b',
    49: 'key.keyboard.n', 50: 'key.keyboard.m',
    51: 'key.keyboard.comma',
    52: 'key.keyboard.period',
    53: 'key.keyboard.slash',
    54: 'key.keyboard.right.shift',
    55: 'key.keyboard.keypad.multiply',
    56: 'key.keyboard.left.alt',
    57: 'key.keyboard.space',
    58: 'key.keyboard.caps.lock',
    59: 'key.keyboard.f1', 60: 'key.keyboard.f2', 61: 'key.keyboard.f3', 62: 'key.keyboard.f4', 63: 'key.keyboard.f5',
    64: 'key.keyboard.f6', 65: 'key.keyboard.f7', 66: 'key.keyboard.f8', 67: 'key.keyboard.f9', 68: 'key.keyboard.f10',
    69: 'key.keyboard.num.lock',
    70: 'key.keyboard.scroll.lock',
    71: 'key.keyboard.keypad.7', 72: 'key.keyboard.keypad.8', 73: 'key.keyboard.keypad.9',
    74: 'key.keyboard.keypad.subtract',
    75: 'key.keyboard.keypad.4', 76: 'key.keyboard.keypad.5', 77: 'key.keyboard.keypad.6',
    78: 'key.keyboard.keypad.add',
    79: 'key.keyboard.keypad.1', 80: 'key.keyboard.keypad.2', 81: 'key.keyboard.keypad.3', 82: 'key.keyboard.keypad.0',
    83: 'key.keyboard.keypad.decimal',
    87: 'key.keyboard.f11',
    88: 'key.keyboard.f12',
    100: 'key.keyboard.f13', 101: 'key.keyboard.f14', 102: 'key.keyboard.f15', 103: 'key.keyboard.f16',
    104: 'key.keyboard.f17', 105: 'key.keyboard.f18', 113: 'key.keyboard.f19',
    141: 'key.keyboard.keypad.equal',
    156: 'key.keyboard.keypad.enter',
    157: 'key.keyboard.right.control',
    181: 'key.keyboard.keypad.divide',
    183: 'key.keyboard.print.screen',
    184: 'key.keyboard.right.alt',
    197: 'key.keyboard.pause',
    199: 'key.keyboard.home',
    200: 'key.keyboard.up',
    201: 'key.keyboard.page.up',
    203: 'key.keyboard.left',
    205: 'key.keyboard.right',
    207: 'key.keyboard.end',
    208: 'key.keyboard.down',
    209: 'key.keyboard.page.down',
    210: 'key.keyboard.insert',
    211: 'key.keyboard.delete',
    219: 'key.keyboard.left.win',
    220: 'key.keyboard.right.win',
    221: 'key.keyboard.menu'
}

const LEGACY_KEY_CODES = {}
for(const [code, name] of Object.entries(LEGACY_KEY_NAMES)){
    LEGACY_KEY_CODES[name] = Number(code)
}

const MOUSE_NAMES = ['key.mouse.left', 'key.mouse.right', 'key.mouse.middle']

/**
 * Translate an LWJGL 2 key code into a GLFW key name.
 *
 * @param {number} code The LWJGL 2 key code. Mouse buttons are negative (-100 = left).
 * @returns {string|null} The GLFW key name, or null when there is no equivalent.
 */
function legacyCodeToKeyName(code){
    if(!Number.isInteger(code)){
        return null
    }
    if(code < 0){
        const button = code + 100
        if(button < 0){
            return null
        }
        return button < MOUSE_NAMES.length ? MOUSE_NAMES[button] : `key.mouse.${button + 1}`
    }
    return LEGACY_KEY_NAMES[code] || null
}

/**
 * Translate a GLFW key name into an LWJGL 2 key code.
 *
 * @param {string} name The GLFW key name, such as key.keyboard.w or key.mouse.left.
 * @returns {number|null} The LWJGL 2 key code, or null when there is no equivalent.
 */
function keyNameToLegacyCode(name){
    if(typeof name !== 'string'){
        return null
    }
    if(name.startsWith('key.mouse.')){
        const idx = MOUSE_NAMES.indexOf(name)
        if(idx !== -1){
            return idx - 100
        }
        const n = Number(name.substring('key.mouse.'.length))
        return Number.isInteger(n) && n >= 4 ? n - 1 - 100 : null
    }
    const code = LEGACY_KEY_CODES[name]
    return code === undefined ? null : code
}

/**
 * Look up the data version of a Minecraft release.
 *
 * @param {string} mcVersion The Minecraft version, such as 1.21.1.
 * @returns {number|null} The data version, 0 for releases before 1.9, null when unknown.
 */
function dataVersionForMinecraft(mcVersion){
    if(typeof mcVersion !== 'string'){
        return null
    }
    if(Object.prototype.hasOwnProperty.call(DATA_VERSIONS, mcVersion)){
        return DATA_VERSIONS[mcVersion]
    }
    const parts = mcVersion.split('.').map(Number)
    if(parts.length >= 2 && parts[0] === 1 && Number.isInteger(parts[1]) && parts[1] < 9){
        return 0
    }
    return null
}

/**
 * Whether a Minecraft version uses the modern (1.13+) options format.
 *
 * @param {string} mcVersion The Minecraft version.
 * @returns {boolean}
 */
function isModernMinecraft(mcVersion){
    const parts = String(mcVersion).split('.').map(Number)
    return parts[0] > 1 || (parts[0] === 1 && parts[1] >= 13)
}

/**
 * Parse an options file into its lines. Lines that do not contain the separator are kept
 * verbatim so the file can be written back without losing anything.
 *
 * @param {string} text The file content.
 * @param {string} sep The key/value separator, ':' for options.txt, '=' for Java properties.
 * @returns {{lines: Array<{raw: string, key?: string, value?: string}>, eol: string}}
 */
function parseOptions(text, sep = ':'){
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/).map(raw => {
        const idx = raw.indexOf(sep)
        if(idx <= 0){
            return { raw }
        }
        return { raw, key: raw.substring(0, idx), value: raw.substring(idx + 1) }
    })
    return { lines, eol, sep }
}

/**
 * Serialize parsed options back into file content.
 *
 * @param {{lines: Array<{raw: string, key?: string, value?: string}>, eol: string, sep: string}} parsed
 * @returns {string}
 */
function serializeOptions(parsed){
    return parsed.lines.map(line => line.key === undefined ? line.raw : `${line.key}${parsed.sep}${line.value}`).join(parsed.eol)
}

/**
 * Collect the key/value entries of a parsed file.
 *
 * @param {{lines: Array}} parsed
 * @returns {Object<string, string>}
 */
function entriesOf(parsed){
    const entries = {}
    for(const line of parsed.lines){
        if(line.key !== undefined){
            entries[line.key] = line.value
        }
    }
    return entries
}

/**
 * Determine which format an options.txt file uses.
 *
 * @param {Object<string, string>} entries The file entries.
 * @param {string} [mcVersion] The Minecraft version of the instance, used as a fallback.
 * @returns {{modern: boolean, dataVersion: number|null}}
 */
function detectFormat(entries, mcVersion){
    const version = Number(entries.version)
    if(Number.isInteger(version) && version > 0){
        return { modern: version >= MODERN_DATA_VERSION, dataVersion: version }
    }
    for(const [key, value] of Object.entries(entries)){
        if(key.startsWith('key_')){
            if(/^key\./.test(value)){
                return { modern: true, dataVersion: dataVersionForMinecraft(mcVersion) }
            }
            if(/^-?\d+$/.test(value)){
                return { modern: false, dataVersion: dataVersionForMinecraft(mcVersion) }
            }
        }
    }
    if(mcVersion != null){
        return { modern: isModernMinecraft(mcVersion), dataVersion: dataVersionForMinecraft(mcVersion) }
    }
    return { modern: true, dataVersion: null }
}

function isQuoted(value){
    return typeof value === 'string' && value.length >= 2 && value.startsWith('"') && value.endsWith('"')
}

function unquote(value){
    if(!isQuoted(value)){
        return value
    }
    try {
        const parsed = JSON.parse(value)
        return typeof parsed === 'string' ? parsed : value
    } catch {
        return value.substring(1, value.length - 1)
    }
}

function isBooleanLike(value){
    return value === 'true' || value === 'false'
}

function isNumberLike(value){
    return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)
}

/**
 * Whether a canonical value should be quoted when written into a modern file whose current
 * value is unknown (a seeded file).
 */
function needsQuotes(key, value){
    if(STRING_KEYS.has(key)){
        return true
    }
    if(key.startsWith('key_') || isBooleanLike(value) || isNumberLike(value)){
        return false
    }
    if(value.startsWith('[') || value.startsWith('{')){
        return false
    }
    return true
}

/**
 * Convert one options.txt entry into its canonical form.
 *
 * @param {string} key
 * @param {string} value
 * @param {{modern: boolean}} format The format of the file the entry came from.
 * @returns {{key: string, value: string}|null} The canonical entry, or null when the option is
 * not synced or cannot be represented.
 */
function toCanonical(key, value, format){
    if(EXCLUDED_KEYS.has(key)){
        return null
    }
    if(key.startsWith('key_')){
        const ckey = key === 'key_key.swapHands' ? 'key_key.swapOffhand' : key
        if(format.modern){
            const name = unquote(value)
            return /^key\./.test(name) ? { key: ckey, value: name } : null
        }
        const name = legacyCodeToKeyName(Number(value))
        return name == null ? null : { key: ckey, value: name }
    }
    switch(key){
        case 'fancyGraphics':
            return { key: 'graphicsMode', value: value === 'true' ? '1' : '0' }
        case 'ao':
            if(isBooleanLike(value)){
                return { key, value: value === 'true' ? '2' : '0' }
            }
            return { key, value }
        case 'lang':
            return { key, value: unquote(value).toLowerCase() }
        default:
            return { key, value: unquote(value) }
    }
}

/**
 * Convert every entry of an options.txt file into canonical form.
 *
 * @param {Object<string, string>} entries
 * @param {{modern: boolean}} format
 * @returns {Object<string, string>}
 */
function entriesToCanonical(entries, format){
    const canonical = {}
    for(const [key, value] of Object.entries(entries)){
        const c = toCanonical(key, value, format)
        if(c != null){
            canonical[c.key] = c.value
        }
    }
    return canonical
}

/**
 * Pick the key a canonical option is stored under in a target file.
 *
 * @param {string} ckey The canonical key.
 * @param {{modern: boolean, dataVersion: number|null, existing: Object<string, string>|null}} target
 * @returns {string|null} The target key, or null when the target has no such option.
 */
function resolveTargetKey(ckey, target){
    const existing = target.existing
    const dv = target.dataVersion
    const has = k => existing != null && Object.prototype.hasOwnProperty.call(existing, k)

    if(ckey === 'key_key.swapOffhand'){
        if(existing != null){
            return has('key_key.swapOffhand') ? ckey : has('key_key.swapHands') ? 'key_key.swapHands' : null
        }
        if(dv == null){
            return target.modern ? ckey : 'key_key.swapHands'
        }
        if(dv >= SWAP_OFFHAND_DATA_VERSION){
            return ckey
        }
        return dv >= OFFHAND_DATA_VERSION ? 'key_key.swapHands' : null
    }
    if(ckey === 'graphicsMode'){
        if(existing != null){
            return has('graphicsMode') ? ckey : has('fancyGraphics') ? 'fancyGraphics' : null
        }
        if(dv == null){
            return target.modern ? ckey : 'fancyGraphics'
        }
        return dv >= GRAPHICS_MODE_DATA_VERSION ? ckey : 'fancyGraphics'
    }
    if(existing != null && !has(ckey)){
        return null
    }
    return ckey
}

/**
 * Render a canonical option for a target file.
 *
 * @param {string} ckey The canonical key.
 * @param {string} cvalue The canonical value.
 * @param {{modern: boolean, dataVersion: number|null, existing: Object<string, string>|null}} target
 *        The target format. `existing` holds the target file's current entries, or null when the
 *        file is being created.
 * @returns {{key: string, value: string}|null} The entry to write, or null to leave the target alone.
 */
function fromCanonical(ckey, cvalue, target){
    const key = resolveTargetKey(ckey, target)
    if(key == null){
        return null
    }
    const current = target.existing != null ? target.existing[key] : undefined
    const dv = target.dataVersion

    if(key.startsWith('key_')){
        if(target.modern){
            return { key, value: cvalue }
        }
        const code = keyNameToLegacyCode(cvalue)
        return code == null ? null : { key, value: String(code) }
    }

    if(key === 'fancyGraphics'){
        return { key, value: cvalue === '0' ? 'false' : 'true' }
    }
    if(key === 'ao'){
        const asBoolean = current !== undefined ? isBooleanLike(current) : (dv != null && dv >= AO_BOOLEAN_DATA_VERSION)
        if(asBoolean){
            return { key, value: cvalue === '0' ? 'false' : 'true' }
        }
        return { key, value: isBooleanLike(cvalue) ? (cvalue === 'true' ? '2' : '0') : cvalue }
    }

    let value = cvalue
    if(key === 'lang'){
        const upperRegion = current !== undefined ? /[A-Z]/.test(current) : (!target.modern && (dv == null || dv < LOWERCASE_LANG_DATA_VERSION))
        if(upperRegion){
            const idx = value.indexOf('_')
            if(idx !== -1){
                value = value.substring(0, idx) + '_' + value.substring(idx + 1).toUpperCase()
            }
        }
    }
    if(key === 'renderClouds' && !target.modern && current !== undefined && isBooleanLike(current) && value === 'fast'){
        value = 'true'
    }

    let quoted
    if(current !== undefined){
        quoted = isQuoted(current)
    } else {
        quoted = target.modern && needsQuotes(key, value)
    }
    return { key, value: quoted ? JSON.stringify(value) : value }
}

/**
 * Update an existing options.txt with canonical values. Only options the file already contains
 * are changed, so an instance never receives options its Minecraft version or mods do not know.
 * Unknown lines, order and line endings are preserved.
 *
 * @param {string} text The current file content.
 * @param {Object<string, string>} canonical The canonical options to apply.
 * @param {string} [mcVersion] The instance's Minecraft version, used when the file's format
 *        cannot be read from the file itself.
 * @returns {{text: string, changed: boolean, format: {modern: boolean, dataVersion: number|null}}}
 */
function applyCanonical(text, canonical, mcVersion){
    const parsed = parseOptions(text)
    const existing = entriesOf(parsed)
    const format = detectFormat(existing, mcVersion)
    const target = { ...format, existing }
    const updates = {}
    for(const [ckey, cvalue] of Object.entries(canonical)){
        const entry = fromCanonical(ckey, cvalue, target)
        if(entry != null && existing[entry.key] !== entry.value){
            updates[entry.key] = entry.value
        }
    }
    let changed = false
    for(const line of parsed.lines){
        if(line.key !== undefined && Object.prototype.hasOwnProperty.call(updates, line.key)){
            line.value = updates[line.key]
            delete updates[line.key]
            changed = true
        }
    }
    return { text: changed ? serializeOptions(parsed) : text, changed, format }
}

/**
 * Build a brand-new options.txt for an instance from canonical values.
 *
 * @param {Object<string, string>} canonical The canonical options.
 * @param {{modern: boolean, dataVersion: number|null}} format The target format. A modern target
 *        needs a known data version; without one Minecraft would run its data fixers over the
 *        file as if it came from an ancient version.
 * @param {string} [eol] The line ending to use.
 * @returns {string|null} The file content, or null when the file cannot be built safely.
 */
function buildOptionsFile(canonical, format, eol = '\n'){
    if(format.modern && !(format.dataVersion >= MODERN_DATA_VERSION)){
        return null
    }
    const target = { ...format, existing: null }
    const lines = []
    if(format.dataVersion > 0){
        lines.push(`version:${format.dataVersion}`)
    }
    for(const ckey of Object.keys(canonical).sort()){
        const entry = fromCanonical(ckey, canonical[ckey], target)
        if(entry != null){
            lines.push(`${entry.key}:${entry.value}`)
        }
    }
    return lines.join(eol) + eol
}

/**
 * Update a plain key/value file (optionsof.txt, optionsshaders.txt) with values from another
 * instance. These files keep the same format across versions, so values are copied as they are,
 * but again only for keys the target already has.
 *
 * @param {string} text The current file content.
 * @param {Object<string, string>} values The values to apply.
 * @param {string} sep The key/value separator.
 * @returns {{text: string, changed: boolean}}
 */
function applyPlain(text, values, sep){
    const parsed = parseOptions(text, sep)
    let changed = false
    for(const line of parsed.lines){
        if(line.key !== undefined && Object.prototype.hasOwnProperty.call(values, line.key) && line.value !== values[line.key]){
            line.value = values[line.key]
            changed = true
        }
    }
    return { text: changed ? serializeOptions(parsed) : text, changed }
}

module.exports = {
    MODERN_DATA_VERSION,
    EXCLUDED_KEYS,
    dataVersionForMinecraft,
    isModernMinecraft,
    legacyCodeToKeyName,
    keyNameToLegacyCode,
    parseOptions,
    serializeOptions,
    entriesOf,
    detectFormat,
    toCanonical,
    entriesToCanonical,
    fromCanonical,
    applyCanonical,
    buildOptionsFile,
    applyPlain
}
