/**
 * Script for welcome.ejs
 */
document.getElementById('welcomeButton').addEventListener('click', e => {
    loginOptionsCancelEnabled(false) // False by default, be explicit.
    loginOptionsViewOnLoginSuccess = VIEWS.ionAccount
    loginOptionsViewOnLoginCancel = VIEWS.loginOptions
    switchView(VIEWS.welcome, VIEWS.loginOptions)
})