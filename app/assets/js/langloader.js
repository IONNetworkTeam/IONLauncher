const fs = require('fs-extra')
const path = require('path')
const toml = require('toml')
const merge = require('lodash.merge')

let lang

exports.loadLanguage = function(id){
    lang = merge(lang || {}, toml.parse(fs.readFileSync(path.join(__dirname, '..', 'lang', `${id}.toml`))) || {})
}

exports.query = function(id, placeHolders){
    let query = id.split('.')
    let res = lang
    for(let q of query){
        res = res[q]
    }
    let text = res === lang ? '' : res
    if (placeHolders) {
        Object.entries(placeHolders).forEach(([key, value]) => {
            text = text.replace(`{${key}}`, value)
        })
    }
    return text
}

exports.queryJS = function(id, placeHolders){
    return exports.query(`js.${id}`, placeHolders)
}

exports.queryEJS = function(id, placeHolders){
    return exports.query(`ejs.${id}`, placeHolders)
}

/** The language files beside en_US.toml, by the language part of a locale. */
const TRANSLATIONS = { de: 'de_DE' }

/**
 * The language file for a locale ('de-AT', 'de_DE.UTF-8', …), or null for English. A
 * translation is loaded over en_US.toml, so a key it lacks still reads in English.
 */
exports.pickLanguage = function(locale){
    const lang = String(locale ?? '').toLowerCase().split(/[-_.]/)[0]
    return Object.hasOwn(TRANSLATIONS, lang) ? TRANSLATIONS[lang] : null
}

/**
 * The system's language: ION_LANG when set (e.g. ION_LANG=en to force English), otherwise the
 * locale Intl resolves, which is the same in the main process and the renderers on a normal setup.
 */
exports.systemLocale = function(){
    if(process.env.ION_LANG) return process.env.ION_LANG
    try { return Intl.DateTimeFormat().resolvedOptions().locale } catch { return 'en-US' }
}

exports.setupLanguage = function(){
    // Load Language Files: English first, then the system's translation over it.
    exports.loadLanguage('en_US')
    const translation = exports.pickLanguage(exports.systemLocale())
    if(translation) exports.loadLanguage(translation)

    // Load Custom Language File for Launcher Customizer
    exports.loadLanguage('_custom')
}