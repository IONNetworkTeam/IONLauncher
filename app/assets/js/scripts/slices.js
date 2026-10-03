/**
 * The Play view: every release on the shelf is a full-height slice of its own wallpaper, the
 * selected one open. Also owns the Play button's look and the lock while a game is busy.
 *
 * Loaded after landing.js (GameState, updateSelectedServer, launch functions) and shell.js
 * (showTab). Library and panels hook in through Slices.onOpen / Slices.libraryPick.
 */
/* global ConfigManager, DistroAPI, GameState, updateSelectedServer, ipcRenderer, shell, Lang, LoggerUtil, escapeHtml, showTab, Library */
const { WallCycle } = require('./assets/js/wallcycle')
const { mergeReleases, shelfAfterPick, initialShelf } = require('./assets/js/releasemodel')
const { pathToFileURL } = require('url')

const Slices = (() => {
    const log = LoggerUtil.getLogger('Slices')
    const SHELF_MAX = 4
    const CYCLE_MS = 12000
    const BUNDLED = [5, 3, 7, 2, 6, 4, 0, 1].map(n => `assets/images/backgrounds/${n}.jpg`)
    const STAR_IMG = 'assets/images/ion/star.svg'
    const LOCK_SVG = '<svg class="lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'

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

    let releases = []          // releasemodel view models, distribution order
    let presentation = []      // last /api/launcher/releases answer
    let shelf = []             // release ids, max SHELF_MAX
    let hover = null
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

    /* Data */

    async function loadReleases(){
        const distro = await DistroAPI.getDistribution()
        const servers = distro.servers.map(s => ({
            id: s.rawServer.id, name: s.rawServer.name, description: s.rawServer.description,
            minecraftVersion: s.rawServer.minecraftVersion, address: s.rawServer.address, mainServer: s.rawServer.mainServer
        }))
        try { presentation = JSON.parse(localStorage.getItem('ion.releases.v1')) || [] } catch { presentation = [] }
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
            presentation = res.data.releases
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
        tag.addEventListener('mouseenter', () => { hover = r.id; update() })
        tag.addEventListener('mouseleave', () => { hover = null; update() })
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
        update()
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
        stage.classList.toggle('is-mini', mode === 'settings')
        for(const [id, el] of nodes){
            const r = byId(id)
            const open = id === sel && !intro
            const locked = busy() && mode === 'play' && id !== sel
            let grow = 1
            if(mode === 'settings') grow = id === sel ? 1.4 : 1
            else if(open) grow = 9
            else if(id === hover && !locked) grow = 1.6
            else if(r?.net) grow = 1.3
            el.style.flexGrow = grow
            el.classList.toggle('is-open', open)
            el.classList.toggle('is-locked', locked)
            const tag = el.querySelector('.tag')
            tag.setAttribute('aria-disabled', String(locked))
            tag.setAttribute('aria-current', id === sel ? 'true' : 'false')
            el.querySelector('.tag-name').textContent = nudged?.id === id ? Lang.queryJS('slices.locked') : (r?.name ?? id)
            el.querySelector('.tag-end').innerHTML = locked ? LOCK_SVG : '<span class="tag-dot"></span>'
        }
        libStrip.classList.toggle('is-locked', busy() && mode === 'play')
        libStrip.querySelector('.lib-label-text').textContent = nudged?.id === 'lib' ? Lang.queryJS('slices.locked') : Lang.queryJS('slices.allReleases')

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
        if(busy() && mode === 'play') return nudge(id)
        const serv = (await DistroAPI.getDistribution()).getServerById(id)
        updateSelectedServer(serv)
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
        const el = target === 'lib' ? libStrip : nodes.get(target)
        if(el){
            el.classList.remove('is-wiggle')
            void el.offsetWidth  // restart the animation
            el.classList.add('is-wiggle')
            setTimeout(() => el.classList.remove('is-wiggle'), 600)
        }
        const button = document.getElementById('launch_button')
        button.classList.remove('nudged'); void button.offsetWidth; button.classList.add('nudged')
        update()
        clearTimeout(nudge.timer)
        nudge.timer = setTimeout(() => { nudged = null; update() }, 2600)
    }

    stage.addEventListener('wheel', e => {
        if(Math.abs(e.deltaY) < 8 || mode !== 'play') return
        const now = Date.now()
        if(now - (stage.lastWheel || 0) < 650) return
        stage.lastWheel = now
        const at = shelf.indexOf(picked())
        const next = Math.max(0, Math.min(shelf.length - 1, at + (e.deltaY > 0 ? 1 : -1)))
        if(next !== at) pick(shelf[next])
    }, { passive: true })

    libStrip.addEventListener('click', () => {
        if(busy() && mode === 'play') return nudge('lib')
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
    }

    GameState.subscribe(() => { percent = 0; update() })

    /* Announcements */

    function openAnnouncement(r){
        if(!r) return
        if(r.net){
            const newest = window.ionNewestArticle
            showTab('news', newest ? `/blog/${encodeURIComponent(newest.slug)}` : undefined)
        } else if(r.announcement?.url){
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
        setMode(next){ mode = next; hover = null; update() },
        setPercent(p){ percent = Math.max(0, Math.min(100, p)); renderLaunch() },
        onOpen(fn){ openListeners.push(fn) },
        nudge
    }
})()
