/**
 * The presence heartbeat: what this launcher is doing, told to the website every 30 seconds and
 * at once when it changes.
 *
 *   idle     the launcher is open, with the picked release
 *   playing  the game runs, with the launched release, from process start to exit
 *   gone     the launcher is closing (best effort; the server forgets a silent launcher after 90 s)
 *
 * On the network the proxy's own view of the player wins over whatever the launcher says; the
 * heartbeat is what makes "in the launcher" and modpack presence possible.
 *
 * @module friends/presence
 */
const INTERVAL_MS = 30000

const silent = { info(){}, warn(){}, error(){} }

/**
 * @param {Object} deps
 * @param {(presence: {state: string, release?: string}) => Promise<{ok: boolean, code?: string}>} deps.put PUT …/me/presence (api.js).
 * @param {number} [deps.intervalMs]
 * @param {Function} [deps.setInterval]
 * @param {Function} [deps.clearInterval]
 * @param {Object} [deps.logger]
 */
function createPresence({ put, intervalMs = INTERVAL_MS, setInterval: every = setInterval, clearInterval: stopEvery = clearInterval, logger = silent }){
    let state = 'idle'
    let release = null
    let timer = null
    let running = false
    let inflight = null

    function payload(){
        const p = { state }
        if(release) p.release = release
        return p
    }

    /** One beat; failures are logged once and never retried in a loop: the next beat is 30 s away. */
    function beat(){
        if(!running || inflight) return inflight ?? Promise.resolve()
        inflight = put(payload()).then(res => {
            if(!res.ok && res.code !== 'UNAVAILABLE' && res.code !== 'OFFLINE' && res.code !== 'NO_SESSION') logger.warn(`Presence heartbeat refused (${res.code ?? res.status}).`)
            return res
        }).catch(err => {
            logger.warn('Presence heartbeat failed.', err)
        }).finally(() => { inflight = null })
        return inflight
    }

    function start(){
        if(running) return
        running = true
        beat()
        timer = every(beat, intervalMs)
    }

    function stop(){
        running = false
        if(timer != null) stopEvery(timer)
        timer = null
    }

    /**
     * What the launcher is doing. A change is sent at once (the interval is kept, the next beat
     * follows in its own time); the same state again is not.
     */
    function set(nextState, nextRelease = release){
        const changed = nextState !== state || (nextRelease ?? null) !== release
        state = nextState
        release = nextRelease ?? null
        if(changed && running) beat()
    }

    /** Best effort on quit: whatever is in flight is not waited for. */
    function gone(){
        stop()
        return put({ state: 'gone' }).catch(() => {})
    }

    return {
        start,
        stop,
        set,
        gone,
        get state(){ return state },
        get release(){ return release },
        get running(){ return running }
    }
}

module.exports = { createPresence, INTERVAL_MS }
