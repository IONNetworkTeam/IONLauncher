# Mod Licensing, Manual Downloads and GitHub Custom Mods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match every modpack mod to Modrinth/CurseForge, check its license, let admins override the resulting download mode, make the launcher fetch non-redistributable mods directly from the platform or ask the player to download them, and support GitHub-release "custom mods".

**Architecture:** The Manager (SvelteKit) owns all metadata (`mod-metadata.json`, `mod-policy.json`, `custom-mods.json` per server), computes a download-mode recommendation per mod from license data, and post-processes Nebula's `distribution.json` to add an `ion` field per module plus GitHub modules. The Launcher (Electron/Helios) reads `ion` before `FullRepair`: resolves GitHub releases, collects missing manual mods into a dialog, and writes the resolved distribution to disk for Helios' child process. Nebula is not modified.

**Tech Stack:** Manager: SvelteKit 2 / Svelte 5 runes / TypeScript strict / Tailwind 4 / pnpm, tests with vitest (new dev dependency). Launcher: Electron 39, plain CommonJS, helios-core 2.3.0, `got` 11, tests with Node's built-in `node:test` (no new dependency).

**Spec:** `docs/superpowers/specs/2026-10-03-mod-licensing-and-custom-mods-design.md` (in the IONLauncher repo). Read it first; the `ion` contract section is shared by both repos.

## Repositories and paths

Two repos are touched. Paths in this plan are prefixed:

- `[M]` = `/mnt/DataDump/DataStorageDrive/Development/Repos/IONNetwork/IONLauncherManager` (branch `main`)
- `[L]` = `/mnt/DataDump/DataStorageDrive/Development/Repos/IONNetwork/IONLauncher` (branch `beta`)

Nebula (`.../IONNetwork/Nebula`) is a clean upstream clone and must not be changed.

## Global Constraints

- Both repos have **unrelated uncommitted changes** (Manager: `README.md`, `src/lib/server/nebula.ts`, `src/routes/servers/[serverId]/+page.svelte`; Launcher: `app/assets/css/ion-theme.css`, `app/assets/js/configmanager.js`, `app/assets/js/preloader.js`, `app/assets/js/scripts/uibinder.js`, `electron-builder.yml`). Never `git add -A`. Stage files by path; for a file that already has foreign changes (`configmanager.js`, `ion-theme.css`, the Manager server page, `nebula.ts`) use `git add -p` and stage only this plan's hunks.
- Commit messages: imperative subject, body explaining why, and the trailer `Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>` (never `Co-Authored-By`).
- Manager `.ts` files: 4-space indentation, single quotes, semicolons. Manager `.svelte` files: tab indentation (match the existing components). Svelte 5 runes only (`$props`, `$state`, `$derived`, `$effect`); callback props named `onxxx`.
- Manager must pass `pnpm check` (svelte-check, strict) and `pnpm test` (vitest, added in Task 1) after every task.
- Manager routes follow `try { return json(await fn()) } catch (err) { return errorResponse(err, 'msg') }` and read bodies with `readJson(request)` from `$lib/server/http` (returns `Record<string, unknown>`, 415 unless `Content-Type: application/json`).
- Pure Manager modules (`license-policy.ts`, `github-release.ts`, `distro-postprocess.ts`, `mod-names.ts`) must not import `./env`, `./nebula` or anything that reads config at import time, so vitest can load them.
- Launcher `.js` files: 4-space indentation, single quotes, no semicolons, LF line endings (existing files are LF although ESLint's `linebreak-style: windows` rule says otherwise; `npm run lint` already fails on every file, don't try to fix that). Launcher scripts in `app/assets/js/scripts/` share one global scope: never redeclare `$`, `shell`, `ipcRenderer`, `remote`, `Lang`, `LoggerUtil`, `path`, `Type`, `ConfigManager`, `DistroAPI`, `ProcessBuilder`, `escapeHtml`, `validateLocalFile`, `downloadFile`.
- Launcher must pass `npm test` (added in Task 14) and `npm run build:css` after every task.
- No new runtime dependencies in the Launcher (`got`, `fs-extra`, `helios-core` are already present). Manager: `vitest` as dev dependency only.
- Node: Manager ≥ 20.19 with pnpm 10.18.3 (`corepack enable`); Launcher Node 22.
- External APIs (verified 2026-10-03): Modrinth `GET /v2/project/{id}` returns `license: { id, name, url }` where `id` is an SPDX id or `LicenseRef-…` (ARR is `LicenseRef-All-Rights-Reserved`); CurseForge `GET /v1/mods/{id}` returns `allowModDistribution: boolean | null`, and files of opted-out mods have `downloadUrl: null`; CurseForge file hashes use `algo` 1 = SHA-1, 2 = MD5; GitHub release assets have `size`, `browser_download_url` and `digest` (`"sha256:…"` or `null` on older uploads); unauthenticated GitHub API limit is 60 requests/hour, `ETag`/`If-None-Match` 304 responses don't count.

## Review Focus

1. **Spaces and `+` in jar file names.** Nebula URL-encodes `artifact.url`; `parseModUrl` must decode so the metadata lookup by filename hits. Test added to Task 8.
2. **A matched mod whose project lookup failed** (`project` is `null`) must not be treated as "licensed": `license` is `null` → `direct`, never `hosted`. Test added to Task 2 (`recommendDownloadMode` with `license: null`).
3. **Overriding an unmatched jar to `direct` or `manual`** is impossible to honour (no URL). The server must reject it with 400. Test added to Task 2 (`resolvePolicy`/`isAllowedOverride`).
4. **A GitHub release with no matching asset** (e.g. only `-sources.jar`) must not produce a module pointing at a sources jar or crash the launcher. Tests added to Task 6 (`pickAsset` → `null`) and Task 14 (`applyRelease` returns false).
5. **Player disables an optional manual mod** whose file is missing: the launcher must neither block the launch nor let Helios download the web page. Test added to Task 14 (`pruneUnavailableManualModules`).

---

# Part A — IONLauncherManager

### Task 1: Test harness and shared types

**Files:**
- Modify: `[M]/package.json` (scripts, devDependencies)
- Modify: `[M]/vite.config.ts`
- Modify: `[M]/src/lib/types/mods.ts`
- Modify: `[M]/src/lib/types/modrinth.ts:31-39`
- Modify: `[M]/src/lib/types/curseforge.ts:11-34`
- Modify: `[M]/src/lib/types/distro.ts`
- Create: `[M]/src/lib/types/types.test.ts` (smoke test proving vitest runs)

**Interfaces:**
- Produces every type the later tasks import: `DownloadMode`, `ModLicense`, `MatchedBy`, `TrackedMod` (extended), `Recommendation`, `PolicyOverride`, `ModPolicy`, `ModInfo.policy`, `ResolvedRelease`, `CustomMod`, `IonSource`, `IonModuleMeta`, `DistroModule`, `DistroServer`, `Distribution`, `ModrinthProjectDetails.license`, `CurseForgeMod.allowModDistribution`.

- [ ] **Step 1: Add vitest**

Run in `[M]`:

```bash
pnpm add -D vitest
```

Edit `package.json` scripts: add `"test": "vitest run"` after `"check:watch"`.

Replace `vite.config.ts` with:

```ts
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    plugins: [tailwindcss(), sveltekit()],
    test: { include: ['src/**/*.test.ts'], environment: 'node' }
});
```

- [ ] **Step 2: Write the smoke test**

`src/lib/types/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MOD_CATEGORIES, isModCategory } from './mods';

describe('mod types', () => {
    it('knows the three Nebula categories', () => {
        expect(MOD_CATEGORIES).toEqual(['required', 'optionalon', 'optionaloff']);
        expect(isModCategory('optionalon')).toBe(true);
        expect(isModCategory('mods')).toBe(false);
    });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm test`
Expected: 1 test file, 1 passed.

- [ ] **Step 4: Extend `src/lib/types/mods.ts`**

Replace the `ModSource`/`TrackedMod`/`ModInfo` block (lines 11–30) with:

```ts
export interface ModInfo {
    filename: string;
    category: ModCategory;
    size: number;
    modifiedDate: string;
    /** Where the file came from, if it was installed from or matched to a mod platform. */
    tracked?: TrackedMod;
    /** How the launcher should obtain this mod (see docs/superpowers/specs in IONLauncher). */
    policy: ModPolicy;
}

export type ModSource = 'modrinth' | 'curseforge';

/** How a tracked mod got its platform match. */
export type MatchedBy = 'hash' | 'manual' | 'install' | 'import';

export interface ModLicense {
    /** SPDX id, or `LicenseRef-…` for custom / all-rights-reserved licenses. */
    id: string;
    name?: string;
    url?: string | null;
}

export interface TrackedMod {
    source: ModSource;
    projectId: string;
    versionId: string;
    projectName?: string;
    versionName?: string;
    projectUrl?: string;
    matchedBy?: MatchedBy;
    /** `null` once checked when the platform publishes no license (CurseForge). */
    license?: ModLicense | null;
    /** CurseForge `allowModDistribution`; `null` when unknown. */
    distributionAllowed?: boolean | null;
    /** CDN URL of this exact file; `null` when the platform forbids third-party downloads. */
    downloadUrl?: string | null;
    /** Page a player downloads the file from by hand. */
    pageUrl?: string;
    checkedAt?: string;
}

/** Where the launcher gets a mod from: ION's server, the platform's CDN, or the player. */
export type DownloadMode = 'hosted' | 'direct' | 'manual';

export interface Recommendation {
    mode: DownloadMode;
    reason: string;
}

export interface PolicyOverride {
    mode: DownloadMode;
    note?: string;
    reviewedAt: string;
}

export interface ModPolicy {
    /** `modrinth:<projectId>`, `curseforge:<modId>` or `file:<filename>` for unmatched jars. */
    key: string;
    /** `null` for unmatched jars: nothing is known about their license. */
    recommended: Recommendation | null;
    override: PolicyOverride | null;
    /** `override ?? recommended`; `null` means the mod still needs review. */
    effective: DownloadMode | null;
}

export interface ResolvedRelease {
    tag: string;
    assetName: string;
    url: string;
    size: number;
    md5: string | null;
    sha256: string | null;
    publishedAt: string;
    resolvedAt: string;
}

/** A mod the launcher downloads from a GitHub repository's newest release. */
export interface CustomMod {
    /** `<owner>-<repo>`, lower case. */
    id: string;
    name: string;
    /** `owner/repo` */
    repo: string;
    category: ModCategory;
    /** Regular expression an asset name must match; `null` = default (first non-sources jar). */
    assetPattern: string | null;
    prerelease: boolean;
    addedDate: string;
    resolved: ResolvedRelease | null;
    resolveError: string | null;
}
```

Keep `MissingDependency`, `IdentifyResult`, `ModUpdateInfo`, `FileEntry` as they are.

- [ ] **Step 5: Extend the platform types**

`src/lib/types/modrinth.ts`, replace `ModrinthProjectDetails` with:

```ts
/** A project as returned by /project and /projects (search hits use a different shape). */
export interface ModrinthProjectDetails {
	id: string;
	slug: string;
	title: string;
	description: string;
	icon_url: string | null;
	project_type: string;
	downloads: number;
	license: { id: string; name: string; url: string | null };
	source_url: string | null;
}
```

`src/lib/types/curseforge.ts`, inside `CurseForgeMod` add after `summary: string;`:

```ts
	/** `false` when the author blocks third-party downloads (files then have `downloadUrl: null`). */
	allowModDistribution: boolean | null;
```

- [ ] **Step 6: Add distribution types**

Append to `src/lib/types/distro.ts`:

```ts
import type { DownloadMode, ModLicense, ModSource } from './mods';

export type IonSource = ModSource | 'github';

/** ION's extension of a Helios module; see the IONLauncher spec. */
export interface IonModuleMeta {
    source: IonSource;
    download: DownloadMode;
    projectUrl?: string;
    license?: ModLicense | null;
    manual?: { pageUrl: string; fileName: string };
    github?: { repo: string; assetPattern: string | null; prerelease: boolean; tag: string; sha256: string | null };
}

export type DistroModuleType =
    | 'Library' | 'ForgeHosted' | 'Forge' | 'Fabric' | 'LiteLoader'
    | 'ForgeMod' | 'FabricMod' | 'LiteMod' | 'File' | 'VersionManifest';

export interface DistroArtifact {
    size: number;
    MD5?: string;
    url: string;
    path?: string;
}

export interface DistroModule {
    id: string;
    name: string;
    type: DistroModuleType;
    classpath?: boolean;
    required?: { value?: boolean; def?: boolean };
    artifact: DistroArtifact;
    subModules?: DistroModule[];
    ion?: IonModuleMeta;
}

export interface DistroServer {
    id: string;
    name: string;
    minecraftVersion: string;
    modules: DistroModule[];
    [key: string]: unknown;
}

export interface Distribution {
    version: string;
    rss: string;
    servers: DistroServer[];
    [key: string]: unknown;
}
```

- [ ] **Step 7: Make the code compile with the new `ModInfo.policy`**

`policy` is now required on `ModInfo`, so `pnpm check` fails in `src/lib/server/mod-updates.ts` (`listModsWithTracking`) until Task 3. Temporarily make it compile by changing the `ModInfo` field to `policy?: ModPolicy;` in Step 4 **and leave a `// TODO(Task 3): make required` comment**. Task 3 removes the `?`.

Run: `pnpm check` → 0 errors. Run: `pnpm test` → passes.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml vite.config.ts src/lib/types/mods.ts src/lib/types/modrinth.ts src/lib/types/curseforge.ts src/lib/types/distro.ts src/lib/types/types.test.ts
git commit -m "Add vitest and the types for mod download policies and custom mods" -m "Groundwork for license-based download modes and GitHub custom mods: the data shapes shared by the API, UI and distribution post-processing, plus a test runner for the pure logic that follows." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: License policy (pure)

**Files:**
- Create: `[M]/src/lib/server/license-policy.ts`
- Create: `[M]/src/lib/server/license-policy.test.ts`

**Interfaces:**
- Produces:
  - `normalizeLicenseId(id: string): string`
  - `isRedistributable(id: string | null | undefined): boolean`
  - `recommendDownloadMode(tracked: TrackedMod): Recommendation`
  - `DOWNLOAD_MODES: readonly DownloadMode[]`, `isDownloadMode(v: unknown): v is DownloadMode`
  - `policyKey(filename: string, tracked?: TrackedMod | null): string`
  - `isAllowedOverride(key: string, mode: DownloadMode): boolean` (unmatched `file:` keys may only be `hosted`)
  - `resolvePolicy(filename: string, tracked: TrackedMod | undefined, overrides: Record<string, PolicyOverride>): ModPolicy`

- [ ] **Step 1: Write the failing tests**

`src/lib/server/license-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TrackedMod } from '$lib/types/mods';
import {
    isAllowedOverride,
    isRedistributable,
    normalizeLicenseId,
    policyKey,
    recommendDownloadMode,
    resolvePolicy
} from './license-policy';

function modrinth(license: TrackedMod['license'], downloadUrl: string | null = 'https://cdn.modrinth.com/data/x/versions/y/x.jar'): TrackedMod {
    return { source: 'modrinth', projectId: 'AANobbMI', versionId: 'v1', license, downloadUrl };
}

function curseforge(distributionAllowed: boolean | null, downloadUrl: string | null): TrackedMod {
    return { source: 'curseforge', projectId: '238222', versionId: '9038350', license: null, distributionAllowed, downloadUrl };
}

describe('normalizeLicenseId', () => {
    it('strips -only, -or-later, + and exception suffixes and upper-cases', () => {
        expect(normalizeLicenseId('LGPL-3.0-only')).toBe('LGPL-3.0');
        expect(normalizeLicenseId('GPL-2.0-or-later')).toBe('GPL-2.0');
        expect(normalizeLicenseId('GPL-3.0+')).toBe('GPL-3.0');
        expect(normalizeLicenseId('GPL-2.0-with-classpath-exception')).toBe('GPL-2.0');
        expect(normalizeLicenseId(' mit ')).toBe('MIT');
    });
});

describe('isRedistributable', () => {
    it('accepts permissive and copyleft open source licenses', () => {
        for (const id of ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'LGPL-3.0-only', 'GPL-3.0-or-later', 'MPL-2.0', 'CC0-1.0', 'CC-BY-4.0', 'Unlicense']) {
            expect(isRedistributable(id), id).toBe(true);
        }
    });
    it('rejects all-rights-reserved, custom, non-commercial and source-available licenses', () => {
        for (const id of ['LicenseRef-All-Rights-Reserved', 'ARR', 'LicenseRef-Custom', 'LicenseRef-Polyform-Shield-1.0.0', 'CC-BY-NC-4.0', 'BUSL-1.1', 'NOASSERTION', '']) {
            expect(isRedistributable(id), id).toBe(false);
        }
        expect(isRedistributable(null)).toBe(false);
        expect(isRedistributable(undefined)).toBe(false);
    });
});

describe('recommendDownloadMode', () => {
    it('hosts Modrinth mods with a redistributable license', () => {
        const r = recommendDownloadMode(modrinth({ id: 'MIT' }));
        expect(r.mode).toBe('hosted');
        expect(r.reason).toContain('MIT');
    });
    it('direct-downloads Modrinth mods with ARR, custom or unknown licenses', () => {
        expect(recommendDownloadMode(modrinth({ id: 'LicenseRef-All-Rights-Reserved' })).mode).toBe('direct');
        expect(recommendDownloadMode(modrinth({ id: 'LicenseRef-Custom' })).mode).toBe('direct');
        expect(recommendDownloadMode(modrinth({ id: 'CC-BY-NC-SA-4.0' })).mode).toBe('direct');
        // Project lookup failed: nothing is known, so don't host it.
        expect(recommendDownloadMode(modrinth(null)).mode).toBe('direct');
        expect(recommendDownloadMode(modrinth(undefined)).mode).toBe('direct');
    });
    it('direct-downloads CurseForge mods that allow third-party downloads', () => {
        const r = recommendDownloadMode(curseforge(true, 'https://edge.forgecdn.net/files/9038/350/jei.jar'));
        expect(r.mode).toBe('direct');
        expect(r.reason).toContain('CurseForge');
    });
    it('requires a manual download when CurseForge blocks third parties', () => {
        expect(recommendDownloadMode(curseforge(false, null)).mode).toBe('manual');
        // Flag unknown (mod lookup failed) but the file has no download URL: still manual.
        expect(recommendDownloadMode(curseforge(null, null)).mode).toBe('manual');
    });
});

describe('resolvePolicy', () => {
    it('keys tracked mods by project and unmatched jars by file name', () => {
        expect(policyKey('a.jar', modrinth({ id: 'MIT' }))).toBe('modrinth:AANobbMI');
        expect(policyKey('a.jar', curseforge(true, null))).toBe('curseforge:238222');
        expect(policyKey('a.jar', null)).toBe('file:a.jar');
    });
    it('leaves unmatched jars unresolved', () => {
        const p = resolvePolicy('mystery.jar', undefined, {});
        expect(p).toEqual({ key: 'file:mystery.jar', recommended: null, override: null, effective: null });
    });
    it('uses the recommendation when there is no override', () => {
        const p = resolvePolicy('sodium.jar', modrinth({ id: 'LGPL-3.0-only' }), {});
        expect(p.effective).toBe('hosted');
        expect(p.override).toBeNull();
    });
    it('lets an override win', () => {
        const override = { mode: 'manual' as const, note: 'author asked us', reviewedAt: '2026-10-03T00:00:00.000Z' };
        const p = resolvePolicy('sodium.jar', modrinth({ id: 'MIT' }), { 'modrinth:AANobbMI': override });
        expect(p.effective).toBe('manual');
        expect(p.override).toEqual(override);
        expect(p.recommended?.mode).toBe('hosted');
    });
    it('only allows hosting unmatched jars by override', () => {
        expect(isAllowedOverride('file:x.jar', 'hosted')).toBe(true);
        expect(isAllowedOverride('file:x.jar', 'direct')).toBe(false);
        expect(isAllowedOverride('file:x.jar', 'manual')).toBe(false);
        expect(isAllowedOverride('modrinth:AANobbMI', 'manual')).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL, cannot resolve `./license-policy`.

- [ ] **Step 3: Implement `src/lib/server/license-policy.ts`**

```ts
import type { DownloadMode, ModPolicy, PolicyOverride, Recommendation, TrackedMod } from '$lib/types/mods';

/**
 * Which download mode the launcher should use for a mod, derived from what the platform
 * says about its license. Pure: no I/O, so the rules can be unit-tested and changed freely.
 *
 * - hosted: ION serves the jar (only when the license clearly permits redistribution)
 * - direct: the launcher fetches it from the platform's CDN (Modrinth allows this for all
 *   projects, CurseForge unless the author opted out)
 * - manual: the player downloads it from the mod page (CurseForge opt-outs)
 */

/** SPDX ids (normalized) under which redistributing an unmodified jar is clearly permitted. */
const REDISTRIBUTABLE = new Set([
    'MIT', 'MIT-0', 'X11', 'ISC', '0BSD', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'APACHE-2.0', 'UNLICENSE',
    'CC0-1.0', 'WTFPL', 'ZLIB', 'BSL-1.0', 'ARTISTIC-2.0', 'POSTGRESQL', 'NCSA', 'OFL-1.1', 'BEERWARE',
    'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'MPL-2.0', 'EPL-1.0', 'EPL-2.0',
    'CDDL-1.0', 'EUPL-1.2',
    'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'CC-BY-ND-4.0'
]);

