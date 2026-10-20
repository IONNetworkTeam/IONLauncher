/* global navigator, window */
/**
 * Preload for the web tabs: the launcher's side of the website bridge.
 *
 * Runs sandboxed and context-isolated. The page gets `window.ionLauncher` with two
 * fire-and-forget calls and `linkMinecraft()`, which takes nothing and answers once the launcher
 * is done; the host page (shell.js) checks that a message came from the configured website before
 * acting on it. See docs/website-integration.md.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Images and links are not dragged (see the same guard in shell.js). Elements the site marks
// draggable still are.
window.addEventListener('dragstart', e => {
    const t = e.target
    if(t && t.closest && t.closest('img, a') && !t.closest('[draggable="true"]')) e.preventDefault()
}, true)

const version = (navigator.userAgent.match(/\bIONLauncher\/([0-9A-Za-z.+-]+)/) || [])[1] || null

/** linkMinecraft() calls waiting for the launcher's answer, by id. */
const linkWaiting = new Map()
let linkSeq = 0
ipcRenderer.on('web:linkMinecraftResult', (_e, result) => {
    const resolve = linkWaiting.get(result?.id)
    if(!resolve) return
    linkWaiting.delete(result.id)
    resolve(result.ok === true
        ? { ok: true, minecraftName: String(result.minecraftName ?? '') }
        : { ok: false, reason: ['cancelled', 'busy'].includes(result.reason) ? result.reason : 'failed', error: typeof result.error === 'string' ? result.error : undefined })
})

contextBridge.exposeInMainWorld('ionLauncher', {
    version,
    /**
     * Tell the launcher who is logged in on the site.
     *
     * @param {{loggedIn: boolean, username: ?string, minecraftName: ?string, minecraftUuid: ?string, balance: ?number, path: ?string}} state
     */
    report(state){
        if(!state || typeof state !== 'object') return
        ipcRenderer.sendToHost('web:report', {
            loggedIn: !!state.loggedIn,
            username: state.username ?? null,
            minecraftName: state.minecraftName ?? null,
            minecraftUuid: state.minecraftUuid ?? null,
            balance: typeof state.balance === 'number' ? state.balance : null,
            path: typeof state.path === 'string' ? state.path : null
        })
    },
    /**
     * Show a notification in the launcher, whichever tab is open.
     *
     * @param {{text: string, href: string}} note The text, and the site path it opens.
     */
    toast(note){
        if(!note || typeof note.text !== 'string' || typeof note.href !== 'string') return
        ipcRenderer.sendToHost('web:toast', { text: note.text.slice(0, 200), href: note.href.slice(0, 500) })
    },
    /**
     * Verify the launcher's Minecraft account for the ION account signed in on the site. The
     * launcher runs the exchange itself and asks the player in its own window; nothing from the
     * page goes into it.
     *
     * @returns {Promise<{ok: true, minecraftName: string} | {ok: false, reason: 'cancelled'|'busy'|'failed', error?: string}>}
     */
    linkMinecraft(){
        return new Promise(resolve => {
            const id = ++linkSeq
            linkWaiting.set(id, resolve)
            ipcRenderer.sendToHost('web:linkMinecraft', { id })
        })
    }
})
