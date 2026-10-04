/**
 * The backdrop behind the sign-in views (welcome, login options, login, waiting, ION account): a panel for the
 * view's text and the bundled wallpapers as slices beside it, opening one after another like the
 * Play view. uibinder.js reports every view change through Onboarding.setView.
 */
/* global VIEWS, IonAccount */
const Onboarding = (() => {
    const WALLS = [5, 3, 7, 2, 6, 4].map(n => `assets/images/backgrounds/${n}.jpg`)
    const CYCLE_MS = 6500
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const slicesEl = document.getElementById('onboardSlices')
    const slices = WALLS.map((src, i) => {
        const slice = document.createElement('div')
        slice.className = 'ob-slice'
        slice.style.setProperty('--i', WALLS.length - 1 - i)
        const img = document.createElement('img')
        img.src = src
        img.alt = ''
        img.decoding = 'async'
        slice.appendChild(img)
        slicesEl.appendChild(slice)
        return slice
    })

    let open = 1
    let timer = null
    let entered = false
    slices[open].classList.add('is-open')

    function step(){
        slices[open].classList.remove('is-open')
        open = (open + 1) % slices.length
        slices[open].classList.add('is-open')
    }

    function setView(view){
        const on = [VIEWS.welcome, VIEWS.loginOptions, VIEWS.login, VIEWS.waiting, VIEWS.ionAccount].includes(view)
        if(view === VIEWS.ionAccount) IonAccount.show()
        document.body.toggleAttribute('data-onboarding', on)
        if(on && !entered){
            entered = true
            slicesEl.classList.add('is-in')
        }
        if(on && !timer && !reducedMotion){
            timer = setInterval(step, CYCLE_MS)
        } else if(!on && timer){
            clearInterval(timer)
            timer = null
        }
    }

    return { setView }
})()
