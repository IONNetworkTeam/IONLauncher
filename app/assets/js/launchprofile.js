/**
 * ION launch profile: `servers[].ion.launch` in distribution.json (see docs/distro.md).
 *
 * Lets a server run Minecraft on a different launch setup than its Forge version describes. The
 * Forge 1.8.9 server uses it to run on Java 21: RetroFuturaBootstrap replaces LaunchWrapper as the
 * main class, needs a few JVM flags, and LWJGL 3 (shipped as Library modules) replaces Mojang's
 * LWJGL 2, which has to be kept off the classpath.
 *
 * Kept free of Electron and ConfigManager so it can be unit tested.
 */

/**
 * @typedef {Object} LaunchProfile
 * @property {string|null} mainClass Replaces the main class from the Forge/Fabric version manifest.
 * @property {string[]} jvmArgs Added after the player's own JVM options.
 * @property {Object.<string, string[]>} platformJvmArgs Extra JVM args per `process.platform`.
 * @property {string[]} excludeLibraries `group:artifact` patterns (`*` allowed) left off the classpath.
 * @property {Object.<string, string>} options options.txt values set before every launch.
 */

function stringList(value) {
    return Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.length > 0) : []
}

/**
 * Read the launch profile of a server, or null when it has none.
 *
 * @param {Object} rawServer The raw server object from the distribution.
 * @returns {LaunchProfile|null}
 */
function getLaunchProfile(rawServer) {
    const launch = rawServer?.ion?.launch
    if (launch == null || typeof launch !== 'object') {
        return null
    }

    const platformJvmArgs = {}
    if (launch.platformJvmArgs != null && typeof launch.platformJvmArgs === 'object') {
        for (const [platform, args] of Object.entries(launch.platformJvmArgs)) {
            platformJvmArgs[platform] = stringList(args)
        }
    }

    const options = {}
    if (launch.options != null && typeof launch.options === 'object') {
        for (const [key, value] of Object.entries(launch.options)) {
            if (/^[A-Za-z0-9_.]+$/.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
                options[key] = String(value)
            }
        }
    }

    return {
        mainClass: typeof launch.mainClass === 'string' && launch.mainClass.length > 0 ? launch.mainClass : null,
        jvmArgs: stringList(launch.jvmArgs),
        platformJvmArgs,
        excludeLibraries: stringList(launch.excludeLibraries),
        options
    }
}

/**
 * The JVM args a profile adds on the given platform.
 *
 * @param {LaunchProfile|null} profile
 * @param {string} platform A `process.platform` value.
 * @returns {string[]}
 */
function jvmArgsFor(profile, platform) {
    if (profile == null) {
        return []
    }
    return [...profile.jvmArgs, ...(profile.platformJvmArgs[platform] ?? [])]
}

function patternToRegex(pattern) {
    const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp(`^${escaped}$`)
}

/**
 * Whether a library is left off the classpath (and its natives are not extracted).
 *
 * @param {LaunchProfile|null} profile
 * @param {string} mavenName A maven identifier, `group:artifact[:version[:classifier]][@ext]`.
 * @returns {boolean}
 */
function isLibraryExcluded(profile, mavenName) {
    if (profile == null || profile.excludeLibraries.length === 0 || typeof mavenName !== 'string') {
        return false
    }
    const [group, artifact] = mavenName.split('@')[0].split(':')
    if (group == null || artifact == null) {
        return false
    }
    const key = `${group}:${artifact}`
    return profile.excludeLibraries.some(pattern => patternToRegex(pattern).test(key))
}

/**
 * Set the profile's options in the text of an options.txt, keeping every other line as it is.
 *
 * @param {string} text Current options.txt content (empty when the file does not exist yet).
 * @param {Object.<string, string>} options
 * @returns {string} The new content, or the same string when nothing changed.
 */
function applyOptions(text, options) {
    const keys = Object.keys(options)
    if (keys.length === 0) {
        return text
    }
    const lines = text.length > 0 ? text.split(/\r?\n/) : []
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
    }
    const seen = new Set()
    for (let i = 0; i < lines.length; i++) {
        const sep = lines[i].indexOf(':')
        if (sep <= 0) {
            continue
        }
        const key = lines[i].substring(0, sep)
        if (Object.prototype.hasOwnProperty.call(options, key)) {
            lines[i] = `${key}:${options[key]}`
            seen.add(key)
        }
    }
    for (const key of keys) {
        if (!seen.has(key)) {
            lines.push(`${key}:${options[key]}`)
        }
    }
    const result = lines.join('\n') + '\n'
    return result === text ? text : result
}

module.exports = { getLaunchProfile, jvmArgsFor, isLibraryExcluded, applyOptions }
