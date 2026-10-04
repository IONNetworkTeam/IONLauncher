/**
 * JVM flags that only Java 8 understands. A server that moves to a newer Java (the Forge 1.8.9 server
 * on Java 21) keeps whatever JVM options the launcher saved for it back then, and Java 14+ refuses to
 * start with the CMS collector flags of the Java 8 defaults: "Unrecognized VM option", no game, no
 * log. Kept free of Electron so it can be unit tested.
 */

/** The Java 8 defaults of older launchers, see configmanager.defaultJavaConfig8. */
const JAVA8_DEFAULTS = ['-XX:+UseConcMarkSweepGC', '-XX:+CMSIncrementalMode', '-XX:-UseAdaptiveSizePolicy', '-Xmn128M']

/** Options removed from HotSpot after Java 8: the CMS and ParNew collectors and PermGen sizing. */
const REMOVED_AFTER_JAVA8 = [
    /^-XX:[+-]UseConcMarkSweepGC$/,
    /^-XX:[+-]?CMS\w*(=.*)?$/,
    /^-XX:[+-]UseParNewGC$/,
    /^-XX:(Max)?PermSize=.*$/
]

/**
 * Whether a single JVM option was removed from Java after version 8.
 *
 * @param {string} option
 * @returns {boolean}
 */
function isRemovedAfterJava8(option) {
    return typeof option === 'string' && REMOVED_AFTER_JAVA8.some(pattern => pattern.test(option.trim()))
}

/**
 * Whether saved JVM options are (or still contain) the Java 8 defaults, so they can be replaced by the
 * modern defaults once. Options a player picked themselves, without CMS, are left alone.
 *
 * @param {string[]} options
 * @returns {boolean}
 */
function hasJava8Defaults(options) {
    return Array.isArray(options) && options.some(isRemovedAfterJava8)
}

/**
 * The options without the ones modern Java would refuse to start with.
 *
 * @param {string[]} options
 * @returns {{kept: string[], dropped: string[]}}
 */
function dropRemovedAfterJava8(options) {
    const kept = []
    const dropped = []
    for (const option of options ?? []) {
        (isRemovedAfterJava8(option) ? dropped : kept).push(option)
    }
    return { kept, dropped }
}

module.exports = { JAVA8_DEFAULTS, isRemovedAfterJava8, hasJava8Defaults, dropRemovedAfterJava8 }
