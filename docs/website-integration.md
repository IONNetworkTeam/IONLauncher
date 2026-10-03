# Website integration

The launcher can show a community website in its **Challenges**, **Stats** and **News** tabs. The
tabs are `<webview>`s on a persistent session, so a user who signs in on the website stays signed in
across restarts. The **Play** tab is drawn by the launcher and reads a small feed from the same site.

This document describes what a website has to provide. Everything is optional: a site that
implements none of it still works in the tabs, it just looks like a browser page.

## Configuration

Set the website's address in `app/assets/lang/_custom.toml`:

```toml
[js.web]
url = "https://example.com"
```

For development, the `ION_WEB_URL` environment variable overrides it:

```console
> ION_WEB_URL=http://localhost:5173 npm start
```

Each tab opens a fixed path on the site:

| Tab        | Path                                                               |
| ---------- | ------------------------------------------------------------------ |
| Challenges | `/challenges`                                                      |
| Stats      | `/stats/<player>`, with the selected Minecraft account's name      |
| News       | `/blog`                                                            |

## Recognising the launcher

The web tabs append `IONLauncher/<version>` to the user agent, for example:

```
Mozilla/5.0 (X11; Linux x86_64) … Electron/39.2.7 Safari/537.36 IONLauncher/2.2.4
```

A site can use this to render a launcher view: no site header or footer (the launcher's window
provides the chrome), less top spacing, and a compact navigation for the section. If the same URL
renders differently for the launcher, send `Vary: User-Agent` so caches keep the two apart.

## The bridge

Pages in the web tabs get `window.ionLauncher`. Both calls are fire-and-forget, and the launcher
ignores messages from any origin other than the configured website.

```ts
interface IonLauncher {
	/** The launcher's version, from the user agent. */
	version: string | null;

	/** Who is signed in on the site. Call it whenever any of this changes. */
	report(state: {
		loggedIn: boolean;
		username: string | null;
		minecraftName: string | null;
		minecraftUuid: string | null;
		/** The user's coin balance, shown in the title bar and on the Play tab. */
		balance: number | null;
		path: string;
	}): void;

	/** Show a notification in the launcher, whichever tab is open. `href` is a path on the site. */
	toast(note: { text: string; href: string }): void;
}
```

Check for the bridge before using it, so the same code runs in a normal browser:

```js
window.ionLauncher?.report({ loggedIn: false, username: null, minecraftName: null, minecraftUuid: null, balance: null, path: location.pathname })
```

## The Play tab feed

The Play tab requests `GET /api/launcher/feed` and expects:

```json
{
	"articles": [
		{
			"title": "Patch notes",
			"slug": "patch-notes",
			"description": "What changed this week.",
			"cover": "https://example.com/uploads/cover.jpg",
			"publishedAt": "2026-10-01T12:00:00.000Z"
		}
	],
	"server": { "online": true, "players": 12, "maxPlayers": 100 }
}
```

The launcher shows up to three articles. Clicking one opens `/blog/<slug>` in the News tab. A 404
is treated as "this site has no feed yet", and the card links to the blog instead. The request is
made by the main process, so the endpoint does not need CORS headers.

## Navigation

The web tabs only load the configured site, the sign-in providers listed in `SIGN_IN_HOSTS`
(`index.js`), and other hosts under the site's domain (such as an API on a subdomain). Any other
link, and every new window, opens in the system browser.

## HTTP basic authentication

A site that is not public yet can sit behind HTTP basic auth. The launcher asks for the username
and password once, checks them against `/api/launcher/feed`, and answers the challenges from every
tab with them. If the user ticks *Remember on this computer*, they are stored encrypted with
Electron's `safeStorage` in `web-auth.bin` in the launcher's data folder. `ION_WEB_AUTH=user:password`
provides them for development.
