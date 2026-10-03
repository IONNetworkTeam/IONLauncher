# Minecraft settings sync between instances

Design for a cross-repo feature between **IONLauncher** (Helios fork, branch `beta`) and
**IONLauncherManager**.

## Problem

Every server (modpack) in the launcher is its own Minecraft instance
(`<data>/instances/<serverId>/`), so every instance has its own `options.txt`. Players set
their key binds, FOV, sensitivity, volume, GUI scale and so on once per modpack, and lose them
again when a new modpack is added. Instances also run different Minecraft versions, and
`options.txt` is not the same file in 1.8 and 1.21.1: key binds are LWJGL 2 key codes in one and
`key.keyboard.*` names in the other, strings are quoted in one and not in the other, and several
options were renamed or changed type.

## Goals

1. Settings a player changes in one instance show up in every other instance of the launcher,
   without the player doing anything.
2. Works across Minecraft versions, 1.8 and 1.21.1 especially, by translating between the
   `options.txt` formats instead of copying files.
3. A new instance starts with the player's settings instead of Minecraft's defaults.
4. The player can turn sync off entirely, or for individual servers, in the settings menu.
5. An admin can turn sync off for a modpack in the Manager, for packs whose settings must not
   leak into or out of other packs (for example a pack that ships its own key binds).

## Non-goals

- Syncing mod configuration (`config/`), resource pack selection, server lists, or worlds.
- Syncing between different computers or accounts.
- Merging concurrent edits. Two instances are never running at the same time from this launcher
  in practice; if they are, the one that exits last wins.

## Which files

| File | Format | Handling |
| --- | --- | --- |
| `options.txt` | `key:value`, version dependent | Translated between formats (below) |
| `optionsof.txt` (OptiFine) | `key:value`, stable | Same keys copied where the target has them |
| `optionsshaders.txt` (OptiFine / Oculus) | `key=value`, stable | Same, except `shaderPack`, which the launcher's own shader selector manages per instance |

Keys never synced from `options.txt`: `version`, `lastServer`, `resourcePacks`,
`incompatibleResourcePacks`, `tutorialStep`, `joinedFirstServer`, `skipMultiplayerWarning`,
`onboardAccessibility`, `telemetryOptInExtra`, `syncChunkWrites`, `fullscreenResolution`,
`glDebugVerbosity`. They are per-instance state or hardware state, not preferences.

## Canonical model and translation

The launcher keeps one central store, `<data>/settingssync.json`, holding every known option in
a **canonical** form plus bookkeeping per instance. The canonical form is the modern (1.13+)
representation: modern key names, `key.keyboard.*` / `key.mouse.*` key binds, unquoted strings,
lowercase `lang`.

Format generation of a file is detected from its `version:` line (data version 1519 = 1.13 is
the cut) and, failing that, from the shape of the `key_` values, and failing that from the
server's `minecraftVersion`.

Translations applied when reading into or writing out of the canonical form:

- Key binds: LWJGL 2 code ↔ GLFW name, including mouse buttons (`-100` ↔ `key.mouse.left`).
  Codes with no modern equivalent are not written.
- `fancyGraphics` (≤1.15, boolean) ↔ `graphicsMode` (1.16+, 0/1/2).
- `ao`: 0/1/2 (≤1.19.3) ↔ true/false (1.19.4+).
- `key_key.swapHands` (1.9–1.15) ↔ `key_key.swapOffhand` (1.16+).
- `lang`: `en_US` (≤1.10) ↔ `en_us`.
- `renderClouds`: `fast` ↔ `true` for 1.8, which only knows on/off.
- Quoting: strings are written quoted or unquoted depending on the target. When the target file
  already has the key, its current quoting is mirrored, which covers the intermediate versions
  where only some enums were quoted.

When writing into an **existing** file only keys the file already has are updated, so an
instance never receives options its Minecraft version or mods do not know. Lines are rewritten
in place; unknown lines, order and line endings are preserved; the write is atomic.

When an instance has **no** `options.txt` yet (first launch of a new modpack), the file is
seeded from the central store in the target format with a correct `version:` line. The data
version comes from `version.json` inside the client jar (1.14+) or a built-in table. If it
cannot be determined for a 1.13+ target, seeding is skipped rather than risk Minecraft's data
fixers rewriting a wrongly-versioned file.

