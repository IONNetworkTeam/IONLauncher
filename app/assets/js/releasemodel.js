/**
 * What the Play view draws for each release: the distribution decides which releases exist and
 * how they launch; the site's presentation (kind, colours, announcement, map) only dresses them.
 *
 * @module releasemodel
 */

/** The launcher's own colours, for a release the site says nothing about. */
const HOUSE = { base: '#7777DF', deep: '#6565B8', text: '#B7B5FC' }
/** The ION Network's signal, for game servers without colours of their own. */
const NETWORK = { base: '#6E8CF0', deep: '#4F6EE0', text: '#A9B9FA' }
const SIGNAL_PLAY = 'linear-gradient(100deg, #1E9CCB 0%, #4F6EE0 52%, #7150CF 100%)'

/** 'VelonaSMP 2025' → ['VelonaSMP', '2025']; a trailing number is set apart, anything else is not. */
function splitTitle(name){
    const m = /^(.*\S)\s+(\d{1,4})$/.exec(String(name || '').trim())
    return m ? [m[1], m[2]] : [String(name || '').trim(), '']
}

/**
 * @param {{id:string,name:string,description?:string,minecraftVersion:string,address?:string,mainServer?:boolean}[]} servers
 * @param {{id:string,kind:string,accent:?object,mapUrl:?string,announcement:?object}[]} presentation
 */
function mergeReleases(servers, presentation){
    const byId = new Map((presentation || []).map(p => [p.id, p]))
    return servers.map(s => {
        const p = byId.get(s.id) || {}
        const net = p.kind === 'gameserver'
        const accent = p.accent || (net ? NETWORK : HOUSE)
        const [title, edition] = splitTitle(s.name)
        return {
            id: s.id,
            name: s.name,
            title,
            edition,
            desc: s.description || '',
            version: s.minecraftVersion,
            address: s.address || '',
            main: !!s.mainServer,
            net,
            kind: net ? 'gameserver' : 'modpack',
            accent,
            // Every game server plays on the network's signal; a modpack on its own deep shade.
            playBg: net ? SIGNAL_PLAY : accent.deep,
            mapUrl: p.mapUrl || null,
            announcement: p.announcement || null
        }
    })
}

const HEX = /^#[0-9A-Fa-f]{6}$/
const httpUrl = v => {
    if(typeof v !== 'string') return null
    try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? v : null } catch { return null }
}

/**
 * The site's presentation, reduced to what the Play view may use. It reaches innerHTML and
 * attributes in a renderer with node access, and it is cached across starts, so anything that is
 * not exactly the expected shape is dropped here, once, on the way in.
 */
function sanitizePresentation(list){
    if(!Array.isArray(list)) return []
    return list.filter(p => p && typeof p === 'object' && typeof p.id === 'string').map(p => {
        const a = p.accent
        const accent = a && HEX.test(a.base) && HEX.test(a.deep) && HEX.test(a.text) ? { base: a.base, deep: a.deep, text: a.text } : null
        const n = p.announcement
        const announcement = n && typeof n.text === 'string' && n.text.trim()
            ? { text: n.text.trim(), date: typeof n.date === 'string' ? n.date : null, url: httpUrl(n.url) }
            : null
        return { id: p.id, kind: p.kind === 'gameserver' ? 'gameserver' : 'modpack', accent, mapUrl: httpUrl(p.mapUrl), announcement }
    })
}

/** The shelf after a release is picked: it moves to the front unless it is already on the shelf. */
function shelfAfterPick(shelf, id, max = 4){
    if(shelf.includes(id)) return shelf.slice()
    return [id].concat(shelf).slice(0, max)
}

/**
 * The shelf to start with: the saved one, minus releases that no longer exist, topped up with the
 * main release and then the rest in distribution order.
 */
function initialShelf(saved, ids, mainId, max = 4){
    const out = (Array.isArray(saved) ? saved : []).filter(id => ids.includes(id))
    for(const id of [mainId].concat(ids)){
        if(out.length >= max) break
        if(id && !out.includes(id)) out.push(id)
    }
    return out.slice(0, max)
}

module.exports = { HOUSE, NETWORK, SIGNAL_PLAY, splitTitle, mergeReleases, sanitizePresentation, shelfAfterPick, initialShelf }
