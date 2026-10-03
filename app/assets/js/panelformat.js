/**
 * Numbers set as type in the slice panels: short, unitful, never a long sentence.
 *
 * @module panelformat
 */

/** 3600 → '1 h', 1500 → '25 min', 0 → '0 h', null → '—' */
function playtime(seconds){
    if(seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—'
    if(seconds > 0 && seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
    return `${Math.floor(seconds / 3600)} h`
}

/** How long ago, in one word or two: 'today', 'yesterday', '5 days', '3 weeks', '9 months', '2 years', 'never'. */
function since(iso, now = Date.now()){
    if(!iso) return 'never'
    const t = Date.parse(iso)
    if(!Number.isFinite(t)) return 'never'
    const start = d => new Date(new Date(d).getFullYear(), new Date(d).getMonth(), new Date(d).getDate()).getTime()
    const days = Math.round((start(now) - start(t)) / 86400000)
    if(days <= 0) return 'today'
    if(days === 1) return 'yesterday'
    if(days < 14) return `${days} days`
    if(days < 60) return `${Math.floor(days / 7)} weeks`
    if(days < 730) return `${Math.floor(days / 30)} months`
    return `${Math.floor(days / 365)} years`
}

/** 1.8e9 → '1.8 GB', 512e6 → '512 MB', null → '—' */
function size(bytes){
    if(bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—'
    if(bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
    return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/** A count from the site or a ping: a whole number, or a dash. Never the value as given. */
function count(v){
    if(v == null || v === '') return '—'
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? String(Math.floor(n)) : '—'
}

module.exports = { playtime, since, size, count }
