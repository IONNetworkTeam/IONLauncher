/**
 * Script for overlay.ejs
 */

/* Overlay Wrapper Functions */

/**
 * Check to see if the overlay is visible.
 * 
 * @returns {boolean} Whether or not the overlay is visible.
 */
function isOverlayVisible(){
    return document.getElementById('main').hasAttribute('overlay')
}

let overlayHandlerContent

/**
 * Overlay keydown handler for a non-dismissable overlay.
 * 
 * @param {KeyboardEvent} e The keydown event.
 */
function overlayKeyHandler (e){
    if(e.key === 'Enter' || e.key === 'Escape'){
        document.getElementById(overlayHandlerContent).getElementsByClassName('overlayKeybindEnter')[0].click()
    }
}
/**
 * Overlay keydown handler for a dismissable overlay.
 * 
 * @param {KeyboardEvent} e The keydown event.
 */
function overlayKeyDismissableHandler (e){
    if(e.key === 'Enter'){
        document.getElementById(overlayHandlerContent).getElementsByClassName('overlayKeybindEnter')[0].click()
    } else if(e.key === 'Escape'){
        document.getElementById(overlayHandlerContent).getElementsByClassName('overlayKeybindEsc')[0].click()
    }
}

/**
 * Bind overlay keydown listeners for escape and exit.
 * 
 * @param {boolean} state Whether or not to add new event listeners.
 * @param {string} content The overlay content which will be shown.
 * @param {boolean} dismissable Whether or not the overlay is dismissable 
 */
function bindOverlayKeys(state, content, dismissable){
    overlayHandlerContent = content
    document.removeEventListener('keydown', overlayKeyHandler)
    document.removeEventListener('keydown', overlayKeyDismissableHandler)
    if(state){
        if(dismissable){
            document.addEventListener('keydown', overlayKeyDismissableHandler)
        } else {
            document.addEventListener('keydown', overlayKeyHandler)
        }
    }
}

/* Dialogs (dialog.css) */

/** The icons a dialog can show in its tile, as the inside of a 24×24 stroked SVG. */
const DIALOG_ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    java: '<path d="M10 2v2M14 2v2M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    signOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    offline: '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M5 12.86a10 10 0 0 1 5.17-2.69M19 12.86a10 10 0 0 0-2-1.52M2 8.82a15 15 0 0 1 4.18-2.64M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/>',
    download: '<path d="M12 15V3M7 10l5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M10 12l4 4M14 12l-4 4"/>',
    mod: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    star: '<path d="M12 3 14.4 9.6 21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
}

/**
 * The SVG for a dialog icon.
 *
 * @param {string} name A key of DIALOG_ICONS.
 * @returns {string} The icon's markup.
 */
