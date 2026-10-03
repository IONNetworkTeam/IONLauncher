# Mod licensing, manual downloads and GitHub custom mods

Design for a cross-repo feature between **IONLauncherManager** (admin web UI around Nebula),
**IONLauncher** (Helios fork, branch `beta`) and the generated `distribution.json`.
Nebula itself stays an unmodified upstream clone; everything it cannot express is added to
`distribution.json` by the Manager after Nebula has generated it.

## Problem

ION hosts every mod jar of every modpack on its own server (`BASE_URL`). Many mods are
"all rights reserved", carry custom licenses, or (on CurseForge) explicitly forbid third-party
downloads. Rehosting those invites takedown requests. Today nothing records a mod's license,
and nothing stops a non-redistributable jar from being published.

ION also ships its own mods that are not on Modrinth or CurseForge. Today they must be
uploaded by hand on every release.

## Goals

1. Every mod of a server is matched to its Modrinth or CurseForge project. Imports match
   automatically (by hash); whatever is left is matched by the admin through a search UI.
2. The Manager fetches license data and recommends, per mod, how the launcher should obtain it.
3. Admins can override the recommendation per mod, with a note, in an easy review UI.
4. Mods that must not be rehosted are not downloaded from ION. Mods whose authors block
   launcher downloads are downloaded by the player, with one click per mod, like Prism Launcher.
5. "Custom mods": a GitHub repository added in the Manager; the launcher downloads the newest
   release asset at launch and shows the mod clearly as a GitHub mod with a clickable link.

## Download modes

Each mod gets one of three **download modes**. The Manager recommends one; an admin may
override it.

| Mode | Where the launcher downloads from | When recommended |
| --- | --- | --- |
| `hosted` | ION's server (Nebula's URL, unchanged) | Modrinth mod whose SPDX license clearly permits redistribution (MIT, Apache-2.0, BSD, ISC, GPL/LGPL/AGPL, MPL-2.0, EPL, CC0, CC-BY…) |
| `direct` | The platform's CDN (`cdn.modrinth.com`, `edge.forgecdn.net`) or GitHub releases | Modrinth mod with ARR, `LicenseRef-*`, non-commercial or no license; any CurseForge mod that allows third-party downloads (CurseForge publishes no license data); every GitHub custom mod |
| `manual` | The player, from the mod's download page | CurseForge mod with `allowModDistribution === false` (its file has no `downloadUrl`) |

This mirrors Prism Launcher: Modrinth permits launchers to download from its CDN, CurseForge
permits it unless the author opts out, and only the opted-out mods need the player's help.

A mod that is **unmatched** has no mode. It is still hosted (Nebula hosts whatever is in the
tree) but the Manager flags it as "needs review" everywhere: on the Mods tab, on the Licenses
tab, in import results and in distribution-generation warnings. An admin resolves it by matching
it or by overriding it to `hosted` ("we hold the rights", e.g. an in-house mod).

