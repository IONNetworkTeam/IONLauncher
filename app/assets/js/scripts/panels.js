/**
 * The info panel of the open slice, above the Play button, and the gamemode tiles under a game
 * server's name. Live numbers come from the site (`/api/launcher/live`), who is online from a
 * server-list ping, and the rest from this machine.
 */
/* global ConfigManager, DistroAPI, ipcRenderer, Lang, LoggerUtil, escapeHtml, getServerStatus, Slices, GameState, TitleBar, showTab */
const fsp = require('fs/promises')
const pathMod = require('path')
const { playtime, since, size, count } = require('./assets/js/panelformat')

const Panels = (() => {
    const log = LoggerUtil.getLogger('Panels')
    const LIVE_MS = 60000
    const MODES = [
        { id: 'bowbash', name: 'Bowbash', accent: '#7777DF' },
        { id: 'crystalhunt', name: 'CrystalHunt', accent: '#BC5DAA' },
        { id: 'bedwars', name: 'Bedwars', accent: '#D25862' },
        { id: 'piratecraft', name: 'PirateCraft', accent: '#AF7A03' },
        { id: 'ionjumps', name: 'IONJumps', accent: '#559A33' }
    ]
    const modeIcon = id => `assets/images/modes/${id}.svg`
    const live = new Map()      // release id → last /live answer
    const pings = new Map()     // release id → { online, max, sample }
    const sizes = new Map()     // release id → bytes
    let timer = null
    let current = null          // { r, el }

    const t = (k, p) => escapeHtml(Lang.queryJS(`panels.${k}`, p))
    const host = r => (r.address || '').split(':')[0].toUpperCase()

    function heads(ping){
        const shown = (Array.isArray(ping?.sample) ? ping.sample : []).filter(p => typeof p?.id === 'string' && typeof p?.name === 'string').slice(0, 6)
        // "+n" only beside heads: alone it would just repeat the count next to it.
        const more = shown.length ? (Number(ping?.online) || 0) - shown.length : 0
        return `<span class="heads">${shown.map(p => `<img class="hd" src="https://mc-heads.net/avatar/${encodeURIComponent(p.id)}/30" alt="" title="${escapeHtml(p.name)}">`).join('')}${more > 0 ? `<span class="mono heads-more">+${more}</span>` : ''}</span>`
    }

    function netPanel(r){
        const l = live.get(r.id)
        const net = l?.network
        const you = l?.you
        const top = you?.topMode ? MODES.find(m => m.name === you.topMode) : null
        const rows = (l?.challenges?.today || []).filter(c => MODES.some(m => m.id === c.game) && Number.isFinite(Number(c.multiplier))).slice(0, 2).map(c => `
            <button class="ch-row" data-tab-link="challenges">
                <img src="${modeIcon(c.game)}" alt="">
                <span class="ch-text"><span class="ch-name">${escapeHtml(c.name)}</span><span class="mono ch-meta">${escapeHtml((MODES.find(m => m.id === c.game)?.name ?? c.game).toUpperCase())}</span></span>
                <span class="mono ch-mult">×${Number(c.multiplier).toFixed(1)}</span>
            </button>`).join('')
        return `<div class="netpanel">
            <div class="np-h"><span class="live"></span><span>${t('network')}</span><i></i><span>${escapeHtml(host(r))}</span></div>
            <div class="np-count"><span class="mono np-big">${count(net?.players ?? pings.get(r.id)?.online)}</span><span class="np-unit">${t('online')}</span>${heads(pings.get(r.id))}</div>
            <div class="np-h np-gap"><span>${t('youOnNetwork')}</span><i></i></div>
            <div class="hist">
                <div><b>${playtime(you?.playtimeSeconds)}</b><span>${t('played')}</span></div>
                <div><b>${count(you?.games)}</b><span>${t('games')}</span></div>
                <div><b class="hist-mode">${top ? `<img src="${modeIcon(top.id)}" alt="">` : ''}${escapeHtml(you?.topMode ?? '—')}</b><span>${t('mostPlayed')}</span></div>
            </div>
            ${rows ? `<div class="np-h np-gap"><span>${t('todaysChallenges')}</span><i></i></div>${rows}` : ''}
            <div class="np-foot"><span class="mono">${l?.challenges ? t('openChallenges', { n: count(l.challenges.open) }) : ''}</span><button data-tab-link="challenges" class="np-link">${t('allChallenges')}</button></div>
        </div>`
    }

    function packPanel(r){
        const l = live.get(r.id)
        const ping = pings.get(r.id)
        const STATES = ['running', 'starting', 'stopping', 'restarting', 'offline', 'unknown']
        // Without the panel's word on it, a server that answered the ping is plainly online.
        const state = STATES.includes(l?.state) && l.state !== 'unknown' ? l.state : ping ? 'running' : 'unknown'
        const shown = ping && ping.online > 0
        return `<div class="netpanel">
            <div class="np-h"><span class="live state-${state}"></span><span>${t(`state.${state}`)}</span><i></i><span>${escapeHtml(host(r))}</span></div>
            <div class="np-count"><span class="mono np-big">${count(ping?.online)}</span><span class="mono np-unit">/ ${count(ping?.max)}</span>${shown ? heads(ping) : ''}</div>
            ${ping && ping.online === 0 ? `<p class="np-note">${t('nobody')}</p>` : ''}
            <div class="np-h np-gap"><span>${t('youHere')}</span><i></i></div>
            <div class="hist">
                <div><b>${playtime(l?.you?.playtimeSeconds)}</b><span>${t('playedOnServer')}</span></div>
                <div><b>${since(localStorage.getItem(`ion.lastPlayed.${r.id}`))}</b><span>${t('lastSession')}</span></div>
                <div><b>${size(sizes.get(r.id))}</b><span>${t('installed')}</span></div>
            </div>
            ${r.mapUrl ? `<button class="mapbtn" data-map="${escapeHtml(r.mapUrl)}"><span class="mapbtn-l"><span class="mapthumb"><img src="${escapeHtml(Slices.coverFor(r.id))}" alt=""></span>${t('openMap')}</span><span class="np-link">→</span></button>` : ''}
        </div>`
    }

    function modeTiles(r){
        if(!r.net) return ''
        return `<div class="modes" style="--n:${MODES.length}">${MODES.map(m => `
            <button class="mode" data-tab-link="challenges" aria-label="${escapeHtml(m.name)}">
                <img src="${modeIcon(m.id)}" alt=""><span>${escapeHtml(m.name)}</span><span class="mode-bar" style="background:${m.accent}"></span>
            </button>`).join('')}</div>`
    }

    function render(){
        if(!current) return
        const { r, el } = current
        el.querySelector('.slice-panel').innerHTML = r.net ? netPanel(r) : packPanel(r)
        el.querySelector('.slice-extra').innerHTML = modeTiles(r)
    }

    async function refresh(){
        if(!current) return
        const r = current.r
        const player = ConfigManager.getSelectedAccount()?.uuid
        const q = new URLSearchParams({ release: r.id })
        if(player) q.set('player', player)
        const [res] = await Promise.allSettled([
            ipcRenderer.invoke('web:fetchJson', `/api/launcher/live?${q}`),
            ping(r)
        ])
        if(res.status === 'fulfilled' && res.value.ok) live.set(r.id, res.value.data)
        if(current?.r.id === r.id) render()
    }

    async function ping(r){
        try {
            const serv = (await DistroAPI.getDistribution()).getServerById(r.id)
            const s = await getServerStatus(47, serv.hostname, serv.port)
            pings.set(r.id, { online: s.players.online, max: s.players.max, sample: s.players.sample || [] })
        } catch(err) {
            pings.delete(r.id)
            log.debug(`Ping of ${r.id} failed.`, err)
        }
    }

    async function dirSize(dir){
        let total = 0
        let entries = []
        try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return 0 }
        for(const e of entries){
            const p = pathMod.join(dir, e.name)
            if(e.isDirectory()) total += await dirSize(p)
            else if(e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size
        }
        return total
    }

    function open(r, el){
        current = { r, el }
        render()
        refresh()
        if(!r.net && !sizes.has(r.id)){
            dirSize(pathMod.join(ConfigManager.getInstanceDirectory(), r.id)).then(b => { sizes.set(r.id, b); if(current?.r.id === r.id) render() })
        }
        clearInterval(timer)
        timer = setInterval(refresh, LIVE_MS)
    }

    /**
     * The title bar's Challenges and Stats peeks and the Challenges badge come from the network, so
     * they are read from the first game-server release whichever release is open.
     */
    async function refreshNetwork(){
        const net = Slices.releases().find(r => r.net)
        if(!net || typeof TitleBar === 'undefined') return
        let l = live.get(net.id)
        if(current?.r.id !== net.id){
            const player = ConfigManager.getSelectedAccount()?.uuid
            const q = new URLSearchParams({ release: net.id })
            if(player) q.set('player', player)
            const res = await ipcRenderer.invoke('web:fetchJson', `/api/launcher/live?${q}`).catch(() => null)
            if(res?.ok){ l = res.data; live.set(net.id, l) }
        }
        if(!l) return
        const wall = Slices.wallsFor(net.id)
        const first = l.challenges?.today?.[0]
        TitleBar.setBadge('challenges', l.challenges?.open ? String(l.challenges.open) : '')
        TitleBar.setPeek('challenges', first ? {
            img: wall[0], kicker: Lang.queryJS('panels.peekChallenge'), title: first.name,
            meta: Lang.queryJS('panels.peekChallengeMeta', { mult: first.multiplier.toFixed(1), n: l.challenges.open })
        } : null)
        TitleBar.setPeek('stats', l.you ? {
            img: wall[1] || wall[0], kicker: Lang.queryJS('panels.youOnNetwork'),
            title: Lang.queryJS('panels.peekStats', { time: playtime(l.you.playtimeSeconds), games: l.you.games }),
            meta: l.you.topMode ?? ''
        } : null)
    }
    setTimeout(refreshNetwork, 3000)
    setInterval(refreshNetwork, 5 * LIVE_MS)

    // The last session is this machine's to know: stamp it when a game starts.
    GameState.subscribe((state, id) => { if(state === 'starting' && id) localStorage.setItem(`ion.lastPlayed.${id}`, new Date().toISOString()) })

    document.addEventListener('click', e => {
        const map = e.target.closest('[data-map]')
        if(map && getCurrentView() === VIEWS.landing) showTab('map', map.dataset.map)
    })

    Slices.onOpen(open)

    return { refresh, render, refreshNetwork, modes: MODES }
})()