function dialogIcon(name){
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DIALOG_ICONS[name] ?? DIALOG_ICONS.info}</svg>`
}

/**
 * The head of a dialog card: its icon tile and kicker.
 *
 * @param {string} icon A key of DIALOG_ICONS.
 * @param {string} kicker The kicker text (escaped by the caller).
 * @returns {string} The head's markup.
 */
function dialogHead(icon, kicker){
    return `<div class="dlg-head"><span class="dlg-icon">${dialogIcon(icon)}</span><span class="dlg-kicker">${kicker}</span></div>`
}

/** Show a .dlg backdrop and let its card rise in. */
function openDialog(root){
    root.hidden = false
    void root.offsetWidth  // start the entrance from the hidden state
    root.classList.add('is-open')
}

/**
 * Fade a .dlg backdrop out, then hide it.
 *
 * @param {HTMLElement} root The .dlg element.
 * @param {function} [after] Called once it is hidden, unless it was opened again meanwhile.
 */
function closeDialog(root, after){
    root.classList.remove('is-open')
    setTimeout(() => {
        if(root.classList.contains('is-open')) return
        root.hidden = true
        after?.()
    }, 220)
}

for(const el of document.querySelectorAll('#overlayContainer [data-dialog-icon]')){
    el.innerHTML = dialogIcon(el.dataset.dialogIcon)
}

/**
 * Show only the given content card of the overlay.
 *
 * @param {string} content The id of the content card.
 * @param {boolean} dismissable Whether the message card shows its dismiss button.
 */
function showOverlayContent(content, dismissable){
    $('#' + content).parent().children('.dlg-card').hide()
    $('#' + content).show()
    $('#overlayDismiss').toggle(!!dismissable)
}

/**
 * Toggle the visibility of the overlay.
 * 
 * @param {boolean} toggleState True to display, false to hide.
 * @param {boolean} dismissable Optional. True to show the dismiss option, otherwise false.
 * @param {string} content Optional. The content div to be shown.
 */
function toggleOverlay(toggleState, dismissable = false, content = 'overlayContent'){
    if(toggleState == null){
        toggleState = !document.getElementById('main').hasAttribute('overlay')
    }
    if(typeof dismissable === 'string'){
        content = dismissable
        dismissable = false
    }
    bindOverlayKeys(toggleState, content, dismissable)
    const container = document.getElementById('overlayContainer')
    if(toggleState){
        document.getElementById('main').setAttribute('overlay', true)
        // Make things untabbable.
        $('#main *').attr('tabindex', '-1')
        showOverlayContent(content, dismissable)
        openDialog(container)
    } else {
        document.getElementById('main').removeAttribute('overlay')
        // Make things tabbable.
        $('#main *').removeAttr('tabindex')
        closeDialog(container, () => showOverlayContent(content, dismissable))
    }
}

async function toggleServerSelection(toggleState){
    await prepareServerSelectionList()
    toggleOverlay(toggleState, true, 'serverSelectContent')
}

/**
 * Set the content of the overlay's message card.
 *
 * Takes either the four strings below, or one object:
 * { tone, icon, kicker, title, description, acknowledge, dismiss, destructive }.
 * tone is 'info' (the default), 'warn', 'danger' or 'good' and colours the card; icon is a key of
 * DIALOG_ICONS; destructive paints the acknowledge button red. Titles and descriptions are HTML.
 * 
 * @param {string|Object} title Overlay title text, or the whole content.
 * @param {string} description Overlay description text.
 * @param {string} acknowledge Acknowledge button text.
 * @param {string} dismiss Dismiss button text.
 */
function setOverlayContent(title, description, acknowledge, dismiss){
    const c = typeof title === 'object' ? title : { title, description, acknowledge, dismiss }
    const tone = c.tone ?? 'info'
    document.getElementById('overlayContent').dataset.tone = tone
    document.getElementById('overlayIcon').innerHTML = dialogIcon(c.icon ?? { warn: 'alert', danger: 'error', good: 'check' }[tone] ?? 'info')
    document.getElementById('overlayKicker').textContent = c.kicker ?? Lang.queryJS(`overlay.kicker.${tone}`)
    document.getElementById('overlayTitle').innerHTML = c.title
    document.getElementById('overlayDesc').innerHTML = c.description
    const ack = document.getElementById('overlayAcknowledge')
    ack.innerHTML = c.acknowledge
    ack.classList.toggle('dlg-primary', !c.destructive)
    ack.classList.toggle('dlg-danger', !!c.destructive)
    document.getElementById('overlayDismiss').innerHTML = c.dismiss ?? Lang.queryJS('overlay.dismiss')
}

/**
 * Set the onclick handler of the overlay acknowledge button.
 * If the handler is null, a default handler will be added.
 * 
 * @param {function} handler 
 */
function setOverlayHandler(handler){
    if(handler == null){
        document.getElementById('overlayAcknowledge').onclick = () => {
            toggleOverlay(false)
        }
    } else {
        document.getElementById('overlayAcknowledge').onclick = handler
    }
}

/**
 * Set the onclick handler of the overlay dismiss button.
 * If the handler is null, a default handler will be added.
 * 
 * @param {function} handler 
 */
function setDismissHandler(handler){
    if(handler == null){
        document.getElementById('overlayDismiss').onclick = () => {
            toggleOverlay(false)
        }
    } else {
        document.getElementById('overlayDismiss').onclick = handler
    }
}

/* Server Select View */

document.getElementById('serverSelectConfirm').addEventListener('click', async () => {
    const listings = document.getElementsByClassName('serverListing')
    for(let i=0; i<listings.length; i++){
        if(listings[i].hasAttribute('selected')){
            const serv = (await DistroAPI.getDistribution()).getServerById(listings[i].getAttribute('servid'))
            updateSelectedServer(serv)
            refreshServerStatus(true)
            toggleOverlay(false)
            return
        }
    }
    // None are selected? Not possible right? Meh, handle it.
    if(listings.length > 0){
        const serv = (await DistroAPI.getDistribution()).getServerById(listings[0].getAttribute('servid'))
        updateSelectedServer(serv)
        toggleOverlay(false)
    }
})

document.getElementById('accountSelectConfirm').addEventListener('click', async () => {
    const listings = document.getElementsByClassName('accountListing')
    for(let i=0; i<listings.length; i++){
        if(listings[i].hasAttribute('selected')){
            const authAcc = ConfigManager.setSelectedAccount(listings[i].getAttribute('uuid'))
            ConfigManager.save()
            updateSelectedAccount(authAcc)
            if(getCurrentView() === VIEWS.settings) {
                await prepareSettings()
            }
            toggleOverlay(false)
            validateSelectedAccount()
            return
        }
    }
    // None are selected? Not possible right? Meh, handle it.
    if(listings.length > 0){
        const authAcc = ConfigManager.setSelectedAccount(listings[0].getAttribute('uuid'))
        ConfigManager.save()
        updateSelectedAccount(authAcc)
        if(getCurrentView() === VIEWS.settings) {
            await prepareSettings()
        }
        toggleOverlay(false)
        validateSelectedAccount()
    }
})

// Bind server select cancel button.
document.getElementById('serverSelectCancel').addEventListener('click', () => {
    toggleOverlay(false)
})

document.getElementById('accountSelectCancel').addEventListener('click', () => {
    $('#accountSelectContent').fadeOut(250, () => {
        bindOverlayKeys(true, 'overlayContent', true)
        $('#overlayContent').fadeIn(250)
    })
})

function setServerListingHandlers(){
    const listings = Array.from(document.getElementsByClassName('serverListing'))
    listings.map((val) => {
        val.onclick = e => {
            if(val.hasAttribute('selected')){
                return
            }
            const cListings = document.getElementsByClassName('serverListing')
            for(let i=0; i<cListings.length; i++){
                if(cListings[i].hasAttribute('selected')){
                    cListings[i].removeAttribute('selected')
                }
            }
            val.setAttribute('selected', '')
            document.activeElement.blur()
        }
    })
}

function setAccountListingHandlers(){
    const listings = Array.from(document.getElementsByClassName('accountListing'))
    listings.map((val) => {
        val.onclick = e => {
            if(val.hasAttribute('selected')){
                return
            }
            const cListings = document.getElementsByClassName('accountListing')
            for(let i=0; i<cListings.length; i++){
                if(cListings[i].hasAttribute('selected')){
                    cListings[i].removeAttribute('selected')
                }
            }
            val.setAttribute('selected', '')
            document.activeElement.blur()
        }
    })
}

async function populateServerListings(){
    const distro = await DistroAPI.getDistribution()
    const giaSel = ConfigManager.getSelectedServer()
    const servers = distro.servers
    let htmlString = ''
    for(const serv of servers){
        const raw = serv.rawServer
        const meta = [raw.minecraftVersion, raw.version, raw.mainServer ? Lang.queryJS('settings.serverListing.mainServer') : null].filter(Boolean).map(escapeHtml).join(' · ')
        htmlString += `<button class="serverListing dlg-row" servid="${escapeHtml(raw.id)}" ${raw.id === giaSel ? 'selected' : ''}>
            <img class="dlg-row-img" src="${escapeHtml(raw.icon)}" alt=""/>
            <span class="dlg-row-main">
                <span class="dlg-row-title">${escapeHtml(raw.name)}</span>
                <span class="dlg-row-sub">${escapeHtml(raw.description ?? '')}</span>
                <span class="dlg-row-meta">${meta}</span>
            </span>
            <span class="dlg-row-check">${dialogIcon('check')}</span>
        </button>`
    }
    document.getElementById('serverSelectListScrollable').innerHTML = htmlString

}

function populateAccountListings(){
    const accountsObj = ConfigManager.getAuthAccounts()
    const accounts = Array.from(Object.keys(accountsObj), v=>accountsObj[v])
    let htmlString = ''
    for(let i=0; i<accounts.length; i++){
        htmlString += `<button class="accountListing dlg-row" uuid="${escapeHtml(accounts[i].uuid)}" ${i===0 ? 'selected' : ''}>
            <img class="dlg-row-img" src="https://mc-heads.net/avatar/${escapeHtml(accounts[i].uuid)}/36" alt=""/>
            <span class="dlg-row-main"><span class="dlg-row-title accountListingName">${escapeHtml(accounts[i].displayName)}</span></span>
            <span class="dlg-row-check">${dialogIcon('check')}</span>
        </button>`
    }
    document.getElementById('accountSelectListScrollable').innerHTML = htmlString

}

async function prepareServerSelectionList(){
    await populateServerListings()
    setServerListingHandlers()
}

function prepareAccountSelectionList(){
    populateAccountListings()
    setAccountListingHandlers()
}