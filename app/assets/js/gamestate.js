/**
 * Whether a game is on its way or running, which the Play view needs to lock the other releases.
 * Helios never tracked this: the launch button simply came back after the loading screen.
 *
 *   idle → preparing (files, Java) → starting (process spawned) → running (window up) → idle (exit)
 *
 * Any failure returns to idle.
 *
 * @module gamestate
 */
function createGameState(){
    let state = 'idle'
    let releaseId = null
    const listeners = new Set()

    function set(next, id = releaseId){
        if(next === state && id === releaseId) return
        state = next
        releaseId = next === 'idle' ? null : id
        for(const fn of listeners) fn(state, releaseId)
    }

    return {
        get state(){ return state },
        get releaseId(){ return releaseId },
        /** True when the user may pick another release. */
        canSwitch(){ return state === 'idle' },
        begin(id){ if(state === 'idle') set('preparing', id) },
        spawned(){ if(state === 'preparing') set('starting') },
        windowUp(){ if(state === 'starting') set('running') },
        exited(){ set('idle') },
        failed(){ set('idle') },
        subscribe(fn){ listeners.add(fn); return () => listeners.delete(fn) }
    }
}

module.exports = { createGameState }
