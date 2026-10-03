const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Requirements
const { app, BrowserWindow, ipcMain, Menu, safeStorage, session, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')
const Web                               = require('./app/assets/js/weburl')
const WebAuth                           = require('./app/assets/js/webauth')
const Friends                           = require('./app/assets/js/friends')
const { createWallStore }               = require('./app/assets/js/wallstore')
const { LoggerUtil }                    = require('helios-core')

// Setup Lang
LangLoader.setupLanguage()

let betaChannel = null

/**
 * Choose the update channel. Betas are published as GitHub pre-releases (e.g. 2.3.0-beta.1).
 *
 * @param {boolean} beta True to receive beta versions, false for stable releases only.
 * @returns {boolean} Whether the channel changed.
 */
function setUpdateChannel(beta){
    const changed = betaChannel !== null && betaChannel !== beta
    betaChannel = beta
    autoUpdater.allowPrerelease = beta
    // Leaving the beta means installing the latest stable release, which is an older version.
    autoUpdater.allowDowngrade = !beta && semver.prerelease(app.getVersion()) != null
    return changed
}

// Setup auto updater.
function initAutoUpdater(event, data) {

    setUpdateChannel(!!data)

    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    }) 
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            // Sent on every settings save; check for updates only when the channel changed.
            if(setUpdateChannel(!!data) && !isDev){
                autoUpdater.checkForUpdates()
                    .catch(err => {
                        event.sender.send('autoUpdateNotification', 'realerror', err)
                    })
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})
// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})

// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Hardware acceleration stays on: the web tabs are far too expensive to draw in software.
// Chromium falls back to software rendering by itself if the GPU process fails; set
// ION_DISABLE_GPU=1 to force it on a machine whose driver misdraws instead of crashing.
if(process.env.ION_DISABLE_GPU === '1'){
    app.disableHardwareAcceleration()
}


const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

/**
 * The wallpaper cache (wallstore.js). Created with the first window; the IPC handler is registered
 * once here because createWindow can run again (macOS re-opens a window on activate).
 */
let walls = null
let wallsReady = Promise.resolve()
ipcMain.handle('wallpapers:list', async () => {
    await wallsReady
    return walls ? walls.list() : { releases: {} }
})

function startWallpapers(win){
    if(!walls){
        walls = createWallStore({
            dir: path.join(app.getPath('userData'), 'wallpapers'),
            fetchJson: async (p) => {
                const res = await WebAuth.fetchWeb(p)
                return res.ok ? res.json() : null
            },
            fetchBytes: async (p) => {
                const res = await WebAuth.fetchWeb(p)
                return res.ok ? Buffer.from(await res.arrayBuffer()) : null
            },
            onChange: (list) => {
                for(const w of BrowserWindow.getAllWindows()){
                    if(!w.isDestroyed()) w.webContents.send('wallpapers:changed', list)
                }
            },
            logger: LoggerUtil.getLogger('WallStore')
        })
        wallsReady = walls.open().catch(err => LoggerUtil.getLogger('WallStore').error('Wallpaper cache unavailable.', err))
        setInterval(() => walls.sync(), 30 * 60 * 1000)
    }
    win.webContents.once('did-finish-load', () => {
        setTimeout(() => wallsReady.then(() => walls.sync()), 4000)
    })
}

function createWindow() {

    win = new BrowserWindow({
        width: 1180,
        height: 740,
        minWidth: 980,
        minHeight: 620,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false,
            // The web tabs; see "Web tabs" below.
            webviewTag: true
        },
        backgroundColor: '#1E212B'
    })
    remoteMain.enable(win.webContents)
    WebAuth.init(win)
    // The friends system (app/assets/js/friends): registers its IPC handlers once.
    Friends.init({ app, ipcMain, BrowserWindow, safeStorage, webAuth: WebAuth, web: Web, appDir: path.join(__dirname, 'app'), host: win, logger: LoggerUtil.getLogger('Friends') })
    startWallpapers(win)

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