export const DOWNLOAD_MODES: readonly DownloadMode[] = ['hosted', 'direct', 'manual'];

export function isDownloadMode(value: unknown): value is DownloadMode {
    return typeof value === 'string' && (DOWNLOAD_MODES as readonly string[]).includes(value);
}

export function normalizeLicenseId(id: string): string {
    return id
        .trim()
        .toUpperCase()
        .replace(/-WITH-.*$/, '')
        .replace(/-ONLY$|-OR-LATER$|\+$/, '');
}

export function isRedistributable(id: string | null | undefined): boolean {
    if (!id) return false;
    return REDISTRIBUTABLE.has(normalizeLicenseId(id));
}

function describeLicense(id: string): string {
    if (/^(LicenseRef-)?All-Rights-Reserved$/i.test(id) || /^ARR$/i.test(id)) return 'All Rights Reserved';
    if (/^LicenseRef-/i.test(id)) return `The custom license "${id.replace(/^LicenseRef-/i, '')}"`;
    return id;
}

export function recommendDownloadMode(tracked: TrackedMod): Recommendation {
    if (tracked.source === 'curseforge') {
        if (tracked.distributionAllowed === false || tracked.downloadUrl === null) {
            return {
                mode: 'manual',
                reason: 'The author disabled third-party downloads on CurseForge, so neither ION nor the launcher may fetch it. Players download it from the CurseForge page themselves.'
            };
        }
        return {
            mode: 'direct',
            reason: "CurseForge doesn't publish licenses through its API, so ION doesn't host a copy. The launcher downloads it from CurseForge's CDN, which CurseForge permits."
        };
    }
    const id = tracked.license?.id;
    if (!id) {
        return {
            mode: 'direct',
            reason: 'No license is declared, which means all rights reserved. The launcher downloads it from Modrinth, which permits launcher downloads.'
        };
    }
    if (isRedistributable(id)) {
        return { mode: 'hosted', reason: `${id} permits redistribution, so ION can host the file.` };
    }
    return {
        mode: 'direct',
        reason: `${describeLicense(id)} doesn't clearly permit redistribution. The launcher downloads it from Modrinth, which permits launcher downloads.`
    };
}

export function policyKey(filename: string, tracked?: TrackedMod | null): string {
    return tracked ? `${tracked.source}:${tracked.projectId}` : `file:${filename}`;
}

/** Unmatched jars have no platform URL, so the only honest override for them is to host them. */
export function isAllowedOverride(key: string, mode: DownloadMode): boolean {
    return !key.startsWith('file:') || mode === 'hosted';
}

