/**
 * The Play view: every release on the shelf is a full-height slice of its own wallpaper, the
 * selected one open. Also owns the Play button's look, and folds the other releases away while a
 * game is busy.
 *
 * Loaded after landing.js (GameState, updateSelectedServer, launch functions) and shell.js
 * (showTab). Library and panels hook in through Slices.onOpen / Slices.libraryPick.
 */
/* global ConfigManager, DistroAPI, GameState, updateSelectedServer, ipcRenderer, shell, Lang, LoggerUtil, escapeHtml, showTab, Library */
const { WallCycle } = require('./assets/js/wallcycle')
const { mergeReleases, sanitizePresentation, shelfAfterPick, initialShelf } = require('./assets/js/releasemodel')
const { pathToFileURL } = require('url')

const Slices = (() => {
    const log = LoggerUtil.getLogger('Slices')
    const SHELF_MAX = 4
    const CYCLE_MS = 12000
    const LIB_STRIP_W = 72     // slices.css: .lib-strip's flex-basis
    const SLICE_MIN_W = 54     // slices.css: .slice's min-width
    const SWITCH_MS = 900      // slices.css: .slice's flex-grow transition
    const BUNDLED = [5, 3, 7, 2, 6, 4, 0, 1].map(n => `assets/images/backgrounds/${n}.jpg`)
    const STAR_IMG = 'assets/images/ion/star.svg'

    // The seal's 81 dots, ordered from the centre out, so progress fills it like a charge.
    const DOTS = (() => {
        const rows = [[6,6],[5,7],[4,8],[4,8],[2,10],[1,11],[0,12],[1,11],[2,10],[4,8],[4,8],[5,7],[6,6]]
        const dots = []
        rows.forEach(([a, b], y) => { for(let x = a; x <= b; x++) dots.push({ x, y, d: Math.hypot(x - 6, y - 6) + ((x * 7 + y * 3) % 5) * 0.04 }) })
        return dots.sort((p, q) => p.d - q.d).map(p => `M${p.x + 0.08} ${p.y + 0.5}a.42 .42 0 1 0 .84 0a.42 .42 0 1 0 -.84 0`)
    })()

    const stage = document.getElementById('stage')
    const cluster = document.getElementById('launchCluster')
    const libStrip = document.getElementById('libStrip')
    const waiting = document.createElement('div')
    waiting.className = 'waiting'
    waiting.setAttribute('role', 'status')
    waiting.innerHTML = '<span class="waiting-covers"></span><span class="waiting-title"></span><span class="waiting-rule"></span><span class="waiting-sub"></span>'
    stage.appendChild(waiting)

    let releases = []          // releasemodel view models, distribution order
    let presentation = []      // last /api/launcher/releases answer
    let shelf = []             // release ids, max SHELF_MAX
    let hover = null
    let shownSel = null     // the open slice update() last laid out
    let switchedAt = 0      // when it changed
    let mode = 'play'          // 'play' | 'settings'
    let intro = true
    let walls = { releases: {} }
    let percent = 0
    let nudged = null          // { id, until }
    const cycles = new Map()   // release id → WallCycle
    const nodes = new Map()    // release id → slice element
    let cycleTimer = null
    const openListeners = []

    const byId = id => releases.find(r => r.id === id)
    const picked = () => ConfigManager.getSelectedServer()
    const busy = () => !GameState.canSwitch()
    // While a game is busy its release fills the Play view and the others fold away.
    const focused = () => busy() && mode === 'play'

    /* Data */

    async function loadReleases(){
        const distro = await DistroAPI.getDistribution()
        const servers = distro.servers.map(s => ({
            id: s.rawServer.id, name: s.rawServer.name, description: s.rawServer.description,
            minecraftVersion: s.rawServer.minecraftVersion, address: s.rawServer.address, mainServer: s.rawServer.mainServer
        }))
        try { presentation = sanitizePresentation(JSON.parse(localStorage.getItem('ion.releases.v1'))) } catch { presentation = [] }
        releases = mergeReleases(servers, presentation)
        let saved = null
        try { saved = JSON.parse(localStorage.getItem('ion.shelf.v1')) } catch { saved = null }
        shelf = initialShelf(saved, releases.map(r => r.id), picked() || distro.getMainServer()?.rawServer.id)
        if(picked() && !shelf.includes(picked())) shelf = shelfAfterPick(shelf, picked(), SHELF_MAX)
        build()
        refreshPresentation(servers)
    }

    async function refreshPresentation(servers){
        try {
            const res = await ipcRenderer.invoke('web:fetchJson', '/api/launcher/releases')
            if(!res.ok || !Array.isArray(res.data?.releases)) return
            presentation = sanitizePresentation(res.data.releases)
            localStorage.setItem('ion.releases.v1', JSON.stringify(presentation))
            releases = mergeReleases(servers, presentation)
            build()
        } catch(err) {
            log.warn('Release presentation unavailable; using the cached one.', err)
        }
    }

    function wallsFor(id){
        const local = (walls.releases[id] || []).map(p => pathToFileURL(p).href)
        return local.length ? local : BUNDLED
    }

    /** One picture to stand for a release: its own first one, or a different bundled one per release. */
    function coverFor(id){
        const local = walls.releases[id] || []
        if(local.length) return pathToFileURL(local[0]).href
        const i = Math.max(0, releases.findIndex(r => r.id === id))
        return BUNDLED[i % BUNDLED.length]
    }

    function syncCycles(){
        for(const r of releases){
            const set = wallsFor(r.id)
            if(!cycles.has(r.id)) cycles.set(r.id, new WallCycle(set, set === BUNDLED ? Math.floor(Math.random() * set.length) : 0))
            else cycles.get(r.id).update(set)
        }
    }

    /* DOM */

    function sliceNode(r){
        const el = document.createElement('div')
        el.className = 'slice'
        el.dataset.id = r.id
        el.innerHTML = `
            <img class="slice-img frame" alt=""><img class="slice-img frame" alt="">
            <div class="veil-dim"></div><div class="veil-open"></div>
            <button class="reveal r3 ann" hidden><span class="ann-dot"></span><span class="mono ann-date"></span><span class="ann-text"></span><span class="ann-go">→</span></button>
            <button class="tag">
                <span class="tag-top"></span>
                <span class="tag-mid"><span class="tag-line"></span><span class="tag-name"></span><span class="tag-end"></span></span>
            </button>
            <div class="slice-open">
                <div class="slice-hero">
                    <p class="reveal r1 mono slice-over"></p>
                    <h1 class="reveal r2 slice-title"><span class="slice-title-main"></span><span class="mono slice-edition"></span></h1>
                    <p class="reveal r3 slice-desc"></p>
                    <div class="reveal r4 slice-extra"></div>
                </div>
                <div class="reveal r4 slice-side"><div class="slice-panel"></div></div>
            </div>`
        const tag = el.querySelector('.tag')
        tag.addEventListener('click', () => pick(r.id))
        tag.addEventListener('mouseenter', e => hoverTag(e, r.id))
        tag.addEventListener('mousemove', e => hoverTag(e, r.id))
        tag.addEventListener('mouseleave', () => { if(hover === r.id){ hover = null; update() } })
        el.querySelector('.ann').addEventListener('click', () => openAnnouncement(byId(r.id)))
        return el
    }

    function fillStatic(el, r, index){
        el.classList.toggle('is-net', r.net)
        el.style.setProperty('--acc', r.accent.base)
        el.style.setProperty('--acc-deep', r.accent.deep)
        el.style.setProperty('--acc-text', r.accent.text)
        el.querySelector('.tag').setAttribute('aria-label', r.name)
        el.querySelector('.tag-top').innerHTML = r.net
            ? `<img src="${STAR_IMG}" alt="" class="tag-star">`
            : `<span class="mono tag-num">${String(index + 1).padStart(2, '0')}</span>`
        el.querySelector('.tag-line').classList.toggle('net', r.net)
        el.querySelector('.slice-over').innerHTML = (r.net ? `<img src="${STAR_IMG}" alt="" class="over-star">` : '')
            + `<span class="over-num">${String(index + 1).padStart(2, '0')}</span><span class="over-of"> / ${String(releases.length).padStart(2, '0')}</span>`
            + '<span class="over-rule"></span>'
            + `<span>${escapeHtml(r.net ? Lang.queryJS('slices.gameServer') : r.version)}</span>`
        el.querySelector('.slice-title-main').textContent = r.title
        el.querySelector('.slice-edition').textContent = r.edition
        el.querySelector('.slice-title').classList.toggle('is-net', r.net)
        el.querySelector('.slice-desc').textContent = r.desc
        // A game server's announcement is the newest ION Network blog post (shell.js loads the feed).
        const newest = window.ionNewestArticle
        const ann = r.net ? (newest ? { text: newest.title, date: newest.publishedAt } : null) : r.announcement
        const annEl = el.querySelector('.ann')
        annEl.hidden = !ann
        if(ann){
            annEl.querySelector('.ann-date').textContent = ann.date ? new Date(ann.date).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }).toUpperCase() : ''
            annEl.querySelector('.ann-text').textContent = ann.text
        }
    }

    function build(){
        syncCycles()
        const order = shelf.map(byId).filter(Boolean)
        for(const [id, el] of nodes){
            if(!shelf.includes(id)){ el.remove(); nodes.delete(id) }
        }
        order.forEach(r => {
            if(!nodes.has(r.id)) nodes.set(r.id, sliceNode(r))
            const el = nodes.get(r.id)
            fillStatic(el, r, releases.indexOf(r))
            stage.insertBefore(el, libStrip)
            paintFrame(el, cycles.get(r.id).current, true)
        })
        document.getElementById('libMosaic').innerHTML = releases.slice(0, 8)
            .map(r => `<img src="${escapeHtml(cycles.get(r.id).current || BUNDLED[0])}" alt="">`).join('')
        libStrip.querySelector('.lib-total').textContent = String(releases.length).padStart(2, '0')
        // With every release already on the shelf the library has nothing more to show.
        libStrip.hidden = releases.length <= SHELF_MAX
        const moved = cluster.parentElement !== nodes.get(picked())?.querySelector('.slice-side')
        update()
        // update() announces the open slice only when it changes; new data for the same one (the
        // site's presentation can make it a game server) is announced here, so its panel follows.
        const openEl = nodes.get(picked())
        if(openEl && !moved) openListeners.forEach(fn => fn(byId(picked()), openEl))
    }

    function paintFrame(el, src, instant){
        if(!src) return
        const [a, b] = el.querySelectorAll('.slice-img')
        const front = a.classList.contains('on') ? a : b
        const back = front === a ? b : a
        if(front.getAttribute('src') === src && front.classList.contains('on')) return
        if(instant){ front.src = src; front.classList.add('on'); back.classList.remove('on'); return }
        back.src = src
        back.decode().catch(() => {}).then(() => { back.classList.add('on'); front.classList.remove('on') })
    }

    function update(){
        const sel = picked()
        const focus = focused()
        stage.classList.toggle('is-mini', mode === 'settings')
        if(stage.classList.contains('is-focused') !== focus){
            stage.classList.toggle('is-focused', focus)
            // The open slice's content follows its width only while it unfolds or folds back.
            stage.classList.add('is-refit')
            clearTimeout(update.refit)
            update.refit = setTimeout(() => stage.classList.remove('is-refit'), 950)
        }
        // While a switch runs, hovering leaves the widths alone: the mouse on its way into the opening
        // slice crosses the ones sliding aside, and growing one of them cut the opening short. The
        // hover the mouse ends on applies once the switch is done.
        if(sel !== shownSel){
            shownSel = sel
            switchedAt = Date.now()
            clearTimeout(update.settle)
            update.settle = setTimeout(update, SWITCH_MS)
        }
        const switching = Date.now() - switchedAt < SWITCH_MS
        for(const [id, el] of nodes){
            const r = byId(id)
            const open = id === sel && !intro
            const folded = focus && id !== sel
            let grow = restingGrow(id, open)
            if(mode === 'settings') grow = id === sel ? 1.4 : 1
            else if(folded) grow = 0
            else if(!open && id === hover && !switching) grow = 1.6
            el.style.flexGrow = grow
            el.classList.toggle('is-open', open)
            el.classList.toggle('is-folded', folded)
            const tag = el.querySelector('.tag')
            tag.setAttribute('aria-disabled', String(folded))
            tag.setAttribute('aria-current', id === sel ? 'true' : 'false')
            el.querySelector('.tag-name').textContent = r?.name ?? id
        }
        // The settings band keeps the strip as a sliver; the library opens from Play only.
        libStrip.disabled = mode === 'settings'
        renderWaiting(focus)

        setOpenWidths()
        const openEl = nodes.get(sel)
        if(openEl && cluster.parentElement !== openEl.querySelector('.slice-side')){
            openEl.querySelector('.slice-side').appendChild(cluster)
            openListeners.forEach(fn => fn(byId(sel), openEl))
        }
        const r = byId(sel)
        if(r){
            const root = document.documentElement.style
            root.setProperty('--acc', r.accent.base)
            root.setProperty('--acc-deep', r.accent.deep)
            root.setProperty('--acc-text', r.accent.text)
            root.setProperty('--play-bg', r.playBg)
        }
        renderLaunch()
        scheduleCycle()
    }

    /** While a game is busy: the line down the right edge that says the folded releases come back when it closes. */
    function renderWaiting(focus){
        if(focus){
            const others = releases.filter(r => r.id !== picked())
            const covers = [...shelf.filter(id => id !== picked()), ...others.map(r => r.id).filter(id => !shelf.includes(id))].slice(0, 3)
            waiting.querySelector('.waiting-covers').innerHTML = covers.map(id => `<img src="${escapeHtml(coverFor(id))}" alt="">`).join('')
            waiting.querySelector('.waiting-title').textContent = Lang.queryJS(others.length === 1 ? 'slices.waitingOne' : 'slices.waitingMany', { count: others.length })
            waiting.querySelector('.waiting-sub').textContent = Lang.queryJS('slices.waitingSub')
        }
        waiting.classList.toggle('on', focus && releases.length > 1)
    }

    function scheduleCycle(){
        clearTimeout(cycleTimer)
        const id = picked()
        const c = cycles.get(id)
        if(!c || mode !== 'play') return
        cycleTimer = setTimeout(() => {
            const el = nodes.get(id)
            if(el) paintFrame(el, c.advance(), false)
            scheduleCycle()
        }, CYCLE_MS)
    }

    /* Picking */

    async function pick(id){
        if(id === picked()) return
        // While a game runs the selection stays put, in the settings band too: the open slice
        // belongs to the release that is running.
        if(busy()) return nudge(id)
        const serv = (await DistroAPI.getDistribution()).getServerById(id)
        updateSelectedServer(serv)
    }

    /*
     * Hover only follows the mouse. A switch slides the slices under a still pointer (the wheel
     * leaves it where it is), and Chromium then reports the slice that arrives under it as entered:
     * growing that one took width from the opening slice just before it was fully revealed.
     */
    let pointer = null
    let lastPointer = null
    document.addEventListener('mousemove', e => { lastPointer = pointer; pointer = `${e.screenX},${e.screenY}` }, true)
    function hoverTag(e, id){
        const at = `${e.screenX},${e.screenY}`
        // mouseenter comes before the move it belongs to, mousemove after it was recorded
        const before = e.type === 'mousemove' ? lastPointer : pointer
        if(at === before || hover === id) return
        hover = id
        update()
    }

    /** From the library: the release joins the front of the shelf and wipes in. */
    async function libraryPick(id){
        if(busy() && mode === 'play') return nudge('lib')
        const fresh = !shelf.includes(id)
        shelf = shelfAfterPick(shelf, id, SHELF_MAX)
        localStorage.setItem('ion.shelf.v1', JSON.stringify(shelf))
        build()
        if(fresh){
            const el = nodes.get(id)
            el.classList.add('is-new')
            setTimeout(() => el.classList.remove('is-new'), 1100)
        }
        await pick(id)
    }

    function nudge(target){
        nudged = { id: target, at: Date.now() }
        if(focused()){
            waiting.classList.remove('is-nudged'); void waiting.offsetWidth  // restart the flash
            waiting.classList.add('is-nudged')
            setTimeout(() => waiting.classList.remove('is-nudged'), 950)
        }
        const button = document.getElementById('launch_button')
        button.classList.remove('nudged'); void button.offsetWidth; button.classList.add('nudged')
        update()
        clearTimeout(nudge.timer)
        nudge.timer = setTimeout(() => { nudged = null; update() }, 2600)
    }

    /** A slice's flex-grow in the Play view when nothing is hovered. */
    function restingGrow(id, open){
        if(open) return 9
        return byId(id)?.net ? 1.3 : 1
    }

    /**
     * Each slice's width when it is the open one and nothing is hovered, for its content
     * (slices.css: .slice-open). Worked out from the grows rather than measured, because that width
     * depends on which slice is open (the network release's strip is wider than the others): during
     * a switch the opening slice's title, panel and Play button already have their final width and
     * neither reflow on every frame nor jump when the animation ends.
     */
    function setOpenWidths(){
        if(mode !== 'play') return
        const ids = [...nodes.keys()]
        const css = getComputedStyle(stage)
        if(focused()){
            // Folded: the running release takes the whole view.
            const full = stage.parentElement.clientWidth
            if(full > 0) nodes.get(picked())?.style.setProperty('--open-w', `${full}px`)
            return
        }
        const strip = libStrip.hidden ? 0 : LIB_STRIP_W
        const gaps = parseFloat(css.columnGap || 0) * (libStrip.hidden ? ids.length - 1 : ids.length)
        // The stage's Play width (it animates there from the settings band)
        const free = stage.parentElement.clientWidth - strip - gaps
        if(free <= 0) return  // the Play view is hidden; measured again on the next update or resize
        for(const id of ids){
            // Flex layout with the slices' min-width: strips that would get less are frozen at it.
            const frozen = new Set()
            let room, total
            for(;;){
                room = free - frozen.size * SLICE_MIN_W
                total = ids.filter(o => !frozen.has(o)).reduce((t, o) => t + restingGrow(o, o === id), 0)
                const tight = ids.filter(o => o !== id && !frozen.has(o) && room * restingGrow(o, false) / total < SLICE_MIN_W)
                if(!tight.length) break
                tight.forEach(o => frozen.add(o))
            }
            nodes.get(id).style.setProperty('--open-w', `${room * restingGrow(id, true) / total}px`)
        }
    }
    stage.addEventListener('transitionend', e => {
        // Also catches the first layout after the Play view was hidden
        if(e.propertyName === 'flex-grow') setOpenWidths()
    })
    // The window resizing, and the friends strip giving its column back or taking it (friends.js)
    new ResizeObserver(() => requestAnimationFrame(setOpenWidths)).observe(stage.parentElement)

    stage.addEventListener('wheel', e => {
        if(Math.abs(e.deltaY) < 8 || mode !== 'play') return
        // One step per switch: a step taken while the last one is still opening turns that slice
        // round before it is fully revealed.
        const now = Date.now()
        if(now - (stage.lastWheel || 0) < SWITCH_MS + 50) return
        stage.lastWheel = now
        const at = shelf.indexOf(picked())
        const next = Math.max(0, Math.min(shelf.length - 1, at + (e.deltaY > 0 ? 1 : -1)))
        if(next === at) return
        hover = null
        pick(shelf[next])
    }, { passive: true })

    libStrip.addEventListener('mouseenter', () => { hover = 'lib'; update() })
    libStrip.addEventListener('mouseleave', () => { hover = null; update() })
    libStrip.addEventListener('click', () => {
        if(mode !== 'play') return
        if(busy()) return nudge('lib')
        if(typeof Library !== 'undefined') Library.open()
    })

    /* Play button */

    function renderLaunch(){
        const r = byId(picked())
        const s = GameState.state
        const lit = s === 'preparing' ? Math.round(81 * percent / 100) : 81
        const button = document.getElementById('launch_button')
        button.querySelector('.dots-lit').setAttribute('d', DOTS.slice(0, lit).join(''))
        button.querySelector('.dots-dim').setAttribute('d', DOTS.slice(lit).join(''))
        button.querySelector('.play-fill').style.width = s === 'preparing' ? `${percent}%` : '0%'
        button.querySelector('.launch-star').setAttribute('class', `launch-star ${s === 'starting' ? 'pulse' : s === 'running' ? 'spin' : ''}`)
        button.classList.toggle('is-running', s === 'running')
        button.classList.toggle('is-busy', s !== 'idle')
        button.disabled = s !== 'idle' || !r
        const label = button.querySelector('.launch-label')
        label.textContent = s === 'idle' ? Lang.queryJS('slices.play')
            : s === 'preparing' ? `${Math.floor(percent)}%`
                : s === 'starting' ? Lang.queryJS('slices.starting') : Lang.queryJS('slices.inGame')
        label.classList.toggle('is-word', s === 'idle')
        const cap = document.getElementById('launch_caption')
        const nudgedNow = nudged && Date.now() - nudged.at < 2600
        cap.textContent = nudgedNow
            ? Lang.queryJS(s === 'running' ? 'slices.closeToSwitch' : 'slices.switchAfter')
            : Lang.queryJS(`slices.caption.${s}`)
        cap.classList.toggle('cap-flash', !!nudgedNow)
        document.getElementById('launch_side').textContent = s === 'idle' ? (r?.net ? Lang.queryJS('slices.joinLobby') : (r?.version ?? '')) : ''
        // Only once the process exists; while preparing there is nothing to kill yet.
        const kill = document.getElementById('launch_kill')
        kill.hidden = s !== 'starting' && s !== 'running'
        kill.textContent = Lang.queryJS('slices.forceClose')
    }

    GameState.subscribe(() => { percent = 0; update() })

    /* Announcements */

    function openAnnouncement(r){
        if(!r) return
        if(r.net){
            const newest = window.ionNewestArticle
            showTab('news', newest ? `/blog/${encodeURIComponent(newest.slug)}` : undefined)
        } else if(r.announcement?.url && /^https?:\/\//.test(r.announcement.url)){
            // A pack's announcement may link anywhere; it opens in the browser, not in a web tab.
            shell.openExternal(r.announcement.url)
        }
    }

    /* Public */

    ipcRenderer.invoke('wallpapers:list').then(l => { walls = l; syncCycles() }).catch(() => {})
    ipcRenderer.on('wallpapers:changed', (_e, l) => { walls = l; syncCycles() })
    setTimeout(() => { intro = false; update() }, 450)
    loadReleases().catch(err => log.error('Could not build the Play view.', err))

    return {
        load: loadReleases,
        update,
        /** Re-fill every slice, e.g. after the blog feed brought a new newest post. */
        refill: build,
        libraryPick,
        releases: () => releases,
        shelf: () => shelf,
        byId,
        wallsFor,
        coverFor,
        setMode(next){
            mode = next; hover = null
            if(mode !== 'play' && typeof Library !== 'undefined' && document.getElementById('library').classList.contains('is-open')) Library.close()
            update()
        },
        setPercent(p){ percent = Math.max(0, Math.min(100, p)); renderLaunch() },
        onOpen(fn){ openListeners.push(fn) },
        nudge
    }
})()