/*
 * Web tabs.
 *
 * Some tabs show the configured website (see weburl.js) in <webview>s. Whatever a page asks for,
 * a webview gets only our preload and no Node.js, may only load the website and the sign-in
 * providers it redirects through, and sends every other link and new window to the system
 * browser. The website recognises the launcher by the `IONLauncher/<version>` token in the user
 * agent. See docs/website-integration.md.
 */
const WEBBRIDGE_PRELOAD = path.join(__dirname, 'app', 'assets', 'js', 'webbridge.js')
/** OAuth providers whose sign-in pages may open inside a web tab. */
const SIGN_IN_HOSTS = ['discord.com']

function isLocalHost(hostname){
    return hostname === 'localhost' || hostname === '127.0.0.1'
}

const MAP_PARTITION = 'persist:ionmap'
/** Origins of the releases' live maps, handed over by the renderer when a map tab opens. */
const mapOrigins = new Set()
// Synchronous: the renderer attaches the map's webview right after, and the origin must be known by then.
ipcMain.on('web:allowMap', (e, url) => {
    try {
        const u = new URL(url)
        if(u.protocol === 'https:' || u.protocol === 'http:') mapOrigins.add(u.origin)
    } catch { /* not a URL */ }
    e.returnValue = true
})
const isMapUrl = url => { try { return mapOrigins.has(new URL(url).origin) } catch { return false } }

function allowedInWebview(url){
    let u
    try { u = new URL(url) } catch { return false }
    if(u.origin === Web.origin) return true
    if(u.protocol === 'https:' && SIGN_IN_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return true
    // The site's own subdomains (an API host, for example), or any local port in development.
    const site = new URL(Web.url).hostname
    if(isLocalHost(site)) return isLocalHost(u.hostname)
    const base = site.split('.').slice(-2).join('.')
    return u.hostname === base || u.hostname.endsWith('.' + base)
}

app.on('ready', () => {
    const web = session.fromPartition(Web.partition)
    web.setUserAgent(`${web.getUserAgent()} IONLauncher/${app.getVersion()}`)
})

// Basic auth challenges from the website are answered by webauth.js.
app.on('login', (event, _webContents, details, authInfo, callback) => {
    if(authInfo.isProxy || authInfo.scheme.toLowerCase() !== 'basic') return
    let origin
    try { origin = new URL(details.url).origin } catch { return }
    if(origin !== Web.origin) return
    event.preventDefault()
    WebAuth.onLogin(details, callback)
})

app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
        // A release's live map: its own partition, no site login, no bridge, its own origin only.
        if(params.partition === MAP_PARTITION){
            delete webPreferences.preload
            delete webPreferences.preloadURL
            webPreferences.nodeIntegration = false
            webPreferences.nodeIntegrationInSubFrames = false
            webPreferences.contextIsolation = true
            webPreferences.sandbox = true
            webPreferences.webSecurity = true
            if(!isMapUrl(params.src)) event.preventDefault()
            return
        }
        delete webPreferences.preloadURL
        webPreferences.preload = WEBBRIDGE_PRELOAD
        webPreferences.nodeIntegration = false
        webPreferences.nodeIntegrationInSubFrames = false
        webPreferences.contextIsolation = true
        webPreferences.sandbox = true
        webPreferences.webSecurity = true
        if(params.partition !== Web.partition || !params.src.startsWith(Web.origin + '/')){
            event.preventDefault()
        }
    })
    if(contents.getType() !== 'webview') return
    contents.setWindowOpenHandler(({ url }) => {
        if(/^https?:/.test(url)) shell.openExternal(url)
        return { action: 'deny' }
    })
    const isMapView = contents.session === session.fromPartition(MAP_PARTITION)
    contents.on('will-navigate', (event, url) => {
        if(isMapView ? isMapUrl(url) : allowedInWebview(url)) return
        event.preventDefault()
        if(/^https?:/.test(url)) shell.openExternal(url)
    })
    contents.on('will-redirect', (event, url) => {
        if(!(isMapView ? isMapUrl(url) : allowedInWebview(url))) event.preventDefault()
    })
})

app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
