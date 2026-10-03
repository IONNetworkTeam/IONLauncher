/* global navigator, window */
/**
 * Preload for the web tabs: the launcher's side of the website bridge.
 *
 * Runs sandboxed and context-isolated. The page gets `window.ionLauncher` with two
 * fire-and-forget calls and nothing else; the host page (shell.js) checks that a message came
 * from the configured website before acting on it. See docs/website-integration.md.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Images and links are not dragged (see the same guard in shell.js). Elements the site marks
// draggable still are.
window.addEventListener('dragstart', e => {
    const t = e.target
    if(t && t.closest && t.closest('img, a') && !t.closest('[draggable="true"]')) e.preventDefault()
}, true)

const version = (navigator.userAgent.match(/\bIONLauncher\/([0-9A-Za-z.+-]+)/) || [])[1] || null

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
    }
})