export function resolvePolicy(
    filename: string,
    tracked: TrackedMod | undefined,
    overrides: Record<string, PolicyOverride>
): ModPolicy {
    const key = policyKey(filename, tracked);
    const recommended = tracked ? recommendDownloadMode(tracked) : null;
    const override = overrides[key] ?? null;
    return { key, recommended, override, effective: override?.mode ?? recommended?.mode ?? null };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test` → all pass. Run: `pnpm check` → 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/license-policy.ts src/lib/server/license-policy.test.ts
git commit -m "Recommend a download mode per mod from its license" -m "Pure rules: redistributable SPDX licenses are hosted, everything else is downloaded directly from the platform, and CurseForge opt-outs need a manual download. Overrides are keyed by project so they survive updates." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Metadata store split, policy overrides store and API

**Files:**
- Create: `[M]/src/lib/server/mod-metadata.ts` (store moved out of `mod-updates.ts`)
- Modify: `[M]/src/lib/server/mod-updates.ts:1-66, 223-232`
- Create: `[M]/src/lib/server/mod-policy.ts`
- Create: `[M]/src/routes/api/servers/[serverId]/mods/policy/+server.ts`
- Modify: `[M]/src/lib/types/mods.ts` (make `policy` required again)

**Interfaces:**
- Consumes: `resolvePolicy`, `isDownloadMode`, `isAllowedOverride` (Task 2).
- Produces (`mod-metadata.ts`): `ModMetadataEntry`, `getModMetadata(serverId)`, `saveModMetadata(serverId, entries)`, `removeModMetadata(serverId, filename)`, `withServerLock(serverId, fn)`, `trackMod(serverId, filename, tracked)`, `toTrackedMod(entry)`.
- Produces (`mod-policy.ts`): `PolicyOverrides`, `getPolicyOverrides(serverId)`, `setPolicyOverride(serverId, key, mode | null, note?)`.
- Produces: `PUT /api/servers/:id/mods/policy` body `{ key: string; mode: DownloadMode | null; note?: string }` → `{ success: true, override: PolicyOverride | null }`.
- `GET /api/servers/:id/mods` now returns `ModInfo[]` with `policy` on every row.

- [ ] **Step 1: Create `src/lib/server/mod-metadata.ts`**

Move the store code (currently `mod-updates.ts` lines 13–66: `ModMetadataEntry`, `METADATA_FILE`, `getMetadataPath`, the lock, `getModMetadata`, `saveModMetadata`, `removeModMetadata`) into the new file unchanged, exporting `saveModMetadata` and `withServerLock` too, and add:

```ts
/** Record (or replace) what a file was matched to. */
export async function trackMod(serverId: string, filename: string, tracked: TrackedMod): Promise<void> {
    await withServerLock(serverId, async () => {
        const entries = await getModMetadata(serverId);
        const remaining = entries.filter(e => e.filename !== filename);
        remaining.push({ ...tracked, filename, installedDate: new Date().toISOString() });
        await saveModMetadata(serverId, remaining);
    });
}

/** The platform data of an entry, without the file bookkeeping. */
export function toTrackedMod(entry: ModMetadataEntry): TrackedMod {
    const { filename: _filename, installedDate: _installedDate, ...tracked } = entry;
    return tracked;
}
```

Imports for the file: `readFile, writeFile, rename` from `fs/promises`, `join` from `path`, `getServerDir` from `./nebula`, `type { TrackedMod } from '$lib/types/mods'`.

- [ ] **Step 2: Rewire `mod-updates.ts`**

Delete lines 13–66 and replace with:

```ts
import { getModMetadata, saveModMetadata, withServerLock, type ModMetadataEntry } from './mod-metadata';
import { getPolicyOverrides } from './mod-policy';
import { resolvePolicy } from './license-policy';
import { toTrackedMod } from './mod-metadata';

// Re-exported so existing routes keep importing the store from here.
export { getModMetadata, removeModMetadata } from './mod-metadata';
export type { ModMetadataEntry } from './mod-metadata';

const UPDATE_CHECK_CONCURRENCY = 8;
```

(Drop the now-unused `readFile, writeFile, rename` and `join` imports.)

Replace `listModsWithTracking` with:

```ts
/**
 * List a server's mods along with what each one was installed from or matched to,
 * and how the launcher should obtain it.
 */
export async function listModsWithTracking(serverId: string): Promise<ModInfo[]> {
    const [mods, entries, overrides] = await Promise.all([
        listMods(serverId),
        getModMetadata(serverId),
        getPolicyOverrides(serverId)
    ]);
    const byFilename = new Map(entries.map(e => [e.filename, e]));
    return mods.map(mod => {
        const entry = byFilename.get(mod.filename);
        const tracked = entry ? toTrackedMod(entry) : undefined;
        return { ...mod, tracked, policy: resolvePolicy(mod.filename, tracked, overrides) };
    });
}
```

In `src/lib/types/mods.ts` change `policy?: ModPolicy;` back to `policy: ModPolicy;` and delete the TODO comment. `listMods` in `mods.ts` returns `ModInfo[]` without `policy`; change its return type to `Promise<Omit<ModInfo, 'policy'>[]>` and the local `const mods: ModInfo[]` accordingly (`Omit<ModInfo, 'policy'>[]`). `identifyMods` only reads `filename`/`category`, so it compiles.

- [ ] **Step 3: Create `src/lib/server/mod-policy.ts`**

```ts
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { getServerDir } from './nebula';
import { badRequest } from './http';
import { isAllowedOverride, isDownloadMode } from './license-policy';
import type { DownloadMode, PolicyOverride } from '$lib/types/mods';

/** Admin overrides of the recommended download mode, keyed as in `policyKey`. */
export type PolicyOverrides = Record<string, PolicyOverride>;

const POLICY_FILE = 'mod-policy.json';

function getPolicyPath(serverId: string): string {
    return join(getServerDir(serverId), POLICY_FILE);
}

export async function getPolicyOverrides(serverId: string): Promise<PolicyOverrides> {
    try {
        const data = JSON.parse(await readFile(getPolicyPath(serverId), 'utf-8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

/**
 * Set (mode given) or clear (mode null) an admin override. Returns the stored override.
 */
export async function setPolicyOverride(
    serverId: string,
    key: string,
    mode: DownloadMode | null,
    note?: string
): Promise<PolicyOverride | null> {
    if (!/^(modrinth|curseforge|file):./.test(key)) throw badRequest('Invalid policy key');
    if (mode !== null && !isDownloadMode(mode)) throw badRequest('mode must be hosted, direct, manual or null');
    if (mode !== null && !isAllowedOverride(key, mode)) {
        throw badRequest('An unmatched mod has no download URL; it can only be hosted. Match it first.');
    }

    const overrides = await getPolicyOverrides(serverId);
    let result: PolicyOverride | null = null;
    if (mode === null) {
        delete overrides[key];
    } else {
        result = { mode, reviewedAt: new Date().toISOString() };
        const trimmed = note?.trim();
        if (trimmed) result.note = trimmed;
        overrides[key] = result;
    }

    const path = getPolicyPath(serverId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(overrides, null, 2));
    await rename(tmp, path);
    return result;
}
```

- [ ] **Step 4: Create the route** `src/routes/api/servers/[serverId]/mods/policy/+server.ts`

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { setPolicyOverride } from '$lib/server/mod-policy';
import { badRequest, errorResponse, readJson } from '$lib/server/http';
import { isDownloadMode } from '$lib/server/license-policy';

/** Override (or clear, with `mode: null`) how the launcher obtains a mod. */
export const PUT: RequestHandler = async ({ params, request }) => {
    try {
        const body = await readJson(request);
        if (typeof body.key !== 'string') throw badRequest('key is required');
        const mode = body.mode ?? null;
        if (mode !== null && !isDownloadMode(mode)) throw badRequest('mode must be hosted, direct, manual or null');
        const note = typeof body.note === 'string' ? body.note : undefined;
        const override = await setPolicyOverride(validateServerId(params.serverId), body.key, mode, note);
        return json({ success: true, override });
    } catch (err) {
        return errorResponse(err, 'Failed to update the download policy');
    }
};
```

- [ ] **Step 5: Verify**

Run: `pnpm check` → 0 errors. Run: `pnpm test` → passes.

Manual check with the dev server (`pnpm dev`, with `config.json` pointing at a Nebula root that has a server):

```bash
curl -s localhost:5173/api/servers/<serverId>/mods | head -c 600
curl -s -X PUT -H 'Content-Type: application/json' -d '{"key":"file:nothing.jar","mode":"direct"}' localhost:5173/api/servers/<serverId>/mods/policy
```

Expected: every mod has a `policy` object; the second call returns 400 with the "can only be hosted" message.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/mod-metadata.ts src/lib/server/mod-updates.ts src/lib/server/mod-policy.ts src/lib/server/mods.ts src/lib/types/mods.ts "src/routes/api/servers/[serverId]/mods/policy/+server.ts"
git commit -m "Store admin download-mode overrides and report a policy per mod" -m "Moves the mod-metadata store into its own module so the policy, tracking and import code can share it without import cycles, and adds mod-policy.json with a PUT endpoint." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: License data on match and install, re-check endpoint

**Files:**
- Create: `[M]/src/lib/server/mod-tracking.ts`
- Modify: `[M]/src/lib/server/mod-updates.ts` (`installModrinthMod`, `installCurseForgeMod`, `identifyMods`, `checkEntry`)
- Create: `[M]/src/routes/api/servers/[serverId]/mods/recheck/+server.ts`

**Interfaces:**
- Consumes: `getModMetadata`, `saveModMetadata`, `withServerLock` (Task 3); `modrinth.getVersions/getProjects/projectUrl`, `curseforge.getFiles/getMods/isConfigured` (existing).
- Produces:
  - `describeModrinth(version: ModrinthVersion, project: ModrinthProjectDetails | null, matchedBy: MatchedBy, sha1?: string): TrackedMod`
  - `describeCurseForge(file: CurseForgeFile, mod: CurseForgeMod | null, matchedBy: MatchedBy): TrackedMod`
  - `refreshLicenseData(serverId: string): Promise<{ updated: number }>`
  - `POST /api/servers/:id/mods/recheck` → `{ updated: number }`

- [ ] **Step 1: Create `src/lib/server/mod-tracking.ts`**

```ts
import * as modrinth from './modrinth';
import * as curseforge from './curseforge';
import { getModMetadata, saveModMetadata, withServerLock } from './mod-metadata';
import type { MatchedBy, TrackedMod } from '$lib/types/mods';
import type { ModrinthProjectDetails, ModrinthVersion } from '$lib/types/modrinth';
import type { CurseForgeFile, CurseForgeMod } from '$lib/types/curseforge';

/**
 * Everything we record about a mod file from its platform, including what the
 * download policy needs: license, distribution flag, CDN URL and download page.
 */
export function describeModrinth(
    version: ModrinthVersion,
    project: ModrinthProjectDetails | null,
    matchedBy: MatchedBy,
    sha1?: string
): TrackedMod {
    const file =
        (sha1 && version.files.find(f => f.hashes.sha1 === sha1)) ||
        version.files.find(f => f.primary) ||
        version.files[0];
    const slug = project?.slug ?? version.project_id;
    const url = modrinth.projectUrl(slug);
    return {
        source: 'modrinth',
        projectId: version.project_id,
        versionId: version.id,
        projectName: project?.title,
        versionName: version.version_number,
        projectUrl: url,
        matchedBy,
        license: project?.license
            ? { id: project.license.id, name: project.license.name || undefined, url: project.license.url }
            : null,
        // Modrinth lets launchers download every project from its CDN.
        distributionAllowed: true,
        downloadUrl: file?.url ?? null,
        pageUrl: `${url}/version/${encodeURIComponent(version.id)}`,
        checkedAt: new Date().toISOString()
    };
}

export function describeCurseForge(file: CurseForgeFile, mod: CurseForgeMod | null, matchedBy: MatchedBy): TrackedMod {
    const websiteUrl = mod?.links?.websiteUrl || undefined;
    return {
        source: 'curseforge',
        projectId: String(file.modId),
        versionId: String(file.id),
        projectName: mod?.name,
        versionName: file.displayName,
        projectUrl: websiteUrl,
        matchedBy,
        // CurseForge publishes no license data through its API.
        license: null,
        distributionAllowed: mod ? mod.allowModDistribution : null,
        downloadUrl: file.downloadUrl ?? null,
        pageUrl: websiteUrl ? `${websiteUrl}/download/${file.id}` : undefined,
        checkedAt: new Date().toISOString()
    };
}

/**
 * Re-fetch license and distribution data for every tracked mod of a server
 * (e.g. after an author changes a license, or for entries written before this existed).
 */
export async function refreshLicenseData(serverId: string): Promise<{ updated: number }> {
    return withServerLock(serverId, async () => {
        const entries = await getModMetadata(serverId);
        let updated = 0;

        const mr = entries.filter(e => e.source === 'modrinth');
        if (mr.length > 0) {
            const [versions, projects] = await Promise.all([
                modrinth.getVersions(mr.map(e => e.versionId)),
                modrinth.getProjects([...new Set(mr.map(e => e.projectId))])
            ]);
            const versionById = new Map(versions.map(v => [v.id, v]));
            const projectById = new Map(projects.map(p => [p.id, p]));
            for (const entry of mr) {
                const version = versionById.get(entry.versionId);
                if (!version) continue;
                Object.assign(entry, describeModrinth(version, projectById.get(entry.projectId) ?? null, entry.matchedBy ?? 'hash'));
                updated++;
            }
        }

        const cf = entries.filter(e => e.source === 'curseforge');
        if (cf.length > 0 && curseforge.isConfigured()) {
            const [files, mods] = await Promise.all([
                curseforge.getFiles(cf.map(e => Number(e.versionId))),
                curseforge.getMods([...new Set(cf.map(e => Number(e.projectId)))])
            ]);
            const fileById = new Map(files.map(f => [String(f.id), f]));
            const modById = new Map(mods.map(m => [m.id, m]));
            for (const entry of cf) {
                const file = fileById.get(entry.versionId);
                if (!file) continue;
                Object.assign(entry, describeCurseForge(file, modById.get(file.modId) ?? null, entry.matchedBy ?? 'hash'));
                updated++;
            }
        }

        if (updated > 0) await saveModMetadata(serverId, entries);
        return { updated };
    });
}
```

- [ ] **Step 2: Use the describers in `mod-updates.ts`**

Add `import { describeCurseForge, describeModrinth } from './mod-tracking';`.

In `installModrinthMod`, replace the inline object passed to `installDownloadedMod` with `describeModrinth(version, project, 'install')`.

In `installCurseForgeMod`, fetch the file info too and pass `describeCurseForge(file, mod, 'install')`:

```ts
    const [download, mod, file] = await Promise.all([
        curseforge.downloadFile(modId, fileId),
        curseforge.getMod(modId).catch(() => null),
        curseforge.getModFile(modId, fileId)
    ]);
    return installDownloadedMod(serverId, describeCurseForge(file, mod, 'install'), download, category);
```

In `identifyMods`, replace the two `found.set(...)` objects with `describeModrinth(version, project ?? null, 'hash', c.sha1)` and `describeCurseForge(file, mod ?? null, 'hash')`.

In `checkEntry`, nothing changes (sources are still only modrinth/curseforge).

- [ ] **Step 3: Create the route** `src/routes/api/servers/[serverId]/mods/recheck/+server.ts`

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { refreshLicenseData } from '$lib/server/mod-tracking';
import { errorResponse } from '$lib/server/http';

export const POST: RequestHandler = async ({ params }) => {
    try {
        return json(await refreshLicenseData(validateServerId(params.serverId)));
    } catch (err) {
        return errorResponse(err, 'Failed to re-check licenses');
    }
};
```

- [ ] **Step 4: Verify**

Run: `pnpm check` and `pnpm test` → pass. With the dev server: `curl -s -X POST localhost:5173/api/servers/<serverId>/mods/recheck` → `{"updated":N}`; then `GET .../mods` shows `tracked.license`, `tracked.downloadUrl`, `tracked.pageUrl` and `policy.recommended` for matched mods. Open `servers/<serverId>/mod-metadata.json` and confirm the new fields.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/mod-tracking.ts src/lib/server/mod-updates.ts "src/routes/api/servers/[serverId]/mods/recheck/+server.ts"
git commit -m "Record license, distribution flag and download URLs when matching or installing mods" -m "Also adds POST mods/recheck to refresh that data for every tracked mod." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Manual matching API and file-name query guess

**Files:**
- Modify: `[M]/src/lib/server/mod-tracking.ts` (add `matchModManually`)
- Create: `[M]/src/routes/api/servers/[serverId]/mods/match/+server.ts`
- Create: `[M]/src/lib/mod-names.ts`
- Create: `[M]/src/lib/mod-names.test.ts`

**Interfaces:**
- Consumes: `describeModrinth`, `describeCurseForge` (Task 4); `trackMod`, `removeModMetadata` (Task 3); `findModCategory`, `readMod` from `./mods`.
- Produces:
  - `matchModManually(serverId, filename, source: ModSource, projectId: string, versionId: string): Promise<TrackedMod>`
  - `POST /api/servers/:id/mods/match` body `{ filename, source, projectId, versionId }` → `{ success: true, tracked: TrackedMod }`
  - `DELETE /api/servers/:id/mods/match` body `{ filename }` → `{ success: true }` (forget a match)
  - `guessQuery(filename: string): string` (client-side, pre-fills the search box)

- [ ] **Step 1: Write the failing test** `src/lib/mod-names.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { guessQuery } from './mod-names';

describe('guessQuery', () => {
    it('keeps the words before the version and loader markers', () => {
        expect(guessQuery('sodium-fabric-0.5.3+mc1.20.1.jar')).toBe('sodium');
        expect(guessQuery('jei-1.20.1-forge-15.2.0.27.jar')).toBe('jei');
        expect(guessQuery('Create-1.20.1-0.5.1.f.jar')).toBe('Create');
        expect(guessQuery('ferritecore-6.0.1-forge.jar')).toBe('ferritecore');
        expect(guessQuery('journeymap_fabric_1.20.1-5.9.18.jar.disabled')).toBe('journeymap');
    });
    it('falls back to the whole base name when nothing is left', () => {
        expect(guessQuery('1.20.1.jar')).toBe('1.20.1');
    });
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/lib/mod-names.ts`

```ts
/**
 * Turn a mod file name into a search query: the leading words, stopping at the
 * first segment that looks like a version, loader or Minecraft version.
 * `sodium-fabric-0.5.3+mc1.20.1.jar` -> `sodium`.
 */
export function guessQuery(filename: string): string {
    const base = filename.replace(/\.jar(\.disabled)?$/i, '');
    const words: string[] = [];
    for (const part of base.split(/[-_+ ]/)) {
        if (!part) continue;
        if (/^\d/.test(part)) break;
        if (/^(forge|fabric|neoforge|quilt|mc\d|v\d|universal|client|server)/i.test(part)) break;
        words.push(part);
    }
    return (words.length > 0 ? words.join(' ') : base).trim();
}
```

- [ ] **Step 4: Run** `pnpm test` → passes.

- [ ] **Step 5: Add `matchModManually` to `src/lib/server/mod-tracking.ts`**

Add imports `createHash` from `crypto`, `findModCategory, readMod` from `./mods`, `trackMod` from `./mod-metadata`, `badRequest, notFound` from `./http`, `type { ModSource }` from `$lib/types/mods`, and:

```ts
/**
 * Record an admin's choice of platform project and version for a file that hash
 * matching didn't recognise (re-uploaded, re-zipped or modified jars).
 */
export async function matchModManually(
    serverId: string,
    filename: string,
    source: ModSource,
    projectId: string,
    versionId: string
): Promise<TrackedMod> {
    const category = await findModCategory(serverId, filename);
    if (!category) throw notFound(`${filename} is not a mod of this server`);

    let tracked: TrackedMod;
    if (source === 'modrinth') {
        const version = await modrinth.getVersion(versionId);
        if (version.project_id !== projectId) throw badRequest('That version does not belong to the selected project');
        const project = await modrinth.getProject(projectId).catch(() => null);
        const sha1 = createHash('sha1').update(await readMod(serverId, category, filename)).digest('hex');
        tracked = describeModrinth(version, project, 'manual', sha1);
    } else if (source === 'curseforge') {
        const modId = Number(projectId);
        const fileId = Number(versionId);
        if (!Number.isSafeInteger(modId) || modId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) {
            throw badRequest('projectId and versionId must be CurseForge mod and file ids');
        }
        const [file, mod] = await Promise.all([curseforge.getModFile(modId, fileId), curseforge.getMod(modId).catch(() => null)]);
        tracked = describeCurseForge(file, mod, 'manual');
    } else {
        throw badRequest('source must be modrinth or curseforge');
    }

    await trackMod(serverId, filename, tracked);
    return tracked;
}
```

- [ ] **Step 6: Create the route** `src/routes/api/servers/[serverId]/mods/match/+server.ts`

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { matchModManually } from '$lib/server/mod-tracking';
import { removeModMetadata } from '$lib/server/mod-metadata';
import { badRequest, errorResponse, readJson } from '$lib/server/http';

function requireString(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== 'string' || !value) throw badRequest(`${key} is required`);
    return value;
}

export const POST: RequestHandler = async ({ params, request }) => {
    try {
        const body = await readJson(request);
        const source = requireString(body, 'source');
        if (source !== 'modrinth' && source !== 'curseforge') throw badRequest('source must be modrinth or curseforge');
        const tracked = await matchModManually(
            validateServerId(params.serverId),
            requireString(body, 'filename'),
            source,
            requireString(body, 'projectId'),
            requireString(body, 'versionId')
        );
        return json({ success: true, tracked });
    } catch (err) {
        return errorResponse(err, 'Failed to match mod');
    }
};

/** Forget a match (the mod shows as unmatched again). */
export const DELETE: RequestHandler = async ({ params, request }) => {
    try {
        const body = await readJson(request);
        await removeModMetadata(validateServerId(params.serverId), requireString(body, 'filename'));
        return json({ success: true });
    } catch (err) {
        return errorResponse(err, 'Failed to unmatch mod');
    }
};
```

- [ ] **Step 7: Verify** `pnpm check`, `pnpm test`. With the dev server, match a real file:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"filename":"<an unmatched jar>","source":"modrinth","projectId":"AANobbMI","versionId":"<a sodium version id>"}' \
  localhost:5173/api/servers/<serverId>/mods/match
```

Expected: `tracked.matchedBy === "manual"` and the mod now has a `policy.effective` in `GET .../mods`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/mod-names.ts src/lib/mod-names.test.ts src/lib/server/mod-tracking.ts "src/routes/api/servers/[serverId]/mods/match/+server.ts"
git commit -m "Let admins match a mod file to a platform project by hand" -m "Hash matching misses re-zipped or modified jars; POST mods/match records the admin's pick and fetches its license data, DELETE forgets it." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: GitHub release helpers and API client

**Files:**
- Create: `[M]/src/lib/server/github-release.ts` (pure)
- Create: `[M]/src/lib/server/github-release.test.ts`
- Create: `[M]/src/lib/server/github.ts` (API client)
- Modify: `[M]/src/lib/server/env.ts` (add `GITHUB_TOKEN`)
- Modify: `[M]/src/routes/api/status/+server.ts` (report it as set/unset)
- Modify: `[M]/src/routes/settings/+page.svelte:31-32` (list it)
- Modify: `[M]/README.md` (config table row)

**Interfaces:**
- Produces (`github-release.ts`): `GithubAsset`, `GithubRelease`, `DEFAULT_ASSET_PATTERN`, `parseGithubRepo(input: string): string`, `repoUrl(repo: string): string`, `safeTag(tag: string): string`, `pickAsset(assets: GithubAsset[], pattern?: string | null): GithubAsset | null`, `customModuleId(repo: string, tag: string): string`.
- Produces (`github.ts`): `getLatestRelease(repo: string, includePrerelease: boolean): Promise<GithubRelease>`, `downloadAsset(url: string): Promise<Uint8Array>`.
- Produces: `GITHUB_TOKEN` export from `env.ts`.

- [ ] **Step 1: Write the failing tests** `src/lib/server/github-release.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { customModuleId, parseGithubRepo, pickAsset, safeTag, type GithubAsset } from './github-release';

function asset(name: string): GithubAsset {
    return { name, size: 1, browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`, digest: null, content_type: 'application/java-archive' };
}

describe('parseGithubRepo', () => {
    it('accepts owner/repo and GitHub URLs', () => {
        expect(parseGithubRepo('IONNetworkTeam/IONMod')).toBe('IONNetworkTeam/IONMod');
        expect(parseGithubRepo('https://github.com/IONNetworkTeam/IONMod')).toBe('IONNetworkTeam/IONMod');
        expect(parseGithubRepo('https://github.com/IONNetworkTeam/IONMod.git')).toBe('IONNetworkTeam/IONMod');
        expect(parseGithubRepo('https://github.com/IONNetworkTeam/IONMod/releases/tag/v1.0')).toBe('IONNetworkTeam/IONMod');
        expect(parseGithubRepo(' www.github.com/a/b.c ')).toBe('a/b.c');
    });
    it('rejects anything else', () => {
        for (const bad of ['', 'IONMod', 'https://modrinth.com/mod/sodium', 'a/b/c', '-a/b']) {
            expect(() => parseGithubRepo(bad), bad).toThrow();
        }
    });
});

describe('pickAsset', () => {
    it('skips sources, dev, javadoc and api jars by default', () => {
        const assets = [asset('ionmod-1.0-sources.jar'), asset('ionmod-1.0-dev.jar'), asset('ionmod-1.0-api.jar'), asset('ionmod-1.0.jar'), asset('ionmod-1.0.zip')];
        expect(pickAsset(assets)?.name).toBe('ionmod-1.0.jar');
    });
    it('returns null when nothing matches', () => {
        expect(pickAsset([asset('ionmod-1.0-sources.jar')])).toBeNull();
        expect(pickAsset([])).toBeNull();
    });
    it('honours a custom pattern', () => {
        const assets = [asset('ionmod-fabric-1.0.jar'), asset('ionmod-forge-1.0.jar')];
        expect(pickAsset(assets, 'forge')?.name).toBe('ionmod-forge-1.0.jar');
    });
    it('rejects an invalid pattern', () => {
        expect(() => pickAsset([asset('a.jar')], '(')).toThrow();
    });
});

describe('module ids', () => {
    it('keeps tags Maven-safe', () => {
        expect(safeTag('v1.2.3+build.4')).toBe('v1.2.3+build.4');
        expect(safeTag('release/2026 beta:1@x')).toBe('release-2026-beta-1-x');
    });
    it('builds a stable group and artifact per repository', () => {
        expect(customModuleId('IONNetworkTeam/IONMod', 'v1.4.0')).toBe('ion.github.IONNetworkTeam:IONMod:v1.4.0@jar');
    });
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.

- [ ] **Step 3: Implement** `src/lib/server/github-release.ts`

```ts
import { badRequest } from './http';

/** The parts of a GitHub release asset the Manager and the launcher use. */
export interface GithubAsset {
    name: string;
    size: number;
    browser_download_url: string;
    /** `"sha256:<hex>"` on newer uploads, otherwise `null`. */
    digest: string | null;
    content_type: string;
}

export interface GithubRelease {
    tag_name: string;
    name: string | null;
    draft: boolean;
    prerelease: boolean;
    published_at: string;
    html_url: string;
    assets: GithubAsset[];
}

/** First `.jar` that isn't a sources / dev / javadoc / api / shadow artifact. Shared with the launcher. */
export const DEFAULT_ASSET_PATTERN = '^(?!.*(?:-sources|-dev|-javadoc|-api|-shadow)\\b).*\\.jar$';

const REPO_RE = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/.*)?$/;

/** `owner/repo` from a bare pair or any github.com URL of the repository. */
export function parseGithubRepo(input: string): string {
    const value = input.trim();
    const m = REPO_RE.exec(value);
    if (!m || (!/^https?:\/\//.test(value) && !/^(www\.)?github\.com\//.test(value) && value.split('/').length !== 2)) {
        throw badRequest('Enter a GitHub repository as owner/repo or https://github.com/owner/repo');
    }
    return `${m[1]}/${m[2]}`;
}

export function repoUrl(repo: string): string {
    return `https://github.com/${repo}`;
}

/** Tags end up in Maven ids and paths, which Helios splits on `:` and `@`. */
export function safeTag(tag: string): string {
    return tag.replace(/[^A-Za-z0-9._+-]/g, '-');
}

/** `ion.github.<owner>:<repo>:<tag>@jar`: versionless part is stable, so launcher mod settings follow the mod across releases. */
export function customModuleId(repo: string, tag: string): string {
    const [owner, name] = repo.split('/');
    return `ion.github.${owner}:${name}:${safeTag(tag)}@jar`;
}

export function pickAsset(assets: GithubAsset[], pattern?: string | null): GithubAsset | null {
    let re: RegExp;
    try {
        re = new RegExp(pattern || DEFAULT_ASSET_PATTERN, 'i');
    } catch {
        throw badRequest('The asset pattern is not a valid regular expression');
    }
    return assets.find(a => re.test(a.name)) ?? null;
}
```

Note: `./http` imports only `@sveltejs/kit`'s `json`, which vitest resolves fine.

- [ ] **Step 4: Run** `pnpm test` → passes. If `parseGithubRepo('a/b/c')` passes unexpectedly, the regex's lazy repo group swallowed it; the `split('/').length !== 2` guard above is what rejects bare three-segment input, keep it.

- [ ] **Step 5: Add the token setting**

`src/lib/server/env.ts`: add `GITHUB_TOKEN?: string;` to `Config` and `export const GITHUB_TOKEN = get('GITHUB_TOKEN', '');` after `MODRINTH_API_KEY`.

`src/routes/api/status/+server.ts`: import `GITHUB_TOKEN` and add `GITHUB_TOKEN: GITHUB_TOKEN ? 'set' : 'not set'` to `config`.

`src/routes/settings/+page.svelte` line 32, add after the Modrinth row:

```ts
		{ key: 'GITHUB_TOKEN', description: 'GitHub token (optional; raises the API rate limit when resolving custom mods)' },
```

`README.md` config table, add after `MODRINTH_API_KEY`:

```
| `GITHUB_TOKEN`       | Optional. Raises GitHub's API rate limit when resolving custom (GitHub release) mods     |
```

- [ ] **Step 6: Implement the client** `src/lib/server/github.ts`

```ts
import { GITHUB_TOKEN } from './env';
import { HttpError } from './http';
import type { GithubRelease } from './github-release';

const API = 'https://api.github.com';

function headers(): Record<string, string> {
    const h: Record<string, string> = {
        'User-Agent': 'IONLauncherManager/1.0',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
    return h;
}

async function request<T>(path: string, what: string): Promise<T> {
    const res = await fetch(`${API}${path}`, { headers: headers() });
    if (res.status === 404) throw new HttpError(404, `GitHub ${what} not found`);
    if (res.status === 403 || res.status === 429) {
        throw new HttpError(502, 'GitHub API rate limit exceeded; set GITHUB_TOKEN or try again later');
    }
    if (!res.ok) throw new HttpError(502, `GitHub ${what} request failed: ${res.status}`);
    return res.json() as Promise<T>;
}

/**
 * Newest release of a repository. GitHub's `latest` excludes pre-releases and drafts; with
 * `includePrerelease` the newest non-draft release of any kind is used instead.
 */
export async function getLatestRelease(repo: string, includePrerelease: boolean): Promise<GithubRelease> {
    if (!includePrerelease) return request(`/repos/${repo}/releases/latest`, 'release');
    const releases = await request<GithubRelease[]>(`/repos/${repo}/releases?per_page=10`, 'releases');
    const release = releases.find(r => !r.draft);
    if (!release) throw new HttpError(404, `${repo} has no releases`);
    return release;
}

export async function downloadAsset(url: string): Promise<Uint8Array> {
    const res = await fetch(url, { headers: { 'User-Agent': 'IONLauncherManager/1.0' } });
    if (!res.ok) throw new HttpError(502, `GitHub asset download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}
```

- [ ] **Step 7: Verify** `pnpm check`, `pnpm test` → pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/github-release.ts src/lib/server/github-release.test.ts src/lib/server/github.ts src/lib/server/env.ts src/routes/api/status/+server.ts src/routes/settings/+page.svelte
git add -p README.md   # stage only the GITHUB_TOKEN row; the disabled-server note is foreign work
git commit -m "Add a GitHub releases client and asset selection for custom mods" -m "Pure helpers (repo parsing, asset pattern, Maven-safe module ids) are separate from the API client so they can be tested and mirrored in the launcher." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Custom (GitHub) mods store and API

**Files:**
- Create: `[M]/src/lib/server/custom-mods.ts`
- Create: `[M]/src/routes/api/servers/[serverId]/custom-mods/+server.ts`
- Create: `[M]/src/routes/api/servers/[serverId]/custom-mods/[modId]/+server.ts`
- Create: `[M]/src/routes/api/servers/[serverId]/custom-mods/[modId]/resolve/+server.ts`

**Interfaces:**
- Consumes: `parseGithubRepo`, `pickAsset`, `getLatestRelease`, `downloadAsset` (Task 6); `validateCategory` from `./mods`; `readServerMeta`, `getModLoader`, `getServerDir` from `./nebula`.
- Produces:
  - `listCustomMods(serverId): Promise<CustomMod[]>`
  - `addCustomMod(serverId, input: Record<string, unknown>): Promise<CustomMod>`
  - `updateCustomMod(serverId, id, patch: Record<string, unknown>): Promise<CustomMod>`
  - `deleteCustomMod(serverId, id): Promise<void>`
  - `resolveCustomMod(serverId, id): Promise<CustomMod>` (force re-resolve one)
  - `refreshCustomMods(serverId): Promise<CustomMod[]>` (re-resolve all, errors recorded per mod)
  - `resolveRelease(mod: CustomMod): Promise<CustomMod>` (no storage)
  - Routes: `GET/POST /api/servers/:id/custom-mods`, `PATCH/DELETE /api/servers/:id/custom-mods/:modId`, `POST /api/servers/:id/custom-mods/:modId/resolve`. POST body `{ repo: string; name?: string; category?: ModCategory; assetPattern?: string; prerelease?: boolean }`. PATCH body: any subset of `name, category, assetPattern, prerelease`.

- [ ] **Step 1: Implement** `src/lib/server/custom-mods.ts`

```ts
import { readFile, writeFile, rename } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { getServerDir, getModLoader, readServerMeta } from './nebula';
import { validateCategory } from './mods';
import { badRequest, conflict, notFound } from './http';
import { parseGithubRepo, pickAsset } from './github-release';
import { downloadAsset, getLatestRelease } from './github';
import type { CustomMod } from '$lib/types/mods';

/**
 * "Custom mods": mods the launcher downloads from a GitHub repository's newest release
 * instead of from ION or a mod platform. Meant for ION's own mods. Stored per server in
 * custom-mods.json; the distribution post-processor turns them into modules.
 */
const CUSTOM_MODS_FILE = 'custom-mods.json';

function getPath(serverId: string): string {
    return join(getServerDir(serverId), CUSTOM_MODS_FILE);
}

export async function listCustomMods(serverId: string): Promise<CustomMod[]> {
    try {
        const data = JSON.parse(await readFile(getPath(serverId), 'utf-8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

async function save(serverId: string, mods: CustomMod[]): Promise<void> {
    const path = getPath(serverId);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(mods, null, 2));
    await rename(tmp, path);
}

function optionalPattern(value: unknown): string | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw badRequest('assetPattern must be a string');
    pickAsset([], value); // validates the regular expression
    return value;
}

/**
 * Look up the newest release and remember the asset the launcher should download.
 * Downloads the asset once to compute the MD5 Helios validates with; a release that was
 * already resolved keeps its hash. Failures are recorded in `resolveError`, not thrown,
 * so one broken repository never blocks the others or the distribution.
 */
export async function resolveRelease(mod: CustomMod): Promise<CustomMod> {
    try {
        const release = await getLatestRelease(mod.repo, mod.prerelease);
        const asset = pickAsset(release.assets, mod.assetPattern);
        if (!asset) throw new Error(`No asset of ${release.tag_name} matches ${mod.assetPattern ?? 'the default jar pattern'}`);

        let md5 = mod.resolved?.url === asset.browser_download_url ? mod.resolved.md5 : null;
        let size = asset.size;
        if (md5 === null) {
            const data = await downloadAsset(asset.browser_download_url);
            md5 = createHash('md5').update(data).digest('hex');
            size = data.byteLength;
        }
        const digest = asset.digest ?? null;
        return {
            ...mod,
            resolved: {
                tag: release.tag_name,
                assetName: asset.name,
                url: asset.browser_download_url,
                size,
                md5,
                sha256: digest && digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null,
                publishedAt: release.published_at,
                resolvedAt: new Date().toISOString()
            },
            resolveError: null
        };
    } catch (err) {
        return { ...mod, resolveError: err instanceof Error ? err.message : String(err) };
    }
}

export async function addCustomMod(serverId: string, input: Record<string, unknown>): Promise<CustomMod> {
    const meta = await readServerMeta(serverId);
    if (!getModLoader(meta)) throw badRequest('Custom mods need a Forge or Fabric server');
    if (typeof input.repo !== 'string') throw badRequest('repo is required');

    const repo = parseGithubRepo(input.repo);
    const id = repo.toLowerCase().replace('/', '-');
    const mods = await listCustomMods(serverId);
    if (mods.some(m => m.id === id)) throw conflict(`${repo} is already added to this server`);

    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : repo.split('/')[1];
    const mod: CustomMod = {
        id,
        name,
        repo,
        category: validateCategory(input.category ?? 'required'),
        assetPattern: optionalPattern(input.assetPattern),
        prerelease: !!input.prerelease,
        addedDate: new Date().toISOString(),
        resolved: null,
        resolveError: null
    };
    const resolved = await resolveRelease(mod);
    mods.push(resolved);
    await save(serverId, mods);
    return resolved;
}

export async function updateCustomMod(serverId: string, id: string, patch: Record<string, unknown>): Promise<CustomMod> {
    const mods = await listCustomMods(serverId);
    const index = mods.findIndex(m => m.id === id);
    if (index === -1) throw notFound('Custom mod not found');

    let mod = mods[index];
    let reresolve = false;
    if (typeof patch.name === 'string' && patch.name.trim()) mod = { ...mod, name: patch.name.trim() };
    if (patch.category !== undefined) mod = { ...mod, category: validateCategory(patch.category) };
    if (patch.assetPattern !== undefined) {
        mod = { ...mod, assetPattern: optionalPattern(patch.assetPattern) };
        reresolve = true;
    }
    if (patch.prerelease !== undefined) {
        mod = { ...mod, prerelease: !!patch.prerelease };
        reresolve = true;
    }
    if (reresolve) mod = await resolveRelease(mod);

    mods[index] = mod;
    await save(serverId, mods);
    return mod;
}

export async function deleteCustomMod(serverId: string, id: string): Promise<void> {
    const mods = await listCustomMods(serverId);
    const remaining = mods.filter(m => m.id !== id);
    if (remaining.length === mods.length) throw notFound('Custom mod not found');
    await save(serverId, remaining);
}

export async function resolveCustomMod(serverId: string, id: string): Promise<CustomMod> {
    const mods = await listCustomMods(serverId);
    const index = mods.findIndex(m => m.id === id);
    if (index === -1) throw notFound('Custom mod not found');
    mods[index] = await resolveRelease(mods[index]);
    await save(serverId, mods);
    return mods[index];
}

/** Re-resolve every custom mod of a server (used before generating the distribution). */
export async function refreshCustomMods(serverId: string): Promise<CustomMod[]> {
    const mods = await listCustomMods(serverId);
    if (mods.length === 0) return mods;
    const refreshed = await Promise.all(mods.map(resolveRelease));
    await save(serverId, refreshed);
    return refreshed;
}
```

- [ ] **Step 2: Routes**

`src/routes/api/servers/[serverId]/custom-mods/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { addCustomMod, listCustomMods } from '$lib/server/custom-mods';
import { errorResponse, readJson } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
    try {
        return json(await listCustomMods(validateServerId(params.serverId)));
    } catch (err) {
        return errorResponse(err, 'Failed to list custom mods');
    }
};

export const POST: RequestHandler = async ({ params, request }) => {
    try {
        const mod = await addCustomMod(validateServerId(params.serverId), await readJson(request));
        return json({ success: true, mod }, { status: 201 });
    } catch (err) {
        return errorResponse(err, 'Failed to add custom mod');
    }
};
```

`src/routes/api/servers/[serverId]/custom-mods/[modId]/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { deleteCustomMod, updateCustomMod } from '$lib/server/custom-mods';
import { errorResponse, readJson } from '$lib/server/http';

export const PATCH: RequestHandler = async ({ params, request }) => {
    try {
        const mod = await updateCustomMod(validateServerId(params.serverId), params.modId, await readJson(request));
        return json({ success: true, mod });
    } catch (err) {
        return errorResponse(err, 'Failed to update custom mod');
    }
};

export const DELETE: RequestHandler = async ({ params }) => {
    try {
        await deleteCustomMod(validateServerId(params.serverId), params.modId);
        return json({ success: true });
    } catch (err) {
        return errorResponse(err, 'Failed to delete custom mod');
    }
};
```

`src/routes/api/servers/[serverId]/custom-mods/[modId]/resolve/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateServerId } from '$lib/server/nebula';
import { resolveCustomMod } from '$lib/server/custom-mods';
import { errorResponse } from '$lib/server/http';

export const POST: RequestHandler = async ({ params }) => {
    try {
        const mod = await resolveCustomMod(validateServerId(params.serverId), params.modId);
        return json({ success: true, mod });
    } catch (err) {
        return errorResponse(err, 'Failed to check the GitHub release');
    }
};
```

- [ ] **Step 3: Verify** `pnpm check`, `pnpm test`. With the dev server and a Forge/Fabric server:

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"repo":"https://github.com/IrisShaders/Iris"}' localhost:5173/api/servers/<serverId>/custom-mods
```

Expected: 201 with `mod.resolved.tag`, `assetName` ending in `.jar`, a 32-hex `md5`, and `custom-mods.json` written in the server directory. A second identical POST → 409.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/custom-mods.ts "src/routes/api/servers/[serverId]/custom-mods"
git commit -m "Add custom mods that the launcher downloads from GitHub releases" -m "Stored per server in custom-mods.json with the resolved newest release (asset, size, MD5) so the distribution can embed a fallback the launcher uses when GitHub is unreachable." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Post-process `distribution.json` after Nebula

**Files:**
- Create: `[M]/src/lib/server/distro-postprocess.ts` (pure)
- Create: `[M]/src/lib/server/distro-postprocess.test.ts`
- Modify: `[M]/src/routes/api/distro/generate/+server.ts:19-46`
- Modify: `[M]/README.md` (Notes section)

**Interfaces:**
- Consumes: `resolvePolicy` (Task 2), `customModuleId`, `repoUrl` (Task 6), types from Task 1.
- Produces:
  - `parseModUrl(url: string, baseUrl: string): { serverId; category; filename; relativePath } | null`
  - `annotateModule(module: DistroModule, entry: TrackedMod | undefined, policy: ModPolicy, loc: ModLocation, label: string): { warning?: string; privatePath?: string }`
  - `customModToModule(mod: CustomMod, loader: ModLoader): DistroModule | null`
  - `applyIonMetadata(distro: Distribution, ctx: PostProcessContext): Promise<PostProcessResult>` where `PostProcessContext = { baseUrl: string; loadServer(serverId): Promise<ServerPolicyData | null> }`, `ServerPolicyData = { loader: ModLoader | null; entries: ModMetadataEntry[]; overrides: PolicyOverrides; customMods: CustomMod[] }`, `PostProcessResult = { warnings: string[]; privatePaths: string[] }`.
  - `POST /api/distro/generate` response gains the post-processing warnings; `NEBULA_ROOT/meta/ion-private-paths.txt` is written.

- [ ] **Step 1: Write the failing tests** `src/lib/server/distro-postprocess.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import type { Distribution, DistroModule } from '$lib/types/distro';
import type { CustomMod } from '$lib/types/mods';
import type { ModMetadataEntry } from './mod-metadata';
import { applyIonMetadata, customModToModule, parseModUrl } from './distro-postprocess';

const BASE = 'https://launcher.ionnet.work';

function mod(name: string, filename: string, category = 'required'): DistroModule {
    return {
        id: `generated.forgemod:${name}:1.0@jar`,
        name,
        type: 'ForgeMod',
        artifact: { size: 10, MD5: 'd41d8cd98f00b204e9800998ecf8427e', url: `${BASE}/servers/smp-1.20.1/forgemods/${category}/${encodeURIComponent(filename)}` }
    };
}

function entry(filename: string, extra: Partial<ModMetadataEntry>): ModMetadataEntry {
    return { filename, installedDate: '2026-10-03T00:00:00.000Z', source: 'modrinth', projectId: 'p', versionId: 'v', ...extra };
}

const customMod: CustomMod = {
    id: 'ionnetworkteam-ionmod', name: 'ION Mod', repo: 'IONNetworkTeam/IONMod', category: 'optionalon', assetPattern: null, prerelease: false,
    addedDate: '2026-10-03T00:00:00.000Z', resolveError: null,
    resolved: { tag: 'v1.4.0', assetName: 'ionmod-1.4.0.jar', url: 'https://github.com/IONNetworkTeam/IONMod/releases/download/v1.4.0/ionmod-1.4.0.jar', size: 4321, md5: 'abc', sha256: 'def', publishedAt: '2026-10-01T00:00:00.000Z', resolvedAt: '2026-10-03T00:00:00.000Z' }
};

describe('parseModUrl', () => {
    it('decodes Nebula mod URLs', () => {
        expect(parseModUrl(`${BASE}/servers/smp-1.20.1/fabricmods/optionaloff/Some%20Mod%2B1.0.jar`, BASE)).toEqual({
            serverId: 'smp-1.20.1', category: 'optionaloff', filename: 'Some Mod+1.0.jar', relativePath: 'servers/smp-1.20.1/fabricmods/optionaloff/Some Mod+1.0.jar'
        });
    });
    it('handles a base URL with a path prefix and ignores other files', () => {
        expect(parseModUrl('https://cdn.example/dist/servers/a-1.0/forgemods/required/x.jar', 'https://cdn.example/dist/')?.filename).toBe('x.jar');
        expect(parseModUrl(`${BASE}/servers/a-1.0/files/config/x.toml`, BASE)).toBeNull();
        expect(parseModUrl('https://cdn.modrinth.com/x.jar', BASE)).toBeNull();
    });
});

describe('applyIonMetadata', () => {
    const distro = (): Distribution => ({
        version: '1.0.0', rss: '', servers: [{ id: 'smp-1.20.1', name: 'SMP', minecraftVersion: '1.20.1', modules: [
            mod('Sodium', 'sodium-1.0.jar'),
            mod('Shaders', 'shaders-1.0.jar'),
            mod('Blocked', 'blocked-1.0.jar', 'optionalon'),
            mod('Mystery', 'mystery-1.0.jar'),
            { id: 'net.fabricmc:fabric-loader:0.15.0', name: 'Fabric', type: 'Fabric', artifact: { size: 1, url: `${BASE}/x` } }
        ] }]
    });
    const entries = [
        entry('sodium-1.0.jar', { projectId: 'AANobbMI', license: { id: 'LGPL-3.0-only' }, downloadUrl: 'https://cdn.modrinth.com/sodium.jar', projectUrl: 'https://modrinth.com/mod/sodium' }),
        entry('shaders-1.0.jar', { projectId: 'arr', license: { id: 'LicenseRef-All-Rights-Reserved' }, downloadUrl: 'https://cdn.modrinth.com/shaders.jar' }),
        entry('blocked-1.0.jar', { source: 'curseforge', projectId: '1', versionId: '2', license: null, distributionAllowed: false, downloadUrl: null, pageUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked/download/2' })
    ];
    const ctx = (overrides = {}, customMods: CustomMod[] = []) => ({
        baseUrl: BASE,
        loadServer: async (id: string) => (id === 'smp-1.20.1' ? { loader: 'fabric' as const, entries, overrides, customMods } : null)
    });

    it('annotates modules by policy and rewrites URLs', async () => {
        const d = distro();
        const result = await applyIonMetadata(d, ctx());
        const [sodium, shaders, blocked, mystery, loader] = d.servers[0].modules;

        expect(sodium.ion).toMatchObject({ source: 'modrinth', download: 'hosted', projectUrl: 'https://modrinth.com/mod/sodium', license: { id: 'LGPL-3.0-only' } });
        expect(sodium.artifact.url).toContain('/servers/smp-1.20.1/forgemods/required/');

        expect(shaders.ion?.download).toBe('direct');
        expect(shaders.artifact.url).toBe('https://cdn.modrinth.com/shaders.jar');
        expect(shaders.artifact.MD5).toBe('d41d8cd98f00b204e9800998ecf8427e');

        expect(blocked.ion?.download).toBe('manual');
        expect(blocked.ion?.manual).toEqual({ pageUrl: 'https://www.curseforge.com/minecraft/mc-mods/blocked/download/2', fileName: 'blocked-1.0.jar' });
        expect(blocked.artifact.url).toBe('https://www.curseforge.com/minecraft/mc-mods/blocked/download/2');

        expect(mystery.ion).toBeUndefined();
        expect(loader.ion).toBeUndefined();

        expect(result.warnings).toEqual([expect.stringContaining('mystery-1.0.jar')]);
        expect(result.privatePaths).toEqual([
            'servers/smp-1.20.1/forgemods/required/shaders-1.0.jar',
            'servers/smp-1.20.1/forgemods/optionalon/blocked-1.0.jar'
        ]);
    });

    it('applies overrides and falls back to hosted when a URL is missing', async () => {
        const d = distro();
        const result = await applyIonMetadata(d, ctx({
            'modrinth:AANobbMI': { mode: 'manual', reviewedAt: 'x' }, // no pageUrl recorded, so projectUrl is the download page
            'file:mystery-1.0.jar': { mode: 'hosted', note: 'ours', reviewedAt: 'x' }
        }));
        const [sodium, , , mystery] = d.servers[0].modules;
        expect(sodium.ion?.download).toBe('manual');
        expect(sodium.ion?.manual?.pageUrl).toBe('https://modrinth.com/mod/sodium');
        expect(mystery.ion).toBeUndefined();
        expect(result.warnings).toEqual([]); // overridden unmatched jar no longer warns
    });

    it('appends resolved custom mods and warns about unresolved ones', async () => {
        const d = distro();
        const broken: CustomMod = { ...customMod, id: 'x-y', repo: 'x/y', name: 'Broken', resolved: null, resolveError: 'No asset matches' };
        const result = await applyIonMetadata(d, ctx({}, [customMod, broken]));
        const added = d.servers[0].modules.at(-1)!;
        expect(added).toMatchObject({
            id: 'ion.github.IONNetworkTeam:IONMod:v1.4.0@jar', name: 'ION Mod', type: 'FabricMod', required: { value: false },
            artifact: { size: 4321, MD5: 'abc', url: customMod.resolved!.url },
            ion: { source: 'github', download: 'direct', projectUrl: 'https://github.com/IONNetworkTeam/IONMod', github: { repo: 'IONNetworkTeam/IONMod', tag: 'v1.4.0', sha256: 'def', prerelease: false, assetPattern: null } }
        });
        expect(result.warnings.some(w => w.includes('Broken') && w.includes('No asset matches'))).toBe(true);
    });

    it('maps categories to Helios required flags and omits a null MD5', () => {
        expect(customModToModule({ ...customMod, category: 'required' }, 'forge')).toMatchObject({ type: 'ForgeMod' });
        expect(customModToModule({ ...customMod, category: 'required' }, 'forge')!.required).toBeUndefined();
        expect(customModToModule({ ...customMod, category: 'optionaloff' }, 'forge')!.required).toEqual({ value: false, def: false });
        const noMd5 = customModToModule({ ...customMod, resolved: { ...customMod.resolved!, md5: null } }, 'fabric')!;
        expect('MD5' in noMd5.artifact).toBe(false);
        expect(customModToModule({ ...customMod, resolved: null }, 'fabric')).toBeNull();
    });
});
```

- [ ] **Step 2: Run** `pnpm test` → FAIL.

- [ ] **Step 3: Implement** `src/lib/server/distro-postprocess.ts`

```ts
import type { Distribution, DistroModule, IonModuleMeta } from '$lib/types/distro';
import type { CustomMod, ModCategory, ModLoader, ModPolicy, TrackedMod } from '$lib/types/mods';
import type { ModMetadataEntry } from './mod-metadata';
import type { PolicyOverrides } from './mod-policy';
import { resolvePolicy } from './license-policy';
import { customModuleId, repoUrl } from './github-release';

/**
 * Adds ION's `ion` field to the modules Nebula generated and appends GitHub custom mods.
 * Pure: everything it needs is handed in through the context, so it is unit-testable and
 * never touches the filesystem itself. See the IONLauncher spec for the contract.
 */

export interface ServerPolicyData {
    loader: ModLoader | null;
    entries: ModMetadataEntry[];
    overrides: PolicyOverrides;
    customMods: CustomMod[];
}

export interface PostProcessContext {
    baseUrl: string;
    /** `null` when the server is unknown to the Manager (left untouched). */
    loadServer(serverId: string): Promise<ServerPolicyData | null>;
}

export interface PostProcessResult {
    warnings: string[];
    /** Paths below NEBULA_ROOT that should not be served publicly (direct / manual mods). */
    privatePaths: string[];
}

export interface ModLocation {
    serverId: string;
    category: ModCategory;
    filename: string;
    relativePath: string;
}

const MOD_URL_RE = /^\/servers\/([^/]+)\/(forgemods|fabricmods)\/(required|optionalon|optionaloff)\/([^/]+)$/;

/** Same as mod-metadata's toTrackedMod, repeated here so this module stays free of filesystem imports. */
function toTracked(entry: ModMetadataEntry): TrackedMod {
    const { filename: _filename, installedDate: _installedDate, ...tracked } = entry;
    return tracked;
}

export function parseModUrl(url: string, baseUrl: string): ModLocation | null {
    let target: URL;
    let base: URL;
    try {
        target = new URL(url);
        base = new URL(baseUrl);
    } catch {
        return null;
    }
    if (target.origin !== base.origin) return null;
    const prefix = base.pathname.replace(/\/$/, '');
    const pathname = prefix && target.pathname.startsWith(prefix) ? target.pathname.slice(prefix.length) : target.pathname;
    const m = MOD_URL_RE.exec(pathname);
    if (!m) return null;
    const serverId = decodeURIComponent(m[1]);
    const filename = decodeURIComponent(m[4]);
    return {
        serverId,
        category: m[3] as ModCategory,
        filename,
        relativePath: `servers/${serverId}/${m[2]}/${m[3]}/${filename}`
    };
}

export function annotateModule(
    module: DistroModule,
    entry: TrackedMod | undefined,
    policy: ModPolicy,
    loc: ModLocation,
    label: string
): { warning?: string; privatePath?: string } {
    if (!entry) {
        if (policy.override) return {};
        return { warning: `${label}: ${loc.filename} is not matched to Modrinth or CurseForge, so its license is unknown. It is hosted as-is; match it or override it on the Licenses tab.` };
    }

    const ion: IonModuleMeta = {
        source: entry.source,
        download: policy.effective ?? 'hosted',
        projectUrl: entry.projectUrl,
        license: entry.license ?? null
    };
    let warning: string | undefined;

    if (ion.download === 'direct') {
        if (entry.downloadUrl) {
            module.artifact.url = entry.downloadUrl;
        } else {
            ion.download = 'hosted';
            warning = `${label}: ${loc.filename} should be downloaded from its platform, but no download URL is known. Hosted instead; re-check licenses.`;
        }
    } else if (ion.download === 'manual') {
        const pageUrl = entry.pageUrl ?? entry.projectUrl;
        if (pageUrl) {
            ion.manual = { pageUrl, fileName: loc.filename };
            module.artifact.url = pageUrl;
        } else {
            ion.download = 'hosted';
            warning = `${label}: ${loc.filename} needs a manual download, but no download page is known. Hosted instead; re-check licenses.`;
        }
    }

    module.ion = ion;
    return { warning, privatePath: ion.download === 'hosted' ? undefined : loc.relativePath };
}

export function customModToModule(mod: CustomMod, loader: ModLoader): DistroModule | null {
    const resolved = mod.resolved;
    if (!resolved) return null;
    const module: DistroModule = {
        id: customModuleId(mod.repo, resolved.tag),
        name: mod.name,
        type: loader === 'forge' ? 'ForgeMod' : 'FabricMod',
        artifact: { size: resolved.size, url: resolved.url },
        ion: {
            source: 'github',
            download: 'direct',
            projectUrl: repoUrl(mod.repo),
            github: { repo: mod.repo, assetPattern: mod.assetPattern, prerelease: mod.prerelease, tag: resolved.tag, sha256: resolved.sha256 }
        }
    };
    if (resolved.md5) module.artifact.MD5 = resolved.md5;
    if (mod.category === 'optionalon') module.required = { value: false };
    if (mod.category === 'optionaloff') module.required = { value: false, def: false };
    return module;
}

export async function applyIonMetadata(distro: Distribution, ctx: PostProcessContext): Promise<PostProcessResult> {
    const warnings: string[] = [];
    const privatePaths: string[] = [];

    for (const server of distro.servers ?? []) {
        const data = await ctx.loadServer(server.id);
        if (!data) continue;
        const byFilename = new Map(data.entries.map(e => [e.filename, e]));

        for (const module of server.modules ?? []) {
            if (module.type !== 'ForgeMod' && module.type !== 'FabricMod') continue;
            const loc = parseModUrl(module.artifact.url, ctx.baseUrl);
            if (!loc || loc.serverId !== server.id) continue;
            const entry = byFilename.get(loc.filename);
            const tracked = entry ? toTracked(entry) : undefined;
            const policy = resolvePolicy(loc.filename, tracked, data.overrides);
            const result = annotateModule(module, tracked, policy, loc, server.id);
            if (result.warning) warnings.push(result.warning);
            if (result.privatePath) privatePaths.push(result.privatePath);
        }

        if (data.customMods.length > 0 && !data.loader) {
            warnings.push(`${server.id}: custom GitHub mods need a Forge or Fabric server; they were left out.`);
        } else {
            for (const mod of data.customMods) {
                const module = data.loader ? customModToModule(mod, data.loader) : null;
                if (!module) {
                    warnings.push(`${server.id}: custom mod ${mod.name} (${mod.repo}) has no resolved GitHub release${mod.resolveError ? `: ${mod.resolveError}` : ''}. Left out.`);
                    continue;
                }
                server.modules.push(module);
            }
        }
    }

    return { warnings, privatePaths };
}
```

- [ ] **Step 4: Run** `pnpm test` → passes. (If the override test's `sodium` expectation fails because `pageUrl` is undefined in that fixture: the entry has `projectUrl`, and `annotateModule` falls back to it; that is intended.)

- [ ] **Step 5: Hook into the generate route**

Rewrite `src/routes/api/distro/generate/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { generateDistro, describeFailure } from '$lib/server/nebula-cli';
import { BASE_URL, NEBULA_ROOT } from '$lib/server/env';
import { errorResponse } from '$lib/server/http';
import { getModLoader, listServers, readServerMeta } from '$lib/server/nebula';
import { getModMetadata } from '$lib/server/mod-metadata';
import { getPolicyOverrides } from '$lib/server/mod-policy';
import { refreshCustomMods } from '$lib/server/custom-mods';
import { applyIonMetadata, type PostProcessContext } from '$lib/server/distro-postprocess';
import type { Distribution } from '$lib/types/distro';

async function modifiedSince(path: string, since: number): Promise<boolean> {
    try {
        return (await stat(path)).mtimeMs >= since;
    } catch {
        return false;
    }
}

function postProcessContext(): PostProcessContext {
    return {
        baseUrl: BASE_URL,
        loadServer: async serverId => {
            let meta;
            try {
                meta = await readServerMeta(serverId);
            } catch {
                return null;
            }
            const [entries, overrides, customMods] = await Promise.all([
                getModMetadata(serverId),
                getPolicyOverrides(serverId),
                refreshCustomMods(serverId)
            ]);
            return { loader: getModLoader(meta), entries, overrides, customMods };
        }
    };
}

export const POST: RequestHandler = async () => {
    try {
        // Filesystem mtimes can be coarser than Date.now(), so allow a little slack.
        const startedAt = Date.now() - 2000;
        const result = await generateDistro();

        // Nebula exits 0 even when generation fails, and it also logs non-fatal
        // per-mod problems (e.g. "Claritas failed to yield metadata") at error
        // level. So judge success by whether distribution.json was written, and
        // pass any logged errors on as warnings.
        const distroPath = join(NEBULA_ROOT, 'distribution.json');
        const written = await modifiedSince(distroPath, startedAt);
        if (result.exitCode !== 0 || !written) {
            return json({
                error: describeFailure(result, 'Distribution generation failed'),
                stdout: result.stdout,
                stderr: result.stderr
            }, { status: 500 });
        }

        // Nebula can't express download policies or GitHub mods; add them to its output.
        const distro: Distribution = JSON.parse(await readFile(distroPath, 'utf-8'));
        const post = await applyIonMetadata(distro, postProcessContext());
        // Nebula writes it with 2-space indentation; keep it that way.
        await writeFile(distroPath, JSON.stringify(distro, null, 2));
        await mkdir(join(NEBULA_ROOT, 'meta'), { recursive: true });
        await writeFile(join(NEBULA_ROOT, 'meta', 'ion-private-paths.txt'), post.privatePaths.map(p => `${p}\n`).join(''));

        // Nebula happily builds servers Helios can't launch properly (e.g. Forge 1.20.3+), so flag them.
        const heliosWarnings = (await listServers())
            .filter(server => server.enabled && server.heliosIssue)
            .map(server => `${server.id}: ${server.heliosIssue}`);

        return json({ success: true, warnings: [...heliosWarnings, ...post.warnings, ...result.errors], stdout: result.stdout });
    } catch (err) {
        return errorResponse(err, 'Failed to generate distribution');
    }
};
```

- [ ] **Step 6: Document in `README.md`** (Notes list, after the mod-metadata note):

```
- Each mod gets a **download mode** from its license (see the Licenses tab): `hosted` (ION serves it), `direct`
  (the launcher fetches it from Modrinth / CurseForge / GitHub) or `manual` (players download it from the mod page;
  CurseForge mods whose authors block third-party downloads). Admin overrides live in `servers/<id>/mod-policy.json`.
  Generating the distribution adds an `ion` field per module and rewrites the artifact URLs accordingly. Jars that
  are `direct` or `manual` still exist under `NEBULA_ROOT` (Nebula needs them); their paths are listed in
  `meta/ion-private-paths.txt` so you can deny them in your file server.
- **Custom mods** (`servers/<id>/custom-mods.json`) are GitHub repositories; the launcher downloads the newest
  release jar at launch. The Manager resolves the release when generating, as a fallback for offline launchers.
```

- [ ] **Step 7: Verify** `pnpm check`, `pnpm test`. With the dev server: POST `/api/distro/generate`, then inspect `NEBULA_ROOT/distribution.json` (mod modules carry `ion`, direct ones point at CDN URLs) and `NEBULA_ROOT/meta/ion-private-paths.txt`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/distro-postprocess.ts src/lib/server/distro-postprocess.test.ts src/routes/api/distro/generate/+server.ts
git add -p README.md
git commit -m "Annotate the generated distribution with download modes and GitHub mods" -m "Nebula can't express any of this, so the Manager rewrites distribution.json after generation: an ion field per mod module, CDN URLs for direct mods, download pages for manual mods, GitHub modules appended, and a deny list of jars that must not be served." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Match mods after imports; recover blocked CurseForge mods

**Files:**
- Modify: `[M]/src/lib/server/instance-import.ts:343-374, 384-421`
- Modify: `[M]/README.md` (import note)

**Interfaces:**
- Consumes: `identifyMods` (existing), `describeCurseForge` (Task 4), `trackMod` (Task 3), `listMods`, `uploadMod` from `./mods`, `curseforge.getFiles/getMods/downloadFile/isConfigured`.
- Produces: `ImportResult.serverId` is now set for CurseForge imports too; `warnings` report unmatched counts and recovered blocked mods.

- [ ] **Step 1: Add the helpers to `instance-import.ts`**

Imports to add: `identifyMods` from `./mod-updates`, `describeCurseForge` from `./mod-tracking`, `trackMod` from `./mod-metadata`, `listMods, uploadMod` from `./mods`, `* as curseforge` from `./curseforge`.

```ts
/** Match the imported jars to their platforms so their licenses can be checked; never fatal. */
async function matchImportedMods(serverId: string, warnings: string[]): Promise<void> {
    try {
        const result = await identifyMods(serverId);
        if (result.unmatched.length > 0) {
            warnings.push(`${result.unmatched.length} mod(s) could not be matched to Modrinth or CurseForge. Match them on the Licenses tab so their licenses can be checked.`);
        }
    } catch (err) {
        console.error(`Mod matching failed for ${serverId}:`, err);
        warnings.push('Mod matching failed; use "Match unmatched" on the Mods tab to retry.');
    }
}

interface CurseForgeManifestFile {
    projectID: number;
    fileID: number;
    required?: boolean;
}

/**
 * Nebula skips CurseForge files whose authors block third-party downloads, so the imported
 * pack is missing them. Fetch them here so the pack is complete; their download policy is
 * "manual", so ION never serves them and players get them from CurseForge themselves.
 */
async function recoverBlockedCurseForgeMods(serverId: string, files: CurseForgeManifestFile[], warnings: string[]): Promise<void> {
    if (files.length === 0 || !curseforge.isConfigured()) return;
    try {
        const present = new Set((await listMods(serverId)).map(m => m.filename));
        const infos = await curseforge.getFiles(files.map(f => f.fileID));
        const blocked = infos.filter(f => f.downloadUrl == null && /\.jar$/i.test(f.fileName) && !present.has(f.fileName));
        if (blocked.length === 0) return;

        const requiredById = new Map(files.map(f => [f.fileID, f.required !== false]));
        const mods = await curseforge.getMods([...new Set(blocked.map(f => f.modId))]).catch(() => []);
        const modById = new Map(mods.map(m => [m.id, m]));
        for (const file of blocked) {
            const download = await curseforge.downloadFile(file.modId, file.id);
            const category: ModCategory = requiredById.get(file.id) ? 'required' : 'optionaloff';
            await uploadMod(serverId, category, download.filename, download.data);
            await trackMod(serverId, download.filename, describeCurseForge(file, modById.get(file.modId) ?? null, 'import'));
        }
        warnings.push(`${blocked.length} CurseForge mod(s) block third-party downloads and were added as "manual download": players fetch them from CurseForge themselves.`);
    } catch (err) {
        console.error(`Recovering blocked CurseForge mods failed for ${serverId}:`, err);
        warnings.push('Some CurseForge mods that block third-party downloads could not be added; see the server log.');
    }
}
```

- [ ] **Step 2: Call them**

In `importPrepared`, replace the final `return` with:

```ts
    await matchImportedMods(serverId, warnings);
    return { format, serverId, warnings, stdout: result.stdout };
```

Extend `CurseForgeManifest` with `files?: CurseForgeManifestFile[];` and rewrite `importCurseForgeZip`:

```ts
export async function importCurseForgeZip(id: string, fileName: string, data: Uint8Array): Promise<ImportResult> {
    const zipName = sanitizeZipName(fileName);
    const manifestData = unzip(data, name => name === 'manifest.json')['manifest.json'];
    if (!manifestData) throw badRequest('CurseForge modpack has no manifest.json');
    const manifest = parseJson<CurseForgeManifest>(manifestData, 'manifest.json');
    const versions = resolveCurseForgeVersions(manifest);
    requireCompatible(versions);

    // Nebula's CurseForge parser reads modpacks from ROOT/modpacks/curseforge.
    const modpackDir = join(NEBULA_ROOT, 'modpacks', 'curseforge');
    await mkdir(modpackDir, { recursive: true });
    await writeFile(join(modpackDir, zipName), data);

    const result = await generateServerCurseForge(id, zipName);
    if (result.failed) {
        throw new HttpError(500, describeFailure(result, 'CurseForge import failed'));
    }

    // Nebula names the server <id>-<mcversion>, like generateServer does.
    const serverId = `${id}-${versions.minecraft}`;
    const warnings: string[] = [];
    await recoverBlockedCurseForgeMods(serverId, manifest.files ?? [], warnings);
    await matchImportedMods(serverId, warnings);
    return { format: 'curseforge', serverId, warnings, stdout: result.stdout };
}
```

Update the `ImportResult.serverId` doc comment to `/** Server directory name, <id>-<mcversion>. */` and change the type to `string` (the UI's `string | null` typing still accepts it; keep `string | null` in `InstanceImportModal.svelte` untouched).

- [ ] **Step 3: README** (Notes, the Prism/Modrinth import bullet): append the sentence
  `Imported mods are matched to Modrinth / CurseForge right away; CurseForge mods whose authors block third-party downloads (which Nebula skips) are fetched once and marked "manual download".`

- [ ] **Step 4: Verify** `pnpm check`, `pnpm test`. Import a small `.mrpack` through the UI: the success toast is followed by an info toast with the unmatched count (if any), and `GET .../mods` shows `tracked` on the imported jars.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/instance-import.ts
git add -p README.md
git commit -m "Match imported mods immediately and keep CurseForge opt-out mods" -m "Imports now identify every jar so licenses can be checked at once. CurseForge imports report their server id and add the mods Nebula skipped because their authors block third-party downloads; those are marked for manual download." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Mods tab: policy badges and the manual-match modal

**Files:**
- Create: `[M]/src/lib/components/ModMatchModal.svelte`
- Modify: `[M]/src/lib/components/ModList.svelte`

**Interfaces:**
- Consumes: `GET .../mods` with `policy` (Task 3), `POST .../mods/match` (Task 5), `guessQuery` (Task 5), existing proxy routes `/api/modrinth/search`, `/api/modrinth/project/:id/versions`, `/api/curseforge/search`, `/api/curseforge/mod/:id/files`.
- Produces: `ModMatchModal` props `{ mod: ModInfo | null; serverId: string; mcVersion: string; loader: string | null; onclose: () => void; onmatched: () => void }` (open while `mod` is non-null). `ModList` gains an optional prop `onreview?: () => void` (switch to the Licenses tab).

- [ ] **Step 1: Create `src/lib/components/ModMatchModal.svelte`**

```svelte
<script lang="ts">
	import Modal from './Modal.svelte';
	import { addToast } from './Toast.svelte';
	import { api, errorMessage, jsonBody } from '$lib/api';
	import { guessQuery } from '$lib/mod-names';
	import type { ModInfo, ModSource } from '$lib/types/mods';
	import type { ModrinthSearchResult, ModrinthVersion } from '$lib/types/modrinth';
	import type { CurseForgeSearchResult, CurseForgeFile } from '$lib/types/curseforge';

	let {
		mod,
		serverId,
		mcVersion,
		loader,
		onclose,
		onmatched
	}: {
		mod: ModInfo | null;
		serverId: string;
		mcVersion: string;
		loader: string | null;
		onclose: () => void;
		onmatched: () => void;
	} = $props();

	interface Project {
		id: string;
		name: string;
		icon: string;
		description: string;
	}

	interface Version {
		id: string;
		name: string;
		fileName: string;
		date: string;
	}

	let source = $state<ModSource>('modrinth');
	let query = $state('');
	let results = $state<Project[]>([]);
	let loading = $state(false);
	let searchError = $state<string | null>(null);
	let selected = $state<Project | null>(null);
	let versions = $state<Version[]>([]);
	let loadingVersions = $state(false);
	let allVersions = $state(false);
	let matching = $state<string | null>(null);
	let searchRequest = 0;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// A newly opened modal starts with a search for the file's name.
	$effect(() => {
		if (!mod) return;
		query = guessQuery(mod.filename);
		selected = null;
		versions = [];
		results = [];
		search();
	});

	function filterParams(): URLSearchParams {
		const params = new URLSearchParams();
		if (allVersions) return params;
		if (mcVersion && mcVersion !== 'unknown') params.set('mcVersion', mcVersion);
		if (loader) params.set('loader', loader);
		return params;
	}

	function handleQueryInput() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(), 400);
	}

	async function search() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		const id = ++searchRequest;
		searchError = null;
		if (!q) {
			results = [];
			return;
		}
		loading = true;
		try {
			const params = filterParams();
			params.set('query', q);
			let found: Project[];
			if (source === 'modrinth') {
				const data = await api<ModrinthSearchResult>(`/api/modrinth/search?${params}`);
				found = data.hits.map((p) => ({ id: p.project_id, name: p.title, icon: p.icon_url || '', description: p.description }));
			} else {
				const data = await api<CurseForgeSearchResult>(`/api/curseforge/search?${params}`);
				found = data.data.map((m) => ({ id: String(m.id), name: m.name, icon: m.logo?.thumbnailUrl || '', description: m.summary }));
			}
			if (id !== searchRequest) return;
			results = found;
		} catch (err) {
			if (id !== searchRequest) return;
			results = [];
			searchError = errorMessage(err, 'Search failed');
		} finally {
			if (id === searchRequest) loading = false;
		}
	}

	function switchSource(next: ModSource) {
		if (source === next) return;
		source = next;
		selected = null;
		versions = [];
		search();
	}

	async function selectProject(project: Project) {
		selected = project;
		loadingVersions = true;
		versions = [];
		try {
			const params = filterParams();
			if (source === 'modrinth') {
				const list = await api<ModrinthVersion[]>(`/api/modrinth/project/${encodeURIComponent(project.id)}/versions?${params}`);
				versions = list.map((v) => {
					const file = v.files.find((f) => f.primary) ?? v.files[0];
					return { id: v.id, name: v.version_number, fileName: file?.filename ?? '', date: v.date_published };
				});
			} else {
				const list = await api<CurseForgeFile[]>(`/api/curseforge/mod/${encodeURIComponent(project.id)}/files?${params}`);
				versions = list.map((f) => ({ id: String(f.id), name: f.displayName, fileName: f.fileName, date: f.fileDate }));
			}
			// The version whose file is named exactly like ours is almost certainly the right one.
			const target = mod?.filename.replace(/\.disabled$/i, '');
			versions.sort((a, b) => Number(b.fileName === target) - Number(a.fileName === target));
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to load versions'));
		} finally {
			loadingVersions = false;
		}
	}

	function isExact(version: Version): boolean {
		return !!mod && version.fileName === mod.filename.replace(/\.disabled$/i, '');
	}

	async function match(version: Version) {
		if (!mod || !selected) return;
		matching = version.id;
		try {
			await api(
				`/api/servers/${encodeURIComponent(serverId)}/mods/match`,
				jsonBody({ filename: mod.filename, source, projectId: selected.id, versionId: version.id })
			);
			addToast('success', `Matched ${mod.filename} to ${selected.name} ${version.name}`);
			onmatched();
			onclose();
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to match mod'));
		} finally {
			matching = null;
		}
	}

	function formatDate(date: string): string {
		const d = new Date(date);
		return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
	}
</script>

<Modal open={!!mod} title="Match {mod?.filename ?? ''}" {onclose}>
	<div class="max-h-[70vh] space-y-4 overflow-y-auto">
		<p class="text-xs text-gray-400">
			Hash matching didn't recognise this file. Pick the project and the version it was built from; its license
			is checked from that.
		</p>

		<div class="flex gap-1 rounded-lg bg-gray-900 p-1">
			{#each [['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']] as const as [key, label] (key)}
				<button
					type="button"
					class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition {source === key
						? 'bg-gray-700 text-white'
						: 'text-gray-400 hover:text-gray-200'}"
					onclick={() => switchSource(key)}
				>
					{label}
				</button>
			{/each}
		</div>

		{#if !selected}
			<input
				bind:value={query}
				oninput={handleQueryInput}
				onkeydown={(e) => e.key === 'Enter' && search()}
				placeholder="Search projects..."
				aria-label="Search projects"
				class="w-full rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 text-sm text-white placeholder-gray-400 focus:border-indigo-500 focus:outline-none"
			/>
			{#if loading}
				<p class="text-sm text-gray-400">Searching...</p>
			{:else if searchError}
				<p class="text-sm text-red-400">{searchError}</p>
			{:else if results.length === 0 && query.trim()}
				<p class="text-sm text-gray-500">No results for "{query.trim()}"</p>
			{:else}
				<div class="space-y-2">
					{#each results as project (project.id)}
						<button
							type="button"
							class="flex w-full items-start gap-3 rounded-lg border border-gray-700 p-3 text-left transition hover:border-gray-600 hover:bg-gray-800/50"
							onclick={() => selectProject(project)}
						>
							{#if project.icon}
								<img src={project.icon} alt="" class="h-10 w-10 shrink-0 rounded-lg object-cover" loading="lazy" />
							{:else}
								<div class="h-10 w-10 shrink-0 rounded-lg bg-gray-700"></div>
							{/if}
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium text-white">{project.name}</p>
								<p class="line-clamp-2 text-xs text-gray-400">{project.description}</p>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		{:else}
			<div class="space-y-3">
				<div class="flex items-center justify-between gap-3">
					<button type="button" class="text-sm text-indigo-400 hover:text-indigo-300" onclick={() => (selected = null)}>
						&larr; Back to search
					</button>
					<label class="flex items-center gap-2 text-xs text-gray-400">
						<input type="checkbox" bind:checked={allVersions} onchange={() => selected && selectProject(selected)} />
						Show all versions
					</label>
				</div>
				<h3 class="text-sm font-semibold text-white">{selected.name}</h3>
				{#if loadingVersions}
					<p class="text-sm text-gray-400">Loading versions...</p>
				{:else if versions.length === 0}
					<p class="text-sm text-gray-500">No versions found for this server's Minecraft version and loader.</p>
				{:else}
					<div class="max-h-60 space-y-1 overflow-y-auto">
						{#each versions as version (version.id)}
							<div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 {isExact(version) ? 'border-green-700 bg-green-900/20' : 'border-gray-700'}">
								<div class="min-w-0">
									<p class="truncate text-sm text-gray-200">
										{version.name}
										{#if isExact(version)}
											<span class="ml-1 rounded bg-green-900/60 px-1.5 text-xs text-green-300">same file name</span>
										{/if}
									</p>
									<p class="truncate text-xs text-gray-500" title={version.fileName}>{version.fileName} &middot; {formatDate(version.date)}</p>
								</div>
								<button
									type="button"
									class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
									disabled={matching !== null}
									onclick={() => match(version)}
								>
									{matching === version.id ? 'Matching...' : 'Match'}
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</Modal>
```

- [ ] **Step 2: Extend `ModList.svelte`**

Script changes:

```ts
	import ModMatchModal from './ModMatchModal.svelte';
	import type { DownloadMode, ... } from '$lib/types/mods';   // add DownloadMode to the existing import

	let { serverId, hasModLoader = true, mcVersion = '', loader = null, onreview }:
		{ serverId: string; hasModLoader?: boolean; mcVersion?: string; loader?: string | null; onreview?: () => void } = $props();

	let matchTarget = $state<ModInfo | null>(null);

	const POLICY_LABELS: Record<DownloadMode, string> = { hosted: 'Hosted by ION', direct: 'Direct download', manual: 'Manual download' };
	const POLICY_CLASSES: Record<DownloadMode, string> = {
		hosted: 'bg-green-900/40 text-green-300',
		direct: 'bg-sky-900/40 text-sky-300',
		manual: 'bg-yellow-900/50 text-yellow-300'
	};
	const policyCounts = $derived.by(() => {
		const counts = { hosted: 0, direct: 0, manual: 0, review: 0 };
		for (const m of mods) {
			if (m.policy.effective) counts[m.policy.effective]++;
			else counts.review++;
		}
		return counts;
	});

	function policyTitle(mod: ModInfo): string {
		if (mod.policy.override) return `Admin override${mod.policy.override.note ? `: ${mod.policy.override.note}` : ''}`;
		return mod.policy.recommended?.reason ?? 'Unmatched: license unknown. Match it or override it on the Licenses tab.';
	}
```

Toolbar: replace the `{mods.length - untrackedCount}/{mods.length} matched…` span with:

```svelte
				<span class="text-xs text-gray-500">
					{policyCounts.hosted} hosted &middot; {policyCounts.direct} direct &middot; {policyCounts.manual} manual
					{#if policyCounts.review > 0}
						&middot; <span class="text-red-300">{policyCounts.review} need review</span>
					{/if}
				</span>
				{#if onreview}
					<button type="button" class="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700" onclick={onreview}>
						Review licenses
					</button>
				{/if}
```

Row: right after the version badge `{/if}` inside the tracked `<p>`, and as a sibling in the untracked branch's name `<p>`, add the policy badge:

```svelte
												{#if mod.policy.effective}
													<span class="shrink-0 rounded px-1.5 text-xs {POLICY_CLASSES[mod.policy.effective]}" title={policyTitle(mod)}>
														{POLICY_LABELS[mod.policy.effective]}{mod.policy.override ? ' *' : ''}
													</span>
												{:else}
													<span class="shrink-0 rounded bg-red-900/40 px-1.5 text-xs text-red-300" title={policyTitle(mod)}>Needs review</span>
												{/if}
```

(For the untracked branch, turn its `<p class="truncate text-sm text-gray-200">` into `<p class="flex min-w-0 items-center gap-2 text-sm text-gray-200"><span class="truncate" title={mod.filename}>{mod.filename}</span> …badge… </p>`.)

Next to the `Versions` button block, add for untracked mods:

```svelte
									{#if !mod.tracked}
										<button
											type="button"
											class="shrink-0 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-indigo-500 hover:text-white"
											onclick={() => (matchTarget = mod)}
											title="Pick the Modrinth or CurseForge project this file came from"
										>
											Match…
										</button>
									{/if}
```

At the bottom, next to `<ModVersionModal …/>`:

```svelte
<ModMatchModal mod={matchTarget} {serverId} {mcVersion} {loader} onclose={() => (matchTarget = null)} onmatched={loadMods} />
```

- [ ] **Step 3: Verify** `pnpm check` → 0 errors. In the browser (`pnpm dev`): an unmatched jar shows "Needs review" and "Match…"; the modal opens pre-searched, selecting a project lists versions with the same-file-name one first; "Match" closes the modal and the row now shows a policy badge with the reason as tooltip.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/ModMatchModal.svelte src/lib/components/ModList.svelte
git commit -m "Show each mod's download mode and let admins match unmatched files" -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Licenses tab (review and overrides)

**Files:**
- Create: `[M]/src/lib/components/LicenseReview.svelte`
- Modify: `[M]/src/routes/servers/[serverId]/+page.svelte` (tab list, tab content, `onreview`)

**Interfaces:**
- Consumes: `GET .../mods`, `PUT .../mods/policy` (Task 3), `POST .../mods/recheck` (Task 4), `ModMatchModal` (Task 10).
- Produces: `LicenseReview` props `{ serverId: string; mcVersion: string; loader: string | null }`.

- [ ] **Step 1: Create `src/lib/components/LicenseReview.svelte`**

```svelte
<script lang="ts">
	import { addToast } from './Toast.svelte';
	import ModMatchModal from './ModMatchModal.svelte';
	import { api, errorMessage, jsonBody } from '$lib/api';
	import type { DownloadMode, ModInfo, PolicyOverride } from '$lib/types/mods';

	let { serverId, mcVersion, loader }: { serverId: string; mcVersion: string; loader: string | null } = $props();

	let mods = $state<ModInfo[]>([]);
	let loading = $state(true);
	let rechecking = $state(false);
	let saving = $state<string | null>(null);
	let matchTarget = $state<ModInfo | null>(null);
	let notes = $state<Record<string, string>>({});

	const modsBase = $derived(`/api/servers/${encodeURIComponent(serverId)}/mods`);

	const MODES: { key: DownloadMode; label: string; description: string }[] = [
		{ key: 'hosted', label: 'Hosted by ION', description: 'ION serves the jar. Only for licenses that permit redistribution, or mods we hold the rights to.' },
		{ key: 'direct', label: 'Direct download', description: "The launcher downloads it from Modrinth / CurseForge / GitHub; ION never serves a copy." },
		{ key: 'manual', label: 'Manual download', description: 'Players download it from the mod page themselves (CurseForge mods whose authors block third-party downloads).' }
	];
	const MODE_CLASSES: Record<DownloadMode, string> = {
		hosted: 'bg-green-900/40 text-green-300',
		direct: 'bg-sky-900/40 text-sky-300',
		manual: 'bg-yellow-900/50 text-yellow-300'
	};

	const groups = $derived.by(() => ({
		review: mods.filter((m) => m.policy.effective === null),
		manual: mods.filter((m) => m.policy.effective === 'manual'),
		direct: mods.filter((m) => m.policy.effective === 'direct'),
		hosted: mods.filter((m) => m.policy.effective === 'hosted')
	}));

	async function load() {
		loading = true;
		try {
			mods = await api<ModInfo[]>(modsBase);
			notes = Object.fromEntries(mods.filter((m) => m.policy.override?.note).map((m) => [m.policy.key, m.policy.override!.note!]));
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to load mods'));
		} finally {
			loading = false;
		}
	}

	async function setOverride(mod: ModInfo, mode: DownloadMode | null) {
		saving = mod.policy.key;
		try {
			const result = await api<{ override: PolicyOverride | null }>(
				`${modsBase}/policy`,
				jsonBody({ key: mod.policy.key, mode, note: notes[mod.policy.key] ?? '' }, 'PUT')
			);
			mod.policy = { ...mod.policy, override: result.override, effective: result.override?.mode ?? mod.policy.recommended?.mode ?? null };
			mods = [...mods];
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to save the override'));
		} finally {
			saving = null;
		}
	}

	async function saveNote(mod: ModInfo) {
		if (!mod.policy.override) return;
		if ((mod.policy.override.note ?? '') === (notes[mod.policy.key] ?? '').trim()) return;
		await setOverride(mod, mod.policy.override.mode);
	}

	async function recheck() {
		rechecking = true;
		try {
			const result = await api<{ updated: number }>(`${modsBase}/recheck`, { method: 'POST' });
			addToast('success', `Re-checked ${result.updated} mod(s)`);
			await load();
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to re-check licenses'));
		} finally {
			rechecking = false;
		}
	}

	function licenseLabel(mod: ModInfo): string {
		if (!mod.tracked) return 'unknown';
		if (mod.tracked.source === 'curseforge') return mod.tracked.distributionAllowed === false ? 'third-party downloads blocked' : 'not published by CurseForge';
		return mod.tracked.license?.id ?? 'none declared';
	}

	$effect(() => {
		void modsBase;
		load();
	});
</script>

<div class="space-y-6">
	<div class="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-300">
		<p class="mb-3">
			Each mod is obtained one of three ways. The recommendation comes from the license Modrinth or CurseForge
			publishes; override it per mod when you know better (e.g. the author gave permission, or it's our own mod).
		</p>
		<dl class="grid gap-2 sm:grid-cols-3">
			{#each MODES as mode (mode.key)}
				<div class="rounded-lg bg-gray-800/60 p-3">
					<dt class="inline-block rounded px-1.5 text-xs {MODE_CLASSES[mode.key]}">{mode.label}</dt>
					<dd class="mt-1 text-xs text-gray-400">{mode.description}</dd>
				</div>
			{/each}
		</dl>
		<div class="mt-3 flex flex-wrap items-center gap-3">
			<button type="button" class="rounded-lg bg-gray-800 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50" disabled={rechecking} onclick={recheck}>
				{rechecking ? 'Re-checking...' : 'Re-check licenses'}
			</button>
			<span class="text-xs text-gray-500">
				{groups.hosted.length} hosted &middot; {groups.direct.length} direct &middot; {groups.manual.length} manual
				{#if groups.review.length > 0}&middot; <span class="text-red-300">{groups.review.length} need review</span>{/if}
			</span>
		</div>
	</div>

	{#if loading && mods.length === 0}
		<p class="text-sm text-gray-400">Loading mods...</p>
	{:else}
		{#each [
			{ key: 'review', title: 'Needs review', description: 'Not matched to a platform, so the license is unknown. Match them, or host them anyway if we hold the rights.', list: groups.review },
			{ key: 'manual', title: 'Manual download', description: 'Players download these themselves.', list: groups.manual },
			{ key: 'direct', title: 'Direct download', description: 'Fetched from the platform by the launcher.', list: groups.direct },
			{ key: 'hosted', title: 'Hosted by ION', description: 'Served from our server.', list: groups.hosted }
		] as group (group.key)}
			{#if group.list.length > 0}
				<div class="rounded-lg border {group.key === 'review' ? 'border-red-900' : 'border-gray-800'} bg-gray-900">
					<div class="border-b border-gray-800 px-4 py-3">
						<h3 class="text-sm font-semibold text-white">{group.title}</h3>
						<p class="text-xs text-gray-500">{group.description}</p>
					</div>
					<div class="divide-y divide-gray-800">
						{#each group.list as mod (mod.filename)}
							<div class="flex flex-wrap items-center gap-3 px-4 py-3">
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm text-gray-200" title={mod.filename}>
										{mod.tracked?.projectName ?? mod.filename}
										{#if mod.tracked?.versionName}<span class="ml-1 text-xs text-gray-500">{mod.tracked.versionName}</span>{/if}
									</p>
									<p class="truncate text-xs text-gray-500">
										{mod.filename} &middot; license: 
										{#if mod.tracked?.license?.url}
											<a href={mod.tracked.license.url} target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300">{licenseLabel(mod)}</a>
										{:else}
											{licenseLabel(mod)}
										{/if}
									</p>
									{#if mod.policy.recommended}
										<p class="mt-1 text-xs text-gray-400">
											Recommended: <span class="rounded px-1.5 {MODE_CLASSES[mod.policy.recommended.mode]}">{MODES.find((m) => m.key === mod.policy.recommended!.mode)?.label}</span>
											&middot; {mod.policy.recommended.reason}
										</p>
									{/if}
								</div>
								{#if !mod.tracked}
									<button type="button" class="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700" onclick={() => (matchTarget = mod)}>
										Match…
									</button>
								{/if}
								<div class="flex flex-col gap-1">
									<select
										class="rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-white"
										aria-label="Download mode override for {mod.filename}"
										disabled={saving === mod.policy.key}
										value={mod.policy.override?.mode ?? ''}
										onchange={(e) => setOverride(mod, (e.currentTarget.value || null) as DownloadMode | null)}
									>
										<option value="">{mod.tracked ? 'Use recommendation' : 'No decision yet'}</option>
										{#each MODES as mode (mode.key)}
											{#if mod.tracked || mode.key === 'hosted'}
												<option value={mode.key}>{mode.key === 'hosted' && !mod.tracked ? 'Host anyway (we hold the rights)' : mode.label}</option>
											{/if}
										{/each}
									</select>
									{#if mod.policy.override}
										<input
											class="w-56 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-xs text-white placeholder-gray-500"
											placeholder="Why? (optional note)"
											aria-label="Override note for {mod.filename}"
											bind:value={notes[mod.policy.key]}
											onblur={() => saveNote(mod)}
											onkeydown={(e) => e.key === 'Enter' && saveNote(mod)}
										/>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		{/each}
		{#if mods.length === 0}
			<p class="text-sm text-gray-500">This server has no mods.</p>
		{/if}
	{/if}
</div>

<ModMatchModal mod={matchTarget} {serverId} {mcVersion} {loader} onclose={() => (matchTarget = null)} onmatched={load} />
```

- [ ] **Step 2: Wire the tab in `src/routes/servers/[serverId]/+page.svelte`**

- Import `LicenseReview from '$lib/components/LicenseReview.svelte'`.
- `activeTab` type: `'metadata' | 'mods' | 'licenses' | 'files' | 'libraries'`.
- `tabs`: insert `{ key: 'licenses', label: 'Licenses' }` after `mods`.
- Pass `onreview={() => (activeTab = 'licenses')}` to `<ModList …/>`.
- Tab content: before `{:else if activeTab === 'files'}` add

```svelte
		{:else if activeTab === 'licenses'}
			<LicenseReview {serverId} mcVersion={server.minecraftVersion} loader={server.modLoader} />
```

- [ ] **Step 3: Verify** `pnpm check`. In the browser: Licenses tab groups mods; changing the select to "Manual download" on a Modrinth mod shows the badge change and writes `mod-policy.json`; typing a note and leaving the field persists it (reload shows it); an unmatched jar only offers "Host anyway"; "Re-check licenses" toasts the count.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/LicenseReview.svelte
git add -p "src/routes/servers/[serverId]/+page.svelte"   # only the Licenses tab hunks; the disabled-server copy is foreign work
git commit -m "Add a Licenses tab to review and override download modes" -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Custom mods panel

**Files:**
- Create: `[M]/src/lib/components/CustomModsPanel.svelte`
- Modify: `[M]/src/routes/servers/[serverId]/+page.svelte` (mods tab)

**Interfaces:**
- Consumes: custom-mods routes (Task 7).
- Produces: `CustomModsPanel` props `{ serverId: string; hasModLoader: boolean }`.

- [ ] **Step 1: Create `src/lib/components/CustomModsPanel.svelte`**

```svelte
<script lang="ts">
	import { addToast } from './Toast.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { api, errorMessage, formatSize, jsonBody } from '$lib/api';
	import type { CustomMod, ModCategory } from '$lib/types/mods';

	let { serverId, hasModLoader }: { serverId: string; hasModLoader: boolean } = $props();

	let mods = $state<CustomMod[]>([]);
	let loading = $state(true);
	let adding = $state(false);
	let showForm = $state(false);
	let busy = $state<string | null>(null);
	let deleteTarget = $state<CustomMod | null>(null);

	let repo = $state('');
	let name = $state('');
	let category = $state<ModCategory>('required');
	let prerelease = $state(false);
	let assetPattern = $state('');

	const base = $derived(`/api/servers/${encodeURIComponent(serverId)}/custom-mods`);
	const categories: { key: ModCategory; label: string }[] = [
		{ key: 'required', label: 'Required' },
		{ key: 'optionalon', label: 'Optional (On)' },
		{ key: 'optionaloff', label: 'Optional (Off)' }
	];

	async function load() {
		loading = true;
		try {
			mods = await api<CustomMod[]>(base);
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to load custom mods'));
		} finally {
			loading = false;
		}
	}

	async function add() {
		adding = true;
		try {
			const result = await api<{ mod: CustomMod }>(base, jsonBody({ repo, name, category, prerelease, assetPattern: assetPattern || null }));
			addToast(result.mod.resolveError ? 'info' : 'success', result.mod.resolveError
				? `Added ${result.mod.name}, but its release could not be resolved: ${result.mod.resolveError}`
				: `Added ${result.mod.name} (${result.mod.resolved?.tag})`, 8000);
			repo = ''; name = ''; assetPattern = ''; prerelease = false; category = 'required'; showForm = false;
			await load();
		} catch (err) {
			addToast('error', errorMessage(err, 'Failed to add custom mod'));
		} finally {
			adding = false;
		}
	}

	async function patch(mod: CustomMod, body: Record<string, unknown>) {
		busy = mod.id;
		try {
			await api(`${base}/${encodeURIComponent(mod.id)}`, jsonBody(body, 'PATCH'));
			await load();
		} catch (err) {
			addToast('error', errorMessage(err, `Failed to update ${mod.name}`));
		} finally {
			busy = null;
		}
	}

	async function resolve(mod: CustomMod) {
		busy = mod.id;
		try {
			const result = await api<{ mod: CustomMod }>(`${base}/${encodeURIComponent(mod.id)}/resolve`, { method: 'POST' });
			if (result.mod.resolveError) addToast('error', `${mod.name}: ${result.mod.resolveError}`);
			else addToast('success', `${mod.name}: newest release is ${result.mod.resolved?.tag}`);
			await load();
		} catch (err) {
			addToast('error', errorMessage(err, `Failed to check ${mod.name}`));
		} finally {
			busy = null;
		}
	}

	async function remove() {
		if (!deleteTarget) return;
		const target = deleteTarget;
		try {
			await api(`${base}/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
			addToast('success', `Removed ${target.name}`);
			deleteTarget = null;
			await load();
		} catch (err) {
			addToast('error', errorMessage(err, `Failed to remove ${target.name}`));
		}
	}

	$effect(() => {
		void base;
		load();
	});
</script>

{#if hasModLoader}
	<div class="rounded-lg border border-gray-800 bg-gray-900">
		<div class="flex items-center justify-between border-b border-gray-800 px-4 py-3">
			<div>
				<h3 class="text-sm font-semibold text-white">Custom mods (GitHub releases)</h3>
				<p class="text-xs text-gray-500">
					The launcher downloads the newest release jar straight from GitHub at every launch. For ION's own mods that
					aren't on Modrinth or CurseForge.
				</p>
			</div>
			<button type="button" class="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700" onclick={() => (showForm = !showForm)}>
				{showForm ? 'Cancel' : 'Add GitHub mod'}
			</button>
		</div>

		{#if showForm}
			<form class="space-y-3 border-b border-gray-800 px-4 py-3" onsubmit={(e) => { e.preventDefault(); add(); }}>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="text-xs text-gray-400">Repository
						<input bind:value={repo} required placeholder="https://github.com/IONNetworkTeam/IONMod" class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none" />
					</label>
					<label class="text-xs text-gray-400">Name (optional)
						<input bind:value={name} placeholder="Defaults to the repository name" class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none" />
					</label>
					<label class="text-xs text-gray-400">Category
						<select bind:value={category} class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-700 px-2 py-2 text-sm text-white">
							{#each categories as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
						</select>
					</label>
					<label class="text-xs text-gray-400">Asset name pattern (optional, regular expression)
						<input bind:value={assetPattern} placeholder="default: first jar that isn't -sources/-dev/-api" class="mt-1 w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-indigo-500 focus:outline-none" />
					</label>
				</div>
				<label class="flex items-center gap-2 text-sm text-gray-300">
					<input type="checkbox" bind:checked={prerelease} /> Include pre-releases
				</label>
				<button type="submit" disabled={adding} class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
					{adding ? 'Resolving release...' : 'Add'}
				</button>
			</form>
		{/if}

		{#if loading && mods.length === 0}
			<p class="px-4 py-3 text-sm text-gray-400">Loading...</p>
		{:else if mods.length === 0}
			<p class="px-4 py-3 text-sm text-gray-500">No custom mods</p>
		{:else}
			<div class="divide-y divide-gray-800">
				{#each mods as mod (mod.id)}
					<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
						<div class="min-w-0 flex-1">
							<p class="flex items-center gap-2 text-sm text-gray-200">
								<span class="truncate">{mod.name}</span>
								{#if mod.resolved}
									<span class="shrink-0 rounded bg-gray-800 px-1.5 text-xs text-gray-400">{mod.resolved.tag}</span>
								{/if}
								<span class="shrink-0 rounded bg-sky-900/40 px-1.5 text-xs text-sky-300">GitHub</span>
							</p>
							<p class="truncate text-xs text-gray-500">
								<a href="https://github.com/{mod.repo}" target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:text-indigo-300">{mod.repo}</a>
								{#if mod.resolved}&middot; {mod.resolved.assetName} &middot; {formatSize(mod.resolved.size)}{/if}
								{#if mod.prerelease}&middot; pre-releases{/if}
							</p>
							{#if mod.resolveError}
								<p class="text-xs text-red-400">{mod.resolveError}</p>
							{/if}
						</div>
						<button type="button" class="shrink-0 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:border-indigo-500 hover:text-white disabled:opacity-50" disabled={busy === mod.id} onclick={() => resolve(mod)}>
							{busy === mod.id ? 'Checking...' : 'Check release'}
						</button>
						<select
							class="rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-white"
							aria-label="Category for {mod.name}"
							value={mod.category}
							disabled={busy === mod.id}
							onchange={(e) => patch(mod, { category: e.currentTarget.value })}
						>
							{#each categories as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
						</select>
						<button type="button" class="text-gray-500 hover:text-red-400" onclick={() => (deleteTarget = mod)} aria-label="Remove {mod.name}" title="Remove">
							<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
							</svg>
						</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<ConfirmDialog
	open={!!deleteTarget}
	title="Remove Custom Mod"
	message="Remove {deleteTarget?.name} from this server? Players lose it on the next distribution generation."
	confirmLabel="Remove"
	destructive
	onconfirm={remove}
	oncancel={() => (deleteTarget = null)}
/>
```

- [ ] **Step 2: Render it** in the server page's mods tab, after the `{/key}` that wraps `<ModList>`:

```svelte
				<CustomModsPanel {serverId} hasModLoader={!!server.modLoader} />
```

and import `CustomModsPanel from '$lib/components/CustomModsPanel.svelte'`.

- [ ] **Step 3: Verify** `pnpm check`. In the browser: add `https://github.com/IrisShaders/Iris` → row shows tag, asset and size; "Check release" toasts; generate the distribution and confirm the new module appears at the end of the server's modules with `ion.source === "github"`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/CustomModsPanel.svelte
git add -p "src/routes/servers/[serverId]/+page.svelte"
git commit -m "Manage GitHub custom mods from the Mods tab" -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Part B — IONLauncher (branch `beta`)

### Task 13: Pure `ion` helpers with a Node test runner

**Files:**
- Create: `[L]/app/assets/js/ionmods.js`
- Create: `[L]/test/ionmods.test.js`
- Modify: `[L]/package.json` (`test` script)

**Interfaces:**
- Produces (`require('./assets/js/ionmods')`):
  - `DEFAULT_ASSET_PATTERN` (same string as the Manager's)
  - `isGithubModule(raw: Module): boolean`, `isManualModule(raw: Module): boolean`
  - `safeTag(tag: string): string`
  - `pickAsset(assets, pattern): asset | null`
  - `applyRelease(raw: Module, release: { tag_name, assets }): boolean` (mutates `raw`; true when changed)
  - `pruneUnavailableManualModules(rawDistribution, serverId, unavailableIds: string[]): Distribution` (new object; input untouched)

- [ ] **Step 1: Add the test script.** In `package.json` scripts add `"test": "node --test \"test/**/*.test.js\""`.

- [ ] **Step 2: Write the failing tests** `test/ionmods.test.js`

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const IonMods = require('../app/assets/js/ionmods')

function githubModule(){
    return {
        id: 'ion.github.IONNetworkTeam:IONMod:v1.4.0@jar',
        name: 'ION Mod',
        type: 'FabricMod',
        artifact: { size: 4321, MD5: 'abc', url: 'https://github.com/IONNetworkTeam/IONMod/releases/download/v1.4.0/ionmod-1.4.0.jar' },
        ion: { source: 'github', download: 'direct', projectUrl: 'https://github.com/IONNetworkTeam/IONMod', github: { repo: 'IONNetworkTeam/IONMod', assetPattern: null, prerelease: false, tag: 'v1.4.0', sha256: 'def' } }
    }
}

function asset(name, extra = {}){
    return { name, size: 100, browser_download_url: `https://github.com/o/r/releases/download/v2/${name}`, digest: null, ...extra }
}

test('classifies modules by their ion field', () => {
    assert.equal(IonMods.isGithubModule(githubModule()), true)
    assert.equal(IonMods.isManualModule(githubModule()), false)
    assert.equal(IonMods.isManualModule({ ion: { download: 'manual', manual: { pageUrl: 'https://x', fileName: 'x.jar' } } }), true)
    assert.equal(IonMods.isGithubModule({ id: 'a:b:c' }), false)
    assert.equal(IonMods.isManualModule(undefined), false)
})

test('pickAsset skips sources, dev, javadoc and api jars by default', () => {
    const assets = [asset('m-sources.jar'), asset('m-dev.jar'), asset('m-api.jar'), asset('m.jar'), asset('m.zip')]
    assert.equal(IonMods.pickAsset(assets).name, 'm.jar')
    assert.equal(IonMods.pickAsset([asset('m-sources.jar')]), null)
    assert.equal(IonMods.pickAsset(assets, 'api').name, 'm-api.jar')
    // An invalid custom pattern falls back to the default instead of crashing the launch.
    assert.equal(IonMods.pickAsset(assets, '(').name, 'm.jar')
})

test('applyRelease rewrites id, url, size and drops the stale MD5', () => {
    const raw = githubModule()
    const changed = IonMods.applyRelease(raw, { tag_name: 'v1.5.0', assets: [asset('ionmod-1.5.0.jar', { size: 5000, digest: 'sha256:0123' })] })
    assert.equal(changed, true)
    assert.equal(raw.id, 'ion.github.IONNetworkTeam:IONMod:v1.5.0@jar')
    assert.deepEqual(raw.artifact, { size: 5000, url: 'https://github.com/o/r/releases/download/v2/ionmod-1.5.0.jar' })
    assert.equal(raw.ion.github.tag, 'v1.5.0')
    assert.equal(raw.ion.github.sha256, '0123')
})

test('applyRelease keeps the module when the release is the embedded one or has no usable asset', () => {
    const raw = githubModule()
    assert.equal(IonMods.applyRelease(raw, { tag_name: 'v1.4.0', assets: [asset('ionmod-1.4.0.jar', { browser_download_url: raw.artifact.url })] }), false)
    assert.equal(raw.artifact.MD5, 'abc')
    assert.equal(IonMods.applyRelease(raw, { tag_name: 'v9', assets: [asset('ionmod-sources.jar')] }), false)
    assert.equal(raw.id, 'ion.github.IONNetworkTeam:IONMod:v1.4.0@jar')
})

test('safeTag keeps Maven ids parseable', () => {
    assert.equal(IonMods.safeTag('v1.2.3+build.4'), 'v1.2.3+build.4')
    assert.equal(IonMods.safeTag('release/2026 beta:1@x'), 'release-2026-beta-1-x')
})

test('pruneUnavailableManualModules removes only the given modules of the given server', () => {
    const distro = { version: '1.0.0', servers: [
        { id: 'smp', modules: [{ id: 'a:a:1@jar' }, { id: 'b:b:1@jar' }] },
        { id: 'other', modules: [{ id: 'a:a:1@jar' }] }
    ] }
    const pruned = IonMods.pruneUnavailableManualModules(distro, 'smp', ['a:a:1@jar'])
    assert.deepEqual(pruned.servers[0].modules.map(m => m.id), ['b:b:1@jar'])
    assert.deepEqual(pruned.servers[1].modules.map(m => m.id), ['a:a:1@jar'])
    assert.equal(distro.servers[0].modules.length, 2, 'input is not mutated')
})
```

- [ ] **Step 3: Run** `npm test` → FAIL (`Cannot find module '../app/assets/js/ionmods'`).

- [ ] **Step 4: Implement** `app/assets/js/ionmods.js`

```js
/**
 * ION's extensions to the distribution index (the `ion` field on mod modules; see docs/distro.md):
 * mods downloaded from a GitHub repository's newest release, and mods players must download
 * themselves. These helpers are pure so they can be tested with `npm test`; the launch flow in
 * scripts/modsetup.js and the settings UI use them.
 */

/** First `.jar` that isn't a sources / dev / javadoc / api / shadow artifact. Same as the Manager's. */
const DEFAULT_ASSET_PATTERN = '^(?!.*(?:-sources|-dev|-javadoc|-api|-shadow)\\b).*\\.jar$'

function isGithubModule(raw){
    return raw?.ion?.source === 'github' && raw.ion.github != null
}

function isManualModule(raw){
    return raw?.ion?.download === 'manual' && raw.ion.manual != null
}

/** Tags end up in Maven ids and paths, which Helios splits on `:` and `@`. */
function safeTag(tag){
    return String(tag).replace(/[^A-Za-z0-9._+-]/g, '-')
}

function pickAsset(assets, pattern){
    let re
    try {
        re = new RegExp(pattern || DEFAULT_ASSET_PATTERN, 'i')
    } catch {
        re = new RegExp(DEFAULT_ASSET_PATTERN, 'i')
    }
    return (assets || []).find(a => re.test(a.name)) || null
}

/**
 * Point a GitHub module at a release. Returns true when the module changed.
 *
 * The id's version becomes the tag, so a new release lands at a new path under modstore and
 * stale copies never shadow it. MD5 is dropped: GitHub only publishes SHA-256 digests, which
 * modsetup.js checks instead.
 */
function applyRelease(raw, release){
    const asset = pickAsset(release.assets, raw.ion.github.assetPattern)
    if(asset == null) return false
    const [group, artifact] = raw.id.split(':')
    const id = `${group}:${artifact}:${safeTag(release.tag_name)}@jar`
    if(raw.id === id && raw.artifact.url === asset.browser_download_url) return false
    raw.id = id
    raw.artifact = { size: asset.size, url: asset.browser_download_url }
    raw.ion.github.tag = release.tag_name
    raw.ion.github.sha256 = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : null
    return true
}

/**
 * The copy of the index written for Helios' FullRepair child: manual mods without a local file
 * are left out, so the child never tries to download their web page. The input is not mutated.
 */
function pruneUnavailableManualModules(rawDistribution, serverId, unavailableIds){
    const skip = new Set(unavailableIds)
    return {
        ...rawDistribution,
        servers: rawDistribution.servers.map(s => s.id !== serverId ? s : { ...s, modules: s.modules.filter(m => !skip.has(m.id)) })
    }
}

module.exports = {
    DEFAULT_ASSET_PATTERN,
    isGithubModule,
    isManualModule,
    safeTag,
    pickAsset,
    applyRelease,
    pruneUnavailableManualModules
}
```

- [ ] **Step 5: Run** `npm test` → 6 passing.

- [ ] **Step 6: Commit**

```bash
git add package.json app/assets/js/ionmods.js test/ionmods.test.js
git commit -m "Add helpers for GitHub-release and manual-download mods" -m "Pure functions over the ion field the Manager adds to distribution.json, with a node:test suite (npm test) since the launcher had no test runner." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: GitHub release lookup with a cached conditional request

**Files:**
- Modify: `[L]/app/assets/js/ionmods.js` (add `fetchLatestRelease`)
- Modify: `[L]/test/ionmods.test.js`
- Modify: `[L]/app/assets/js/configmanager.js:78-104, 242-258, after 574`

**Interfaces:**
- Produces:
  - `fetchLatestRelease(repo: string, prerelease: boolean, cache: { etag: string | null, release } | null, request = got): Promise<{ release, cache }>` — `request` is injectable for tests.
  - `ConfigManager.getGithubReleaseCache(repo): object | null`, `ConfigManager.setGithubReleaseCache(repo, cache)`; new config key `githubReleases: {}` (not validated recursively).

- [ ] **Step 1: Write the failing tests** (append to `test/ionmods.test.js`)

```js
function fakeGot(responses){
    const calls = []
    const fn = async (url, options) => {
        calls.push({ url, options })
        const next = responses.shift()
        return typeof next === 'function' ? next(url, options) : next
    }
    fn.calls = calls
    return fn
}

const release = { tag_name: 'v2', html_url: 'https://github.com/o/r/releases/tag/v2', draft: false, assets: [asset('r-2.jar')] }

test('fetchLatestRelease uses /releases/latest and slims the response', async () => {
    const request = fakeGot([{ statusCode: 200, headers: { etag: 'W/"1"' }, body: { ...release, extra: true } }])
    const result = await IonMods.fetchLatestRelease('o/r', false, null, request)
    assert.equal(request.calls[0].url, 'https://api.github.com/repos/o/r/releases/latest')
    assert.equal(result.release.tag_name, 'v2')
    assert.equal(result.release.extra, undefined)
    assert.deepEqual(result.release.assets[0], { name: 'r-2.jar', size: 100, browser_download_url: 'https://github.com/o/r/releases/download/v2/r-2.jar', digest: null })
    assert.equal(result.cache.etag, 'W/"1"')
})

test('fetchLatestRelease sends If-None-Match and reuses the cached release on 304', async () => {
    const cache = { etag: 'W/"1"', release }
    const request = fakeGot([{ statusCode: 304, headers: {}, body: '' }])
    const result = await IonMods.fetchLatestRelease('o/r', false, cache, request)
    assert.equal(request.calls[0].options.headers['If-None-Match'], 'W/"1"')
    assert.equal(result.release, release)
})

test('fetchLatestRelease picks the newest non-draft of /releases when pre-releases are allowed', async () => {
    const request = fakeGot([{ statusCode: 200, headers: {}, body: [{ ...release, tag_name: 'v3-draft', draft: true }, { ...release, tag_name: 'v3-beta', prerelease: true }] }])
    const result = await IonMods.fetchLatestRelease('o/r', true, null, request)
    assert.match(request.calls[0].url, /\/releases\?per_page=10$/)
    assert.equal(result.release.tag_name, 'v3-beta')
})

test('fetchLatestRelease throws on other statuses', async () => {
    const request = fakeGot([{ statusCode: 403, headers: {}, body: {} }])
    await assert.rejects(IonMods.fetchLatestRelease('o/r', false, null, request), /403/)
})
```

- [ ] **Step 2: Run** `npm test` → the four new tests FAIL.

- [ ] **Step 3: Implement** in `ionmods.js` (add `const got = require('got')` at the top and export the function)

```js
/**
 * Newest release of `repo`. Uses a conditional request so repeated launches don't eat GitHub's
 * 60 requests/hour for unauthenticated clients (304 responses are free). `cache` is what a
 * previous call returned, or null. Throws when GitHub can't be reached or answers with an error;
 * callers fall back to the release embedded in the distribution.
 */
async function fetchLatestRelease(repo, prerelease, cache, request = got){
    const url = prerelease
        ? `https://api.github.com/repos/${repo}/releases?per_page=10`
        : `https://api.github.com/repos/${repo}/releases/latest`
    const headers = {
        'User-Agent': 'ION-Launcher',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    }
    if(cache?.etag) headers['If-None-Match'] = cache.etag

    const res = await request(url, { headers, responseType: 'json', throwHttpErrors: false, timeout: 8000 })
    if(res.statusCode === 304 && cache?.release) return { release: cache.release, cache }
    if(res.statusCode !== 200) throw new Error(`GitHub answered ${res.statusCode} for ${repo}`)

    const found = Array.isArray(res.body) ? res.body.find(r => !r.draft) : res.body
    if(found == null) throw new Error(`${repo} has no releases`)
    const release = {
        tag_name: found.tag_name,
        html_url: found.html_url,
        assets: (found.assets || []).map(a => ({ name: a.name, size: a.size, browser_download_url: a.browser_download_url, digest: a.digest ?? null }))
    }
    return { release, cache: { etag: res.headers?.etag || null, release, fetchedAt: Date.now() } }
}
```

- [ ] **Step 4: Run** `npm test` → all pass.

- [ ] **Step 5: Config storage** in `configmanager.js`

In `DEFAULT_CONFIG` add after `javaConfig: {}`:

```js
    /** Per-repository GitHub release cache for custom mods: { [owner/repo]: { etag, release, fetchedAt } } */
    githubReleases: {}
```

In `validateKeySet`, change the blacklist to `const validationBlacklist = ['authenticationDatabase', 'javaConfig', 'githubReleases']`.

After `exports.setModConfiguration` add:

```js
/**
 * Cached GitHub release lookup for a custom mod's repository, or null.
 *
 * @param {string} repo `owner/repo`
 */
exports.getGithubReleaseCache = function(repo){
    return config.githubReleases?.[repo] ?? null
}

/**
 * Remember a GitHub release lookup (ETag and slimmed release) for a repository.
 *
 * @param {string} repo `owner/repo`
 * @param {Object} cache As returned by ionmods.fetchLatestRelease.
 */
exports.setGithubReleaseCache = function(repo, cache){
    if(config.githubReleases == null) config.githubReleases = {}
    config.githubReleases[repo] = cache
    exports.save()
}
```

- [ ] **Step 6: Verify** `npm test` passes; `npx eslint app/assets/js/ionmods.js test/ionmods.test.js 2>&1 | grep -v linebreak-style | grep error` prints nothing (only the pre-existing CRLF rule fires).

- [ ] **Step 7: Commit**

```bash
git add app/assets/js/ionmods.js test/ionmods.test.js
git add -p app/assets/js/configmanager.js   # only the githubReleases hunks; the debounced save() is foreign work
git commit -m "Look up a custom mod's newest GitHub release with an ETag cache" -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Pre-launch mod setup in the launch flow

**Files:**
- Create: `[L]/app/assets/js/scripts/modsetup.js`
- Modify: `[L]/app/landing.ejs:165` (load the script)
- Modify: `[L]/app/assets/js/scripts/landing.js:482-571` (`dlAsync`)
- Modify: `[L]/app/assets/lang/en_US.toml` (`[js.landing.dlAsync]`)
- Modify: `[L]/docs/distro.md` (append the `ion` section)

**Interfaces:**
- Consumes: `IonMods.*` (Tasks 13–14), `ConfigManager.get/setGithubReleaseCache` (Task 14), globals `DistroAPI`, `ConfigManager`, `ProcessBuilder`, `validateLocalFile`, `syncModConfigurations`, `toggleLaunchArea`, `LoggerUtil`, `Lang`, `path`.
- Produces (globals in `modsetup.js`):
  - `prepareIonModules(distro, serverId): Promise<HeliosDistribution | null>` — resolved distribution, or `null` when the player cancelled the manual step.
  - `isModuleFilePresent(mdl): Promise<boolean>`
  - `missingManualModules(serv): Promise<{ module: HeliosModule, enabled: boolean }[]>`
  - `verifyGithubFile(mdl): Promise<boolean>`, `removeStaleGithubFiles(serv)`, `findCorruptedGithubFiles(serv): Promise<string[]>`
  - `acceptFile(mdl, file): Promise<boolean>` (used by the dialog in Task 16)
  - `showManualModsDialog(modules): Promise<boolean>` — **stub in this task** (`return Promise.resolve(false)` with a `// Task 16` comment), real implementation in Task 16.

- [ ] **Step 1: Create `app/assets/js/scripts/modsetup.js`**

```js
/**
 * Pre-launch handling of ION's distribution extensions (the `ion` field; see docs/distro.md):
 *
 *  - GitHub mods: look up the newest release and rewrite the module so the newest jar is used.
 *  - Manual mods: make sure every enabled one is present, asking the player for the rest.
 *
 * Helios validates and downloads files in a forked child (FullRepair) that re-reads
 * distribution.json from disk, so the resolved distribution is written back to disk here,
 * before the child starts.
 */
const IonMods                 = require('./assets/js/ionmods')
const fsx                     = require('fs-extra')
const { HeliosDistribution }  = require('helios-core/common')

const loggerModSetup = LoggerUtil.getLogger('ModSetup')

/**
 * Resolve GitHub mods and collect manual mods for the selected server.
 *
 * @param {HeliosDistribution} distro The freshly refreshed distribution.
 * @param {string} serverId
 * @returns {Promise<HeliosDistribution|null>} The distribution to launch with (rebuilt when a
 * GitHub release changed a module), or null when the player cancelled the manual download step.
 */
async function prepareIonModules(distro, serverId){
    const raw = distro.rawDistribution
    const rawServer = raw.servers.find(s => s.id === serverId)
    if(rawServer == null) return distro

    let changed = false
    for(const mdl of rawServer.modules){
        if(!IonMods.isGithubModule(mdl)) continue
        const { repo, prerelease } = mdl.ion.github
        try {
            const { release, cache } = await IonMods.fetchLatestRelease(repo, prerelease, ConfigManager.getGithubReleaseCache(repo))
            ConfigManager.setGithubReleaseCache(repo, cache)
            if(IonMods.applyRelease(mdl, release)){
                loggerModSetup.info(`${mdl.name}: using GitHub release ${release.tag_name}.`)
                changed = true
            }
        } catch(err) {
            loggerModSetup.warn(`Could not check GitHub releases for ${repo}; using the release from the distribution index.`, err)
        }
    }

    if(changed){
        // Module paths are computed when a HeliosModule is constructed, so rebuild.
        distro = new HeliosDistribution(raw, ConfigManager.getCommonDirectory(), ConfigManager.getInstanceDirectory())
        DistroAPI.distribution = distro
        syncModConfigurations(distro)
    }

    const serv = distro.getServerById(serverId)
    await removeStaleGithubFiles(serv)

    const unavailable = await missingManualModules(serv)
    const enabledMissing = unavailable.filter(m => m.enabled).map(m => m.module)
    if(enabledMissing.length > 0){
        loggerModSetup.info(`${enabledMissing.length} manual mod(s) missing, asking the player.`)
        const done = await showManualModsDialog(enabledMissing)
        if(!done) return null
    }

    // Whatever is still missing is disabled; leave it out of the copy the child validates,
    // otherwise it would try to download the mod's web page.
    const stillMissing = []
    for(const { module } of unavailable){
        if(!await isModuleFilePresent(module)) stillMissing.push(module.rawModule.id)
    }
    const forChild = IonMods.pruneUnavailableManualModules(raw, serverId, stillMissing)
    const file = DistroAPI.isDevMode() ? 'distribution_dev.json' : 'distribution.json'
    await fsx.writeJson(path.join(ConfigManager.getLauncherDirectory(), file), forChild)

    return distro
}

/** True when the module's file exists and matches its MD5 (or just exists, when the index has none). */
async function isModuleFilePresent(mdl){
    return validateLocalFile(mdl.getPath(), 'md5', mdl.rawModule.artifact.MD5)
}

/**
 * Manual mods whose file is not in place, with whether the player has them enabled
 * (required, or optional and switched on).
 */
async function missingManualModules(serv){
    const cfg = ConfigManager.getModConfiguration(serv.rawServer.id)
    const result = []
    for(const mdl of serv.modules){
        if(!IonMods.isManualModule(mdl.rawModule)) continue
        if(await isModuleFilePresent(mdl)) continue
        const enabled = ProcessBuilder.isModEnabled(cfg?.mods?.[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
        result.push({ module: mdl, enabled })
    }
    return result
}

/** A GitHub jar is valid when it matches the release's SHA-256 digest, or its size when GitHub published none. */
async function verifyGithubFile(mdl){
    const p = mdl.getPath()
    if(!await fsx.pathExists(p)) return false
    const { sha256 } = mdl.rawModule.ion.github
    if(sha256) return validateLocalFile(p, 'sha256', sha256)
    return (await fsx.stat(p)).size === mdl.rawModule.artifact.size
}

/** Delete GitHub jars that don't match their release so FullRepair fetches them again. */
async function removeStaleGithubFiles(serv){
    for(const mdl of serv.modules){
        if(!IonMods.isGithubModule(mdl.rawModule)) continue
        if(await fsx.pathExists(mdl.getPath()) && !await verifyGithubFile(mdl)){
            loggerModSetup.warn(`${mdl.rawModule.name}: local file doesn't match the release, re-downloading.`)
            await fsx.remove(mdl.getPath()).catch(() => {})
        }
    }
}

/**
 * After FullRepair downloaded: GitHub jars that still don't match are corrupt. They are deleted
 * and their names returned so the launch can fail with a clear message.
 */
async function findCorruptedGithubFiles(serv){
    const names = []
    for(const mdl of serv.modules){
        if(!IonMods.isGithubModule(mdl.rawModule)) continue
        if(!await verifyGithubFile(mdl)){
            names.push(mdl.rawModule.name)
            await fsx.remove(mdl.getPath()).catch(() => {})
        }
    }
    return names
}

/**
 * Copy `file` into place if it is exactly the module's file: same MD5, or same size when the
 * index carries no hash. Used for files the player downloaded or picked.
 */
async function acceptFile(mdl, file){
    const { MD5, size } = mdl.rawModule.artifact
    const ok = MD5 ? await validateLocalFile(file, 'md5', MD5) : (await fsx.stat(file)).size === size
    if(!ok) return false
    await fsx.ensureDir(path.dirname(mdl.getPath()))
    await fsx.copy(file, mdl.getPath(), { overwrite: true })
    return true
}

/**
 * Ask the player to download the given modules themselves.
 * @returns {Promise<boolean>} true once every file is in place, false when cancelled.
 */
function showManualModsDialog(modules){
    // Task 16 replaces this stub with the dialog.
    loggerModSetup.error(`Manual download dialog not implemented; missing: ${modules.map(m => m.rawModule.name).join(', ')}`)
    return Promise.resolve(false)
}
```

- [ ] **Step 2: Load it.** In `app/landing.ejs` add after line 165 (`landing.js`):

```html
    <script src="./assets/js/scripts/modsetup.js"></script>
```

- [ ] **Step 3: Integrate into `dlAsync`** in `landing.js`

Change `const serv = distro.getServerById(ConfigManager.getSelectedServer())` to `let serv = …`.

After the three lines `setLaunchDetails(pleaseWait) / toggleLaunchArea(true) / setLaunchPercentage(0, 100)` and before `const fullRepairModule = new FullRepair(` insert:

```js
    // ION: resolve GitHub mods and collect manual downloads before Helios validates files.
    try {
        distro = await prepareIonModules(distro, ConfigManager.getSelectedServer())
    } catch(err) {
        loggerLaunchSuite.error('Error while preparing mods.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    if(distro == null){
        // The player cancelled the manual download step.
        toggleLaunchArea(false)
        return
    }
    serv = distro.getServerById(ConfigManager.getSelectedServer())
```

Inside `if(invalidFileCount > 0) { … }`, right after `setDownloadPercentage(100)` and before the `catch`, insert:

```js
            const corrupted = await findCorruptedGithubFiles(serv)
            if(corrupted.length > 0){
                loggerLaunchSuite.error(`GitHub mods failed verification: ${corrupted.join(', ')}`)
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), Lang.queryJS('landing.dlAsync.githubModCorrupted', { mods: corrupted.join(', ') }))
                return
            }
```

- [ ] **Step 4: Lang.** In `en_US.toml`, `[js.landing.dlAsync]` add:

```toml
githubModCorrupted = "The GitHub mod(s) {mods} did not match their release checksum after downloading. They were removed; please try again."
```

- [ ] **Step 5: Document the contract** in `docs/distro.md` (append at the end):

````markdown
## ION extensions (`ion` field)

The ION Launcher Manager adds an `ion` object to `ForgeMod`/`FabricMod` modules after Nebula
generates the index. Helios ignores it; ION-Launcher reads it before file validation.

```json
"ion": {
    "source": "modrinth" | "curseforge" | "github",
    "download": "hosted" | "direct" | "manual",
    "projectUrl": "https://modrinth.com/mod/sodium",
    "license": { "id": "LGPL-3.0-only", "name": "", "url": "https://..." } | null,
    "manual": { "pageUrl": "https://www.curseforge.com/minecraft/mc-mods/x/download/123", "fileName": "x-1.0.jar" },
    "github": { "repo": "owner/repo", "assetPattern": null, "prerelease": false, "tag": "v1.4.0", "sha256": "..." | null }
}
```

* `download: hosted`: the artifact is served by ION as usual.
* `download: direct`: `artifact.url` points at the platform's CDN (or a GitHub release asset); ION does not host the jar.
* `download: manual`: `artifact.url` is the mod's download **page**. The launcher asks the player to download the
  file (`manual.fileName`), validates it against `artifact.MD5`/`size`, and copies it into place before Helios runs.
  Manual mods whose file is missing and that the player disabled are removed from the on-disk index that Helios' child
  process reads.
* `source: github`: module id is `ion.github.<owner>:<repo>:<tag>@jar`. At launch the launcher looks up the newest
  release (`github.prerelease` includes pre-releases), picks the first asset matching `github.assetPattern`
  (default: first `.jar` that is not `-sources`/`-dev`/`-javadoc`/`-api`), rewrites id/url/size and verifies the file
  against the asset's SHA-256 digest (or size). The values in the index are the fallback when GitHub is unreachable.
````

- [ ] **Step 6: Verify**

`npm test` passes. `npm start` with a distribution whose server has GitHub and manual modules (point `REMOTE_DISTRO_URL` in `distromanager.js` at a local Manager-generated file, or use dev mode with `distribution_dev.json`):

- Press Play: the console logs `using GitHub release <tag>` the first time and nothing (304) afterwards; `<userData>/distribution.json` contains the rewritten GitHub module id; the jar lands under `common/mods/fabric/ion/github/<owner>/<repo>/<tag>/` (or `common/modstore/...` for Forge).
- With a manual mod enabled and missing, the launch stops (the stub returns false) and the Play button is restored.
- Disable that mod in Settings → Mods: the launch proceeds and the on-disk `distribution.json` lacks that module.

- [ ] **Step 7: Commit**

```bash
git add app/assets/js/scripts/modsetup.js app/landing.ejs app/assets/js/scripts/landing.js app/assets/lang/en_US.toml docs/distro.md
git commit -m "Resolve GitHub mods and handle manual mods before validating files" -m "Helios' FullRepair child re-reads distribution.json from disk, so the renderer resolves the newest GitHub release per custom mod, collects manual mods the player still needs, and writes the resolved index back before the child starts. Documents the ion field." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Manual download dialog

**Files:**
- Modify: `[L]/app/assets/js/scripts/modsetup.js` (replace the `showManualModsDialog` stub)
- Modify: `[L]/app/assets/lang/en_US.toml` (new `[js.landing.manualMods]`)
- Modify: `[L]/app/assets/css/tailwind.src.css:19-20` (`@source`)

**Interfaces:**
- Consumes: `acceptFile`, `isModuleFilePresent` (Task 15); globals `shell`, `remote`, `escapeHtml`, `Lang`.
- Produces: `showManualModsDialog(modules: HeliosModule[]): Promise<boolean>`.

- [ ] **Step 1: Replace the stub** in `modsetup.js` with:

```js
/**
 * Ask the player to download the given modules themselves, Prism-style: one "Open page" button
 * per mod, the Downloads folder is watched for the expected file, files can also be chosen or
 * dropped. Resolves true once every file is in place, false when the player cancels.
 */
function showManualModsDialog(modules){
    const { webUtils } = require('electron')
    const downloadsDir = remote.app.getPath('downloads')
    const t = (key, vars) => escapeHtml(Lang.queryJS(`landing.manualMods.${key}`, vars))

    return new Promise(resolve => {
        const pending = new Map(modules.map(m => [m.rawModule.id, m]))
        const rows = new Map()

        const dialog = document.createElement('div')
        dialog.className = 'ion-shell fixed inset-0 z-[100] flex items-center justify-center bg-black/70'
        dialog.innerHTML = `
            <div class="ion-rise w-[620px] max-w-[calc(100vw-40px)] rounded-xl border border-white/10 bg-ionGray p-6 text-white shadow-[0_22px_45px_-14px_rgba(0,0,0,0.8)]">
                <h2 class="text-lg font-bold">${t('title')}</h2>
                <p class="mt-1 text-sm text-neutral-400">${t('description', { folder: downloadsDir })}</p>
                <ul data-manual="list" class="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1"></ul>
                <p data-manual="hint" class="mt-3 text-xs text-neutral-500">${t('dropHint')}</p>
                <div class="mt-5 flex items-center justify-between gap-2">
                    <button type="button" data-manual="openAll" class="rounded-lg bg-white/10 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-white/20">${t('openAll')}</button>
                    <div class="flex gap-2">
                        <button type="button" data-manual="cancel" class="rounded-lg px-4 py-2 text-sm text-neutral-300 hover:bg-white/10">${t('cancel')}</button>
                        <button type="button" data-manual="continue" disabled class="play-button rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">${t('continue')}</button>
                    </div>
                </div>
            </div>`

        const list = dialog.querySelector('[data-manual="list"]')
        for(const mdl of modules){
            const raw = mdl.rawModule
            const li = document.createElement('li')
            li.className = 'flex items-center gap-3 rounded-lg border border-white/10 bg-ionGrayer px-3 py-2'
            li.innerHTML = `
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">${escapeHtml(raw.name)} <span class="font-mono text-[11px] text-neutral-500">${escapeHtml(mdl.getMavenComponents()?.version ?? '')}</span></p>
                    <p class="truncate font-mono text-[11px] text-neutral-500" title="${escapeHtml(raw.ion.manual.fileName)}">${escapeHtml(raw.ion.manual.fileName)}</p>
                </div>
                <span data-status class="shrink-0 rounded-full bg-ionWarn/20 px-2 py-0.5 text-[11px] font-medium text-[#f0c070]">${t('waiting')}</span>
                <button type="button" data-open class="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20">${t('openPage')}</button>
                <button type="button" data-choose class="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20">${t('chooseFile')}</button>`
            li.querySelector('[data-open]').onclick = () => shell.openExternal(raw.ion.manual.pageUrl)
            li.querySelector('[data-choose]').onclick = async () => {
                const { canceled, filePaths } = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
                    properties: ['openFile'],
                    filters: [{ name: 'Minecraft mod', extensions: ['jar'] }]
                })
                if(canceled || filePaths.length === 0) return
                if(!await tryAccept(mdl, filePaths[0])) flash(li, t('wrongFile'))
            }
            rows.set(raw.id, li)
            list.appendChild(li)
        }

        function flash(li, text){
            const status = li.querySelector('[data-status]')
            const original = status.textContent
            status.textContent = text
            status.classList.add('bg-ionCritical/20', 'text-[#f1a19b]')
            setTimeout(() => {
                if(status.textContent === text){
                    status.textContent = original
                    status.classList.remove('bg-ionCritical/20', 'text-[#f1a19b]')
                }
            }, 2500)
        }

        async function tryAccept(mdl, file){
            try {
                if(!await acceptFile(mdl, file)) return false
            } catch(err) {
                loggerModSetup.warn(`Could not accept ${file}`, err)
                return false
            }
            markDone(mdl)
            return true
        }

        function markDone(mdl){
            const id = mdl.rawModule.id
            if(!pending.delete(id)) return
            const li = rows.get(id)
            const status = li.querySelector('[data-status]')
            status.textContent = Lang.queryJS('landing.manualMods.found')
            status.className = 'shrink-0 rounded-full bg-ionGood/20 px-2 py-0.5 text-[11px] font-medium text-[#7fd9c4]'
            for(const b of li.querySelectorAll('button')) b.disabled = true
            li.classList.add('opacity-70')
            if(pending.size === 0) dialog.querySelector('[data-manual="continue"]').disabled = false
        }

        // Pick up files the player saved to Downloads (polling covers editors that don't emit watch events).
        async function scanDownloads(){
            for(const mdl of [...pending.values()]){
                const candidate = path.join(downloadsDir, mdl.rawModule.ion.manual.fileName)
                if(await fsx.pathExists(candidate)) await tryAccept(mdl, candidate)
            }
        }
        const poll = setInterval(() => { scanDownloads().catch(() => {}) }, 1500)
        let watcher = null
        try {
            watcher = require('fs').watch(downloadsDir, () => { scanDownloads().catch(() => {}) })
        } catch(err) {
            loggerModSetup.warn('Cannot watch the Downloads folder; polling only.', err)
        }

        dialog.ondragover = e => { e.preventDefault() }
        dialog.ondrop = async e => {
            e.preventDefault()
            for(const file of e.dataTransfer.files){
                const filePath = webUtils.getPathForFile(file)
                let accepted = false
                for(const mdl of [...pending.values()]){
                    if(await tryAccept(mdl, filePath)){ accepted = true; break }
                }
                if(!accepted) dialog.querySelector('[data-manual="hint"]').textContent = Lang.queryJS('landing.manualMods.droppedWrongFile', { file: file.name })
            }
        }

        function close(result){
            clearInterval(poll)
            watcher?.close()
            dialog.remove()
            resolve(result)
        }
        dialog.querySelector('[data-manual="openAll"]').onclick = () => {
            for(const mdl of pending.values()) shell.openExternal(mdl.rawModule.ion.manual.pageUrl)
        }
        dialog.querySelector('[data-manual="cancel"]').onclick = () => close(false)
        dialog.querySelector('[data-manual="continue"]').onclick = () => close(true)

        document.body.appendChild(dialog)
        scanDownloads().catch(() => {})
    })
}
```

Note `mdl.getMavenComponents()` is public on `HeliosModule` (the settings tab reads the private `mavenComponents` field directly; don't copy that).

- [ ] **Step 2: Lang.** Append to `en_US.toml` after `[js.landing.dlAsync]`:

```toml
[js.landing.manualMods]
title = "Some mods need a manual download"
description = "Their authors don't allow launchers to fetch them. Open each download page and save the file. The launcher picks it up from {folder} automatically, or choose the file yourself."
dropHint = "You can also drop the downloaded files onto this window."
droppedWrongFile = "{file} is not one of the expected files."
waiting = "Waiting for file"
found = "Ready"
wrongFile = "Not the expected file"
openPage = "Open page"
chooseFile = "Choose file…"
openAll = "Open all pages"
cancel = "Cancel"
continue = "Continue"
```

- [ ] **Step 3: Tailwind source.** In `app/assets/css/tailwind.src.css` after `@source "../js/scripts/shell.js";` add:

```css
@source "../js/scripts/modsetup.js";
```

Run `npm run build:css` and confirm `app/assets/css/ion.css` now contains `.max-w-\[calc\(100vw-40px\)\]` (grep for `100vw-40px`).

- [ ] **Step 4: Verify** manually (`npm start`, distribution with a manual mod that is enabled and missing):

- Pressing Play shows the dialog listing the mod with its expected file name; Continue is disabled.
- "Open page" opens the CurseForge download page in the browser. Saving the file to Downloads flips the row to "Ready" within ~2 s and enables Continue; Continue proceeds to validation and the game launches with the mod in place (check `common/modstore/...` or `common/mods/fabric/...`).
- "Choose file…" with a wrong jar flashes "Not the expected file"; dropping the right jar onto the dialog accepts it.
- Cancel restores the Play button.

- [ ] **Step 5: Commit**

```bash
git add app/assets/js/scripts/modsetup.js app/assets/lang/en_US.toml app/assets/css/tailwind.src.css
git commit -m "Ask players to download blocked mods themselves before launching" -m "Lists the missing manual-download mods with an Open page button each, watches the Downloads folder for the expected file names, validates against the index's MD5 and copies the files into place. Files can also be chosen or dropped." -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Source and download badges in Settings → Mods

**Files:**
- Modify: `[L]/app/assets/js/scripts/settings.js:732-795` (`parseModulesForUI`, new `ionModBadges`)
- Modify: `[L]/app/assets/css/ion-theme.css` (after the `.settingsModVersion` rule, ~line 784)
- Modify: `[L]/app/assets/lang/en_US.toml` (new `[js.settings.ionMods]`, `[js.settings.ionMods.source]`)

**Interfaces:**
- Consumes: `ion` module field; globals `escapeHtml` (shell.js), `Lang`; `uicore.js`'s global click handler that opens `a[href^="http"]` externally.
- Produces: `ionModBadges(mdl: HeliosModule): string` (HTML).

- [ ] **Step 1: Add the helper** to `settings.js`, right before `parseModulesForUI`:

```js
/**
 * Badges for ION's distribution extensions: where a mod comes from and how it is obtained.
 * GitHub mods are shown prominently with a link to the repository; manual-download mods link to
 * their download page. Links open in the browser (uicore.js handles `a[href^="http"]`).
 *
 * @param {Object} mdl The module.
 * @returns {string} HTML, or an empty string for plain modules.
 */
function ionModBadges(mdl){
    const ion = mdl.rawModule.ion
    if(ion == null) return ''
    const badges = []
    if(ion.source === 'github' && ion.github){
        const href = ion.projectUrl || `https://github.com/${ion.github.repo}`
        badges.push(`<a class="settingsModBadge settingsModBadgeGithub" href="${escapeHtml(href)}" title="${escapeHtml(Lang.queryJS('settings.ionMods.githubTitle', { repo: ion.github.repo }))}">${escapeHtml(Lang.queryJS('settings.ionMods.github', { tag: ion.github.tag }))}</a>`)
    } else if(ion.projectUrl){
        badges.push(`<a class="settingsModBadge" href="${escapeHtml(ion.projectUrl)}" title="${escapeHtml(Lang.queryJS('settings.ionMods.sourceTitle'))}">${escapeHtml(Lang.queryJS(`settings.ionMods.source.${ion.source}`))}</a>`)
    }
    if(ion.download === 'manual' && ion.manual){
        badges.push(`<a class="settingsModBadge settingsModBadgeManual" href="${escapeHtml(ion.manual.pageUrl)}" title="${escapeHtml(Lang.queryJS('settings.ionMods.manualTitle'))}">${escapeHtml(Lang.queryJS('settings.ionMods.manual'))}</a>`)
    }
    return badges.length > 0 ? `<span class="settingsModBadges">${badges.join('')}</span>` : ''
}
```

In both templates inside `parseModulesForUI` (required and optional rows), add a line right after `<span class="settingsModVersion">v${mdl.mavenComponents.version}</span>`:

```js
                                ${ionModBadges(mdl)}
```

- [ ] **Step 2: Styles.** In `ion-theme.css` after the `.settingsModVersion { color: var(--ion-text-dim); }` rule add:

```css
/* Source / download badges (ION distribution extensions). */
.settingsModBadges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
}
.settingsModBadge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: var(--ion-pill);
    border: 1px solid var(--ion-line);
    background: var(--ion-surface-sunken);
    color: var(--ion-text-soft);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-decoration: none;
    transition: color var(--ion-ease), border-color var(--ion-ease);
}
.settingsModBadge:hover,
.settingsModBadge:focus {
    color: #fff;
    border-color: var(--ion-line-hover);
}
.settingsModBadgeGithub {
    color: #fff;
    border-color: transparent;
    background: var(--ion-aqua);
}
.settingsModBadgeGithub:hover,
.settingsModBadgeGithub:focus {
    background: var(--ion-aquaer);
    border-color: transparent;
}
.settingsModBadgeManual {
    color: #fff;
    border-color: transparent;
    background: var(--ion-warn);
}
```

(If `--ion-pill` or `--ion-ease` doesn't exist at `ion-theme.css:17-58`, use `999px` and `0.15s ease` respectively.)

- [ ] **Step 3: Lang.** Append after `[js.settings.dropinMods]`:

```toml
[js.settings.ionMods]
github = "GitHub · {tag}"
githubTitle = "Downloaded from the newest release of {repo}. Click to open the repository."
sourceTitle = "Open the mod's page."
manual = "Manual download"
manualTitle = "This mod's author doesn't allow launchers to download it. Click to open its download page."

[js.settings.ionMods.source]
modrinth = "Modrinth"
curseforge = "CurseForge"
```

- [ ] **Step 4: Verify** `npm start` → Settings → Mods: a GitHub mod shows a filled aqua "GITHUB · v1.4.0" badge under its version, clicking it opens the repository in the browser; a manual mod shows an amber "MANUAL DOWNLOAD" badge opening its download page; a Modrinth-hosted mod shows a quiet "MODRINTH" link. Toggling optional mods still works and `Done` still saves (`_saveModConfiguration` finds every `[formod]`).

- [ ] **Step 5: Commit**

```bash
git add app/assets/js/scripts/settings.js app/assets/lang/en_US.toml
git add -p app/assets/css/ion-theme.css   # only the badge rules; the .settingsTab padding is foreign work
git commit -m "Show GitHub and manual-download mods clearly in the mod list" -m "Assisted-by: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: End-to-end verification

**Files:** none created; this task checks the two repos together.

- [ ] **Step 1: Manager checks.** In `[M]`: `pnpm check` → 0 errors, `pnpm test` → all pass, `pnpm build` succeeds.

- [ ] **Step 2: Build a test distribution.** With `pnpm dev` and a Nebula root containing a Fabric server:
  1. Upload a Modrinth MIT mod (e.g. Sodium) and a Modrinth ARR mod; both match by hash. Mods tab shows "Hosted by ION" and "Direct download".
  2. Upload a jar that will not match (rename a mod jar, e.g. `mystery.jar`). It shows "Needs review"; match it through "Match…" using the real project; the badge appears.
  3. On the Licenses tab override Sodium to "Manual download" with the note `test`.
  4. Add the custom mod `https://github.com/IrisShaders/Iris`.
  5. Generate the distribution. Confirm in `NEBULA_ROOT/distribution.json`: Sodium module has `ion.download: "manual"` and its `artifact.url` is a modrinth.com page; the ARR mod's `artifact.url` is on `cdn.modrinth.com`; the last module is `ion.github.IrisShaders:Iris:<tag>@jar`. `meta/ion-private-paths.txt` lists two paths.

- [ ] **Step 3: Launcher checks.** In `[L]`: `npm test` passes, `npm run build:css` succeeds. Serve the Nebula root locally (e.g. `python3 -m http.server 3000` inside `NEBULA_ROOT`, with the Manager's `BASE_URL` set to `http://localhost:3000`) and point the launcher at it (dev mode: copy `distribution.json` to `<userData>/distribution_dev.json`).
  1. Press Play: the manual dialog lists Sodium; "Open page" opens Modrinth; download the exact file; the row turns "Ready"; Continue; the game launches.
  2. Settings → Mods shows the badges from Task 17 and the Iris version equals GitHub's newest tag.
  3. Disable an optional manual mod and delete its file from `common/mods/fabric/...`; Play launches without a dialog.

- [ ] **Step 4: Record results.** Note any deviation in the final report; nothing is committed in this task.

---

## Self-review notes

- **Spec coverage:** matching on import (Task 9) and by hand (Tasks 5, 10); license fetch (Task 4); recommendation (Task 2); overrides with notes and UI (Tasks 3, 11); manual download flow (Tasks 15, 16); custom GitHub mods in Manager (Tasks 7, 12), in the distribution (Task 8) and in the launcher incl. clickable badge (Tasks 13–15, 17); Nebula untouched.
- **Type consistency:** `ModPolicy.effective`, `policy.key` and `PolicyOverride` names are identical in Tasks 2, 3, 10, 11; `IonModuleMeta` fields in Task 1 match what `annotateModule`/`customModToModule` (Task 8) write and what `ionmods.js` (Task 13) and `modsetup.js` (Task 15) read; `DEFAULT_ASSET_PATTERN` is byte-identical in `github-release.ts` and `ionmods.js`; the GitHub module id format `ion.github.<owner>:<repo>:<tag>@jar` is produced by `customModuleId` and consumed by `applyRelease` via `raw.id.split(':')`.
- **Review Focus coverage:** item 1 → Task 8 test `decodes Nebula mod URLs`; item 2 → Task 2 test with `license: null`; item 3 → Task 2 `isAllowedOverride` plus the 400 in `setPolicyOverride` (Task 3); item 4 → Task 6 `returns null when nothing matches` and Task 13 `applyRelease … no usable asset`; item 5 → Task 13 `pruneUnavailableManualModules` test and Task 15 Step 6 manual check.