For `direct` and `manual` mods the jar must still exist in the Nebula tree (Nebula needs it to
build the module, and the launcher needs its size and MD5 to validate the player's copy). The
Manager writes `NEBULA_ROOT/meta/ion-private-paths.txt`, one relative path per line, so the
operator can deny those paths in the static file server. This is documented, not automated.

## Data the Manager stores (per server directory)

- `mod-metadata.json` (exists, extended): one entry per tracked jar. New fields:
  `matchedBy` (`hash` | `manual` | `install` | `import`), `license` (`{id, name?, url?}` or
  `null` when the platform has none), `distributionAllowed` (CurseForge flag), `downloadUrl`
  (the exact file's CDN URL, `null` when the platform forbids it), `pageUrl` (page a player
  downloads from: Modrinth version page or CurseForge `/download/<fileId>`), `checkedAt`.
- `mod-policy.json` (new): admin overrides keyed by `modrinth:<projectId>`,
  `curseforge:<modId>` or `file:<filename>` (unmatched jars). Value: `{ mode, note?, reviewedAt }`.
  Keys follow the project, not the file, so overrides survive mod updates.
- `custom-mods.json` (new): GitHub custom mods: `{ id, name, repo: 'owner/repo', category,
  assetPattern | null, prerelease, addedDate, resolved: { tag, assetName, url, size, md5,
  sha256, publishedAt, resolvedAt } | null, resolveError | null }`.

Recommendations are never stored; they are computed from the entry whenever listed, so a
policy change in code applies immediately.

## The `distribution.json` contract (`ion` field)

After `generate distro`, the Manager rewrites `NEBULA_ROOT/distribution.json`. Each
`ForgeMod`/`FabricMod` module that belongs to a tracked jar gains an `ion` object:

```json
"ion": {
  "source": "modrinth" | "curseforge" | "github",
  "download": "hosted" | "direct" | "manual",
  "projectUrl": "https://modrinth.com/mod/sodium",
  "license": { "id": "LGPL-3.0-only", "name": "", "url": "https://..." } | null,
  "manual":  { "pageUrl": "https://www.curseforge.com/minecraft/mc-mods/x/download/123", "fileName": "x-1.0.jar" },
  "github":  { "repo": "IONNetworkTeam/IONMod", "assetPattern": null, "prerelease": false, "tag": "v1.4.0", "sha256": "..." | null }
}
```

`manual` is present only for `download: "manual"`, `github` only for `source: "github"`.

Artifact rules by mode:

- `hosted`: artifact untouched.
- `direct`: `artifact.url` becomes the platform CDN URL. Size and MD5 stay (same file).
- `manual`: `artifact.url` becomes the download **page** URL. Size and MD5 stay so the launcher
  can validate the player's copy. Helios would try to download the page and fail the MD5 check,
  so the launcher must handle these modules before validation.
- GitHub custom mods are appended as new modules with id `ion.github.<owner>:<repo>:<tag>@jar`
  (so Helios' Maven path handling and the per-server mod configuration keyed by the versionless
  id `ion.github.<owner>:<repo>` both work), `artifact.url` = the release asset, `size` from the
  asset, `MD5` computed by the Manager when it resolved the release.

Unknown fields are ignored by helios-core, so older launchers keep working for `hosted` mods.

## Launcher behaviour

Before Helios' `FullRepair` validates and downloads files (it runs in a forked child that
re-reads `distribution.json` from disk), the launcher:

1. **Resolves GitHub mods.** For each `source: "github"` module it asks the GitHub API for the
   newest release (`/releases/latest`, or the newest non-draft of `/releases` when
   `prerelease` is on), using a conditional request (`If-None-Match`) and a per-repo cache in the
   launcher config so the 60 requests/hour unauthenticated limit is never a problem. If a newer
   release exists, the module's id version, url and size are replaced and MD5 is dropped
   (GitHub publishes SHA-256 digests only). Local files are checked against the digest, or the
   size when there is none, and stale or corrupt copies are deleted so they are re-downloaded.
   If GitHub is unreachable the values embedded by the Manager are used.
2. **Collects missing manual mods** that the player has enabled (required mods, or optional
   mods switched on). For each, a dialog lists the mod with an "Open page" button that opens the
   platform download page in the browser, a "Choose file…" button, and a status. The launcher
   watches the Downloads folder for the expected file name, validates it (MD5, or size when the
   index carries no MD5) and copies it into place. Files can also be dropped onto the dialog.
   "Continue" is enabled once every file is in place; "Cancel" aborts the launch.
3. **Writes the resolved distribution to disk** for the child process. Manual modules whose
   file is still missing (they are all disabled at this point) are left out of that copy, so the
   child never tries to download a web page.

In Settings → Mods, every mod row shows where it comes from: GitHub mods get a prominent
"GitHub · <tag>" badge linking to the repository, manual mods a "Manual download" badge linking
to their download page, other tracked mods a small platform link. All links open in the
browser.

## Out of scope

- Changing Nebula. (It has no sidecar or hook mechanism; a fork would have to be maintained.)
- Serving or blocking files. The Manager only writes the deny list.
- Verifying the player's file against GitHub for manual mods (manual mods are never GitHub).
- Matching unmatched jars by anything other than hash or the admin's choice.
