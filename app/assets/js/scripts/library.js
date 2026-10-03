/**
 * All releases: a grid that wipes in from the library strip. Game servers come first, wide.
 */
/* global Slices, Lang, escapeHtml */
const Library = (() => {
    const root = document.getElementById('library')
    const grid = root.querySelector('.lib-body')
    const search = root.querySelector('.lib-search input')
    let filter = 'all'
    let closing = null

    const t = (k, p) => escapeHtml(Lang.queryJS(`library.${k}`, p))

    function card(r, n){
        const picked = r.id === ConfigManager.getSelectedServer()
        const onShelf = Slices.shelf().includes(r.id)
        const wall = Slices.coverFor(r.id)
        const num = String(Slices.releases().indexOf(r) + 1).padStart(2, '0')
        return `<button class="card${r.net ? ' feat' : ''}" data-pick="${escapeHtml(r.id)}" style="animation-delay:${(0.12 + n * 0.045).toFixed(3)}s;--acc:${r.accent.base};--acc-text:${r.accent.text}">
            <span class="card-img${picked ? ' is-picked' : ''}">
                <img src="${escapeHtml(wall)}" alt="">
                ${r.net ? '<span class="net-edge"></span>' : ''}
                <span class="card-shade"></span>
                <span class="mono card-num">${r.net ? '<img src="assets/images/ion/star.svg" alt="">' : ''}${num}</span>
                ${picked || onShelf ? `<span class="mono card-badge">${t(picked ? 'selected' : 'onShelf')}</span>` : ''}
            </span>
            <span class="card-text"><span class="card-name">${escapeHtml(r.name)}</span><span class="mono card-meta">${escapeHtml(r.version)} · ${t(r.net ? 'kindGameServer' : 'kindModpack')}</span></span>
        </button>`
    }

    function render(){
        const q = search.value.trim().toLowerCase()
        const items = Slices.releases().filter(r =>
            (filter === 'all' || (filter === 'gameserver' ? r.net : !r.net)) &&
            (!q || r.name.toLowerCase().includes(q) || r.version.includes(q)))
        const net = items.filter(r => r.net)
        const other = items.filter(r => !r.net)
        let n = 0
        const section = (title, list) => list.length
            ? `<p class="mono lib-h">${title}<i></i></p><div class="lib-grid">${list.map(r => card(r, n++)).join('')}</div>`
            : ''
        grid.innerHTML = items.length
            ? section(`<img src="assets/images/ion/star.svg" alt="">${t('networkHeading')}`, net) + section(t('otherHeading'), other)
            : `<p class="lib-empty">${t('noMatch', { q: search.value })}</p>`
        root.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)))
        root.querySelector('.lib-count').textContent = String(Slices.releases().length).padStart(2, '0')
    }

    function open(){
        clearTimeout(closing)
        render()
        root.classList.add('is-open')
        root.setAttribute('aria-hidden', 'false')
        search.focus()
    }

    function close(){
        root.classList.remove('is-open')
        root.setAttribute('aria-hidden', 'true')
        closing = setTimeout(() => { search.value = ''; grid.innerHTML = '' }, 850)
    }

    root.addEventListener('click', e => {
        const pick = e.target.closest('[data-pick]')
        if(pick){ close(); Slices.libraryPick(pick.dataset.pick); return }
        const f = e.target.closest('[data-filter]')
        if(f){ filter = f.dataset.filter; render(); return }
        if(e.target.closest('[data-close]')) close()
    })
    search.addEventListener('input', render)
    document.addEventListener('keydown', e => { if(e.key === 'Escape' && root.classList.contains('is-open')) close() })

    return { open, close }
})()
