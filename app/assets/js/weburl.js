/**
 * The address of the community website shown in the launcher's web tabs.
 *
 * Configured as `[js.web] url` in `app/assets/lang/_custom.toml`, next to the launcher's other
 * customizations. The ION_WEB_URL environment variable overrides it, which is handy when
 * developing against a local copy of the site:
 *
 *     ION_WEB_URL=http://localhost:5173 npm start
 *
 * Shared by the main process and the renderer. Values are read lazily because modules are
 * required before the language files are loaded.
 *
 * @module weburl
 */
const LangLoader = require('./langloader')

let cached = null

function resolve(){
    if(cached == null){
        const configured = process.env.ION_WEB_URL || LangLoader.queryJS('web.url')
        if(!configured){
            throw new Error('No website configured. Set [js.web] url in app/assets/lang/_custom.toml.')
        }
        const url = new URL(configured)
        cached = { url: url.origin + url.pathname.replace(/\/+$/, ''), origin: url.origin, host: url.host }
    }
    return cached
}

module.exports = {
    /** The website's base URL, without a trailing slash. */
    get url(){ return resolve().url },
    /** The website's origin, e.g. `https://example.com`. */
    get origin(){ return resolve().origin },
    /** The website's host, for messages shown to the user. */
    get host(){ return resolve().host },
    /** The persistent session shared by every web tab, so a website login survives restarts. */
    partition: 'persist:ionweb'
}
