/**
 * The order the wallpapers of one release are shown in.
 *
 * The set can change while it is being shown: a background sync may add pictures or retire
 * them. A new picture joins at the end. A retired picture leaves at once unless it is the one on
 * screen, which stays until its turn is over (the slideshow then moves on to whatever followed it).
 *
 * @module wallcycle
 */
class WallCycle {

    /**
     * @param {string[]} ids The pictures, in order.
     * @param {number} start Index of the first picture to show.
     */
    constructor(ids, start = 0){
        this.order = ids.slice()
        this.index = this.order.length ? Math.min(Math.max(start, 0), this.order.length - 1) : -1
        // Set while the on-screen picture has been retired: shown, but no longer in the order.
        this.lingering = null
        // Where the order resumes after a lingering picture.
        this.resumeAt = 0
    }

    /** @returns {string|null} The picture on screen. */
    get current(){
        if(this.lingering != null) return this.lingering
        return this.index >= 0 ? this.order[this.index] : null
    }

    /** @returns {string|null} The next picture, which is now on screen. */
    advance(){
        if(this.lingering != null){
            this.lingering = null
            this.index = this.order.length ? this.resumeAt % this.order.length : -1
            return this.current
        }
        if(!this.order.length) return null
        this.index = (this.index + 1) % this.order.length
        return this.current
    }

    /** @param {string[]} ids The set as it is now. */
    update(ids){
        const shown = this.current
        const old = this.order
        const kept = old.filter(id => ids.includes(id))
        const added = ids.filter(id => !old.includes(id))
        this.order = kept.concat(added)

        if(shown == null){
            this.index = this.order.length ? 0 : -1
            return
        }
        if(this.order.includes(shown)){
            this.lingering = null
            this.index = this.order.indexOf(shown)
            return
        }
        // The on-screen picture was retired: keep it up, and resume with the first survivor after it.
        const from = this.lingering != null ? -1 : old.indexOf(shown)
        const after = old.slice(from + 1).find(id => this.order.includes(id))
        this.lingering = shown
        this.resumeAt = after != null ? this.order.indexOf(after) : 0
        this.index = -1
    }
}

module.exports = { WallCycle }