## When sync runs

- **Before launch** of server X: reconcile (below), then push the central store into X.
- **After the game exits** for X: if X's files changed since the launcher last wrote or read
  them (content hash), ingest them into the store, then push the store into every other
  enabled instance so the files on disk are consistent even if the launcher is closed next.
- **On launcher start**: reconcile once in the background.

Reconcile: for every enabled instance whose file hash differs from the recorded one (edited
outside the launcher, or never seen before), ingest in ascending modification-time order so the
newest change wins; then push to all enabled instances that differ. Ingest is a per-key merge:
keys the instance has overwrite the store, keys it lacks are kept.

Sync failures are logged and never block a launch.

## Who can turn it off

Three independent switches; sync runs for an instance only if all are on:

1. **Global** launcher setting `settings.settingsSync.enabled` (default on). Settings →
   Minecraft → "Sync settings between modpacks".
2. **Per server** launcher setting `settings.settingsSync.excludedServers` (list of server
   ids). Shown as one toggle per server under the global toggle.
3. **Admin**: `servers[].ion.settingsSync: false` in `distribution.json`. The launcher shows
   the server's toggle locked with a note that the modpack disabled it.

An excluded instance is neither read from nor written to.

## Resource packs and shader packs

The files in `resourcepacks/` and `shaderpacks/` are shared too (`settings.settingsSync.sharePacks`,
default on). Only the files travel; which packs are *active* (`resourcePacks:` in options.txt,
`shaderPack=` in optionsshaders.txt) stays per instance, because a pack that works in one
version may not exist in another.

- Every participating instance's two directories are scanned. A pack first seen in one instance
  is recorded with that instance as its **origin**. Zip files and folders both count.
- A pack is **compatible** with an instance when
  - resource pack: the instance's resource pack format lies within the range the pack's
    `pack.mcmeta` declares (`pack_format`, `supported_formats` in its three shapes, or
    `min_format`/`max_format` from 1.21.9). The instance's format comes from `pack_version` in
    the client jar's version.json, which has had three shapes, with a table for releases before
    1.14. A pack with no readable `pack.mcmeta`, or an empty or broken zip, is never shared.
  - shader pack: the instance has a shader loader. OptiFine, Iris or Oculus is looked for among
    the distribution's modules and the instance's `mods/` folder. The pack must contain a
    `shaders/` directory.
- Compatible packs are **hard linked** into the other instances (zip) or **symlinked** (folders;
  a junction on Windows), falling back to a copy when linking fails. Links cost no disk space.
  A replaced origin file (different inode, or different size/mtime for copies) is re-linked.
- Per pack **mode** (`settings.settingsSync.packModes`, keyed by file name): `compatible`
  (default), `everywhere` (share regardless of the check: the "global pack"), `off` (share
  nowhere; links the launcher made are removed). The origin copy is never touched.
- A linked copy the player deletes by hand puts that instance on the pack's exclusion list, so
  it is not linked there again. An instance's own copy with the same name is left alone. When
  the origin copy is deleted, the launcher removes the links it made and forgets the pack (or
  promotes another instance's own copy to origin).
- Bookkeeping lives in the same store under `packs.<dir>.<name>`: origin, linked instances,
  excluded instances and cached metadata keyed by size and mtime so zips are read once.

The settings tab lists every known pack with its kind, declared format range and how many
modpacks share it, with a Compatible / Everywhere / Off control per pack.

## Manager side

`servermeta.json` gains `meta.settingsSync?: boolean` (absent means on). The Metadata tab of the
server page gets a "Sync Minecraft settings" checkbox next to Main Server / Auto-connect.

Nebula only copies a fixed list of meta keys into `distribution.json`, and stays unmodified, so
after `generate distro` the Manager rewrites `distribution.json` and sets
`servers[].ion.settingsSync = false` for every server whose meta has `settingsSync === false`.
This follows the `ion` server/module extension convention from the mod-licensing design.
Unknown fields are ignored by helios-core, so older launchers keep working.
