/**
 * Script for ionaccount.ejs: the onboarding step after the Minecraft sign-in, where the player
 * creates or signs in to their ION account without leaving the launcher. The Minecraft name the
 * launcher already knows becomes the account's name.
 *
 * Requests go through the main process (`web:account` and `web:discord` in index.js) to the website's
 * /api/launcher/account/* routes; a session lands in the web tabs' cookie, never in this page.
 */
/* global ConfigManager, Lang, VIEWS, switchView, showTab, signedInToWebsite, webState, accountPromptOffered:writable, accountPrompt:writable */
const IonAccount = (() => {
    const AccountWeb = require('./assets/js/weburl')

    const view = document.getElementById('ionAccountContainer')
    const form = document.getElementById('ionAccountForm')
    const $ = id => document.getElementById(id)
    const fields = {
        email: $('ionAccountEmail'),
        identifier: $('ionAccountIdentifier'),
        password: $('ionAccountPassword'),
        code: $('ionAccountCode'),
        consent: $('ionAccountConsent')
    }
    const submit = $('ionAccountSubmit')
    const discordButton = $('ionAccountDiscord')
    const errorEl = $('ionAccountError')
    const t = (key, values) => Lang.queryJS(`ionAccount.${key}`, values)

    let tempToken = null
    let busy = false

    const player = () => ConfigManager.getSelectedAccount()

    function setMode(mode){
        view.dataset.mode = mode
        // The length rule is a sign-up's; an existing password is whatever it is.
        fields.password.placeholder = mode === 'register' ? t('passwordHint') : ''
        fields.password.autocomplete = mode === 'register' ? 'new-password' : 'current-password'
        view.querySelectorAll('[data-show]').forEach(el => {
            el.hidden = !el.dataset.show.split(' ').includes(mode)
        })
        showError(null)
        const first = { register: fields.email, login: fields.identifier.value ? fields.password : fields.identifier, twofa: fields.code }[mode]
        if(first) setTimeout(() => first.focus(), 50)
    }

    function showError(text){
        errorEl.textContent = text || ''
        errorEl.hidden = !text
    }

    function setBusy(v, button = submit){
        busy = v
        button.toggleAttribute('loading', v)
        Object.values(fields).forEach(f => { f.disabled = v })
    }

    /** Fill in the signed-in Minecraft account. Called by onboarding.js when the step shows. */
    function show(){
        // This step asks what the Play view's account prompt would; never both at once.
        accountPromptOffered = true
        accountPrompt?.remove()
        accountPrompt = null
        const account = player()
        $('ionAccountName').textContent = account?.displayName ?? ''
        if(account) $('ionAccountHead').src = `https://mc-heads.net/avatar/${encodeURIComponent(account.uuid)}/40`
        fields.identifier.value = account?.displayName ?? ''
        setMode('register')
    }

    /**
     * Where a first-run sign-in goes next: this step, unless the website already knows the player.
     *
     * @param {string} next The view the sign-in was asked to return to.
     */
    function after(next){
        return next === VIEWS.ionAccount && webState?.loggedIn ? VIEWS.landing : next
    }

    /** Leave for the Play view, opening a website page on the way. */
    function finish(path){
        // The Play view's own account prompt would ask the same thing again.
        accountPromptOffered = true
        switchView(VIEWS.ionAccount, VIEWS.landing, 500, 500, () => {
            if(path) showTab('challenges', path)
        })
    }

    function done(username, registered){
        signedInToWebsite(username)
        $('ionAccountDoneTitle').textContent = t(registered ? 'doneRegisteredTitle' : 'doneTitle', { name: username || player()?.displayName || '' })
        $('ionAccountDoneText').textContent = t(registered ? 'doneRegisteredText' : 'doneText')
        setMode('done')
    }

    /** The site's answer as one sentence for the player. */
    function explain(res){
        if(res.gate) return t('error.gate')
        if(res.code === 'UNAVAILABLE' || !res.error) return t('error.unavailable')
        return res.error
    }

    async function send(action, body){
        return invoke(submit, 'web:account', action, body)
    }

    async function invoke(button, channel, ...args){
        setBusy(true, button)
        try {
            return await ipcRenderer.invoke(channel, ...args)
        } catch {
            return { ok: false, code: 'UNAVAILABLE' }
        } finally {
            setBusy(false, button)
        }
    }

    /** Sign in or sign up with Discord in its own window (index.js); a new player gets an account. */
    async function discord(){
        showError(null)
        const res = await invoke(discordButton, 'web:discord')
        if(!res.ok){
            if(res.code === 'CANCELLED') return
            if(res.code === 'ALREADY_OPEN') return showError(t('error.discordOpen'))
            if(res.code === 'NO_TOKEN') return showError(t('error.discordNoToken'))
            return showError(explain(res))
        }
        if(res.requires2fa){
            tempToken = res.tempToken
            fields.code.value = ''
            return setMode('twofa')
        }
        done(res.username, false)
    }

    async function register(){
        const email = fields.email.value.trim()
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError(t('error.email'))
        if(fields.password.value.length < 8) return showError(t('error.password'))
        if(!fields.consent.checked) return showError(t('error.consent'))
        const res = await send('register', { minecraftName: player()?.displayName, email, password: fields.password.value })
        if(!res.ok){
            if(res.code === 'TAKEN'){
                // Most likely their own account: move them to the sign-in with what they typed.
                setMode('login')
                fields.identifier.value = email
                fields.password.focus()
            }
            return showError(explain(res))
        }
        if(res.confirmEmail){
            $('ionAccountDoneTitle').textContent = t('confirmTitle')
            $('ionAccountDoneText').textContent = t('confirmText', { email })
            return setMode('done')
        }
        done(res.username, true)
    }

    async function login(){
        const identifier = fields.identifier.value.trim()
        if(!identifier) return showError(t('error.identifier'))
        if(!fields.password.value) return showError(t('error.passwordEmpty'))
        const res = await send('login', { identifier, password: fields.password.value })
        if(!res.ok) return showError(explain(res))
        if(res.requires2fa){
            tempToken = res.tempToken
            fields.code.value = ''
            return setMode('twofa')
        }
        done(res.username, false)
    }

    async function verify(){
        const code = fields.code.value.replace(/\s+/g, '')
        if(!/^\d{6}$/.test(code)) return showError(t('error.code'))
        const res = await send('twoFactor', { tempToken, code })
        if(!res.ok){
            if(res.code === 'EXPIRED') setMode('login')
            return showError(explain(res))
        }
        done(res.username, false)
    }

    form.addEventListener('submit', e => {
        e.preventDefault()
        if(busy) return
        const mode = view.dataset.mode
        if(mode === 'register') register()
        else if(mode === 'login') login()
        else if(mode === 'twofa') verify()
        else finish(null)
    })

    view.querySelectorAll('[data-mode-to]').forEach(btn => {
        btn.onclick = () => setMode(btn.dataset.modeTo)
    })
    $('ionAccountReveal').onclick = () => {
        const reveal = fields.password.type === 'password'
        fields.password.type = reveal ? 'text' : 'password'
        $('ionAccountReveal').textContent = t(reveal ? 'hide' : 'show')
    }
    $('ionAccountPrivacy').href = `${AccountWeb.url}/privacy`
    $('ionAccountForgot').onclick = e => {
        e.preventDefault()
        finish('/auth/forgot-password')
    }
    $('ionAccountSkip').onclick = () => finish(null)
    discordButton.onclick = () => { if(!busy) discord() }

    setMode('register')
    return { show, after }
})()
