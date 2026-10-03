/**
 * Settings as a workspace of its own: entering it folds the release slices into a band on the
 * left (which then picks the release being configured) and slides the settings in beside it;
 * leaving unfolds them. uibinder.js's switchView hands every transition into or out of
 * VIEWS.settings to Workspace.transition, so the login flows that return to settings keep working.
 */
/* global $, VIEWS, Slices, TitleBar, prepareSettings, settingsNavItemListener, switchView, getCurrentView, ConfigManager */
const Workspace = (() => {
    const ws = document.getElementById('settingsContainer')
    const landing = document.getElementById('landingContainer')
    const nav = document.getElementById('settingsNavItemsContent')
    const OPEN_MS = 900

    // The blurred wallpaper of the release being configured, behind the settings.
    const ground = document.createElement('img')
    ground.className = 'ws-ground'
    ground.alt = ''
    ws.prepend(ground)

    // The underline that springs between section tabs.
    const line = document.createElement('span')
    line.className = 'ws-tabline'
    nav.appendChild(line)

    function placeLine(){
        const sel = nav.querySelector('.settingsNavItem[selected]')
        if(!sel) return
        line.style.left = `${sel.offsetLeft + 12}px`
        line.style.width = `${sel.offsetWidth - 24}px`
    }
    new MutationObserver(placeLine).observe(nav, { subtree: true, attributes: true, attributeFilter: ['selected'] })
    window.addEventListener('resize', placeLine)

    function refreshGround(){
        const id = ConfigManager.getSelectedServer()
        if(!id || typeof Slices === 'undefined') return
        ground.src = Slices.coverFor(id)
    }

    function setGear(on){
        document.getElementById('settingsMediaButton').setAttribute('aria-pressed', String(on))
    }

    function fold(){
        Slices.setMode('settings')
        TitleBar.setCurrent(null)
        setGear(true)
        refreshGround()
        ws.style.display = 'block'
        requestAnimationFrame(() => {
            ws.classList.add('is-open')
            placeLine()
        })
    }

    function unfold(){
        ws.classList.remove('is-open')
        Slices.setMode('play')
        TitleBar.setCurrent('home')
        setGear(false)
        setTimeout(() => { if(!ws.classList.contains('is-open')) ws.style.display = 'none' }, 500)
    }

    /** Called by switchView for any transition that involves VIEWS.settings. */
    function transition(current, next, currentFadeTime, nextFadeTime, onCurrentFade, onNextFade){
        const run = async (fn) => { if(fn) await fn() }
        if(next === VIEWS.settings){
            if(current === VIEWS.landing || current === VIEWS.settings){
                fold()
                run(onCurrentFade).then(() => setTimeout(() => run(onNextFade), OPEN_MS))
                return
            }
            // From another view (a login that returns to settings): the Play view comes back folded.
            $(current).fadeOut(currentFadeTime, async () => {
                await run(onCurrentFade)
                $(landing).fadeIn(nextFadeTime)
                fold()
                setTimeout(() => run(onNextFade), OPEN_MS)
            })
            return
        }
        // Leaving settings.
        if(next === VIEWS.landing){
            unfold()
            run(onCurrentFade).then(() => setTimeout(() => run(onNextFade), 500))
            return
        }
        // To another view (login): both settings and the Play view fade out.
        ws.classList.remove('is-open')
        $(`${VIEWS.landing}, ${VIEWS.settings}`).fadeOut(currentFadeTime, async () => {
            Slices.setMode('play')
            setGear(false)
            await run(onCurrentFade)
            $(next).fadeIn(nextFadeTime, () => run(onNextFade))
        })
    }

    /** Open settings, optionally on a tab (a nav item's id). */
    async function open(navId){
        if(getCurrentView() !== VIEWS.settings){
            await prepareSettings()
            switchView(getCurrentView(), VIEWS.settings)
        }
        if(navId) settingsNavItemListener(document.getElementById(navId), false)
    }

    /** Save and return to Play. Resolves when the slices have unfolded. */
    function close(){
        if(getCurrentView() !== VIEWS.settings) return Promise.resolve()
        document.getElementById('settingsNavDone').click()
        return new Promise(resolve => setTimeout(resolve, 500))
    }

    document.addEventListener('keydown', e => {
        if(e.key === 'Escape' && getCurrentView() === VIEWS.settings && !$('#overlayContainer').is(':visible')) close()
    })

    return { open, close, transition, refreshGround }
})()
