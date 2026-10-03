/**
 * HTTP basic authentication for the website (main process only).
 *
 * A website that is not public yet may sit behind basic auth. Every request to it can then be
 * answered with 401: the web tabs' pages and everything they load, and the feed the Play tab
 * reads. This module holds the credentials and answers for all of them:
 *
 *  - `onLogin()` answers `app.on('login')` challenges from the web tabs.
 *  - The `web:fetchJson` IPC handler makes the launcher's own requests. They have to come from
 *    the main process: the launcher page is a file:// document, and a cross-origin request with
 *    an Authorization header needs a CORS preflight, which the auth gate also rejects.
 *
 * Credentials are verified against the site before they are used. They come from, in order:
 * memory, the encrypted file written when the user chose "Remember" (Electron safeStorage),
 * the ION_WEB_AUTH environment variable (`user:password`), and finally the user, through the
 * dialog the renderer shows (`web:auth*` IPC channels).
 *
 * @module webauth
 */
const { app, ipcMain, net, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const Web = require('./weburl')

/** An endpoint any version of the site answers, used to check credentials. */
const PROBE_PATH = '/api/launcher/feed'
/** A second challenge for the same URL within this window means the credentials were refused. */
const RETRY_WINDOW = 10000

const credentialsFile = () => path.join(app.getPath('userData'), 'web-auth.bin')

let current = null
let pending = null
let host = null
let declined = false
let initialised = false
const answeredAt = new Map()

function header(creds){
    return 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
}

function load(){
    try {
        if(fs.existsSync(credentialsFile()) && safeStorage.isEncryptionAvailable()){
            const creds = JSON.parse(safeStorage.decryptString(fs.readFileSync(credentialsFile())))
            if(creds?.username && typeof creds.password === 'string') return creds
        }
    } catch {
        // Unreadable or written on another machine: ask again.
    }
    const env = process.env.ION_WEB_AUTH
    if(env && env.includes(':')){
        const i = env.indexOf(':')
        return { username: env.slice(0, i), password: env.slice(i + 1) }
    }
    return null
}

function save(creds){
    try {
        if(safeStorage.isEncryptionAvailable()){
            fs.writeFileSync(credentialsFile(), safeStorage.encryptString(JSON.stringify(creds)), { mode: 0o600 })
        }
    } catch {
        // Kept for this session only.
    }
}

function forget(){
    current = null
    try { fs.rmSync(credentialsFile(), { force: true }) } catch { /* nothing stored */ }
}

/** Whether the site accepts these credentials. Offline counts as yes, so good credentials survive. */
async function check(creds){
    try {
        const res = await net.fetch(Web.url + PROBE_PATH, {
            headers: creds ? { Authorization: header(creds) } : {},
            cache: 'no-store'
        })
        return res.status !== 401
    } catch {
        return true
    }
}

/** Ask the user. Resolves to verified credentials, or null if they cancel. */
function ask(failed){
    if(pending) return pending
    pending = new Promise(resolve => {
        if(!host || host.isDestroyed()) return resolve(null)
        const cleanup = () => ipcMain.removeListener('web:authSubmit', onSubmit)
        const onSubmit = async (_e, answer) => {
            if(!answer){
                cleanup()
                declined = true
                host.webContents.send('web:authCancelled')
                return resolve(null)
            }
            const creds = { username: String(answer.username ?? ''), password: String(answer.password ?? '') }
            if(!(await check(creds))){
                host.webContents.send('web:authRequest', { host: Web.host, failed: true })
                return
            }
            cleanup()
            if(answer.remember) save(creds)
            host.webContents.send('web:authAccepted')
            resolve(creds)
        }
        ipcMain.on('web:authSubmit', onSubmit)
        host.webContents.send('web:authRequest', { host: Web.host, failed })
    }).finally(() => { pending = null })
    return pending
}

/**
 * Credentials the site accepts, asking the user if necessary.
 *
 * @param {boolean} rejected True when the site has just refused the current credentials.
 * @returns {Promise<{username: string, password: string}|null>} Null when the user cancelled.
 */
async function credentials(rejected = false){
    if(rejected && current) forget()
    if(current) return current
    if(pending) return pending
    // After a cancel, stay quiet until the user asks to try again (`web:authRetry`).
    if(declined) return null
    const stored = load()
    if(stored && await check(stored)){
        current = stored
        return current
    }
    if(stored) forget()
    current = await ask(!!stored)
    return current
}

/** fetch() through the auth gate, for the launcher's own requests to the website. */
async function fetchWeb(pathname){
    const url = Web.url + pathname
    let res = await net.fetch(url, { headers: current ? { Authorization: header(current) } : {}, cache: 'no-store' })
    if(res.status === 401){
        const creds = await credentials(!!current)
        if(!creds) return res
        res = await net.fetch(url, { headers: { Authorization: header(creds) }, cache: 'no-store' })
    }
    return res
}

/**
 * Answer an `app.on('login')` challenge from a web tab.
 *
 * @param {{url: string}} details The challenged request.
 * @param {Function} callback Electron's login callback.
 */
async function onLogin(details, callback){
    const last = answeredAt.get(details.url)
    const creds = await credentials(last != null && Date.now() - last < RETRY_WINDOW)
    if(!creds) return callback()
    answeredAt.set(details.url, Date.now())
    if(answeredAt.size > 200) answeredAt.delete(answeredAt.keys().next().value)
    callback(creds.username, creds.password)
}

/**
 * Register the IPC handlers.
 *
 * @param {Electron.BrowserWindow} win The window that shows the credentials dialog.
 */
function init(win){
    host = win
    if(initialised) return
    initialised = true
    ipcMain.handle('web:fetchJson', async (_e, pathname) => {
        if(typeof pathname !== 'string' || !pathname.startsWith('/api/launcher/')){
            throw new Error('Only the launcher endpoints may be requested.')
        }
        const res = await fetchWeb(pathname)
        if(!res.ok) return { ok: false, status: res.status }
        return { ok: true, data: await res.json() }
    })
    ipcMain.on('web:authRetry', () => { declined = false })
}

module.exports = { init, onLogin, fetchWeb }
