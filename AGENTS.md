# AGENTS.md

This file is for an AI agent (or a human contributor) making a change in this repository, and especially for walking through a release. The user-facing docs are [`README.md`](README.md); this file is for *where a change goes* and *how to ship it*, not for the WeCom setup steps README.md already covers.

## What this repository is

A minimal DSH (DeepSeek Harness) plugin: the instant DSH stops and waits for a human, push one markdown message to a WeCom (企业微信) group robot. Three files carry all the runtime behavior:

- [`index.js`](index.js) — the Host half. Cordis glue (`apply`, `Config`), the five trigger listeners, the WeCom markdown encoder, and DSH-language-setting detection all live in this one file on purpose (see "Hard constraints" below) — this is deliberately **not** split into `src/host/{triggers,templates,channels}.ts` the way a larger notification plugin might be, because this plugin only ever talks to one channel in one format.
- [`client.js`](client.js) — the plugin's configuration page on DSH's sidebar **Plugins** entry: one URL field, rendered through `plugins.bundle.config` + `ctx.configForms`. Plain classic script in the client module loader's lazy-CJS factory format (`window.__ModuleLoader__.load({...})`) — no JSX, no bundler, no build step. React comes from the page's own module table at runtime.
- [`index.test.js`](index.test.js) — `node:test` coverage for `index.js`, run against a fake Cordis `ctx`.

There is no TypeScript, no bundler, and no `dist/`: the files above are exactly what ships to npm and exactly what DSH loads.

## Commands

```sh
pnpm install
pnpm test             # node --test
pnpm run verify        # node --check index.js && node --check client.js && pnpm test
```

`verify` is the full self-check for this repo: there is no compiler to catch a broken reference, so `node --check` on both runtime files is the (small) stand-in for a build step, followed by the actual test suite. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs exactly `pnpm run verify` on Node 22, 24, and 26 for every push to `main` and every pull request.

## Every change ends with `pnpm run verify`

1. It must pass with no errors and no failing tests before a change is considered done.
2. A change to `index.js`'s exported behavior (a new trigger, a changed render shape, a changed locale-resolution rule) gets a matching case added to `index.test.js` in the **same change** — see `test('the title follows DSH's own language setting...')` for the pattern used to stub `configEditor` deterministically (never let a test depend on the real host OS/`Intl` locale).
3. A change to `client.js` has no automated coverage (no DOM/React test harness here) — verify it by hand: install the plugin in a real DSH profile (`dsh plugin --profile <p> add .` from this checkout, or edit the profile's `cordis.patch.yml` to point `name:` at an absolute path), open sidebar → Plugins → dsh-wecom-notification, and confirm the field loads, saves, and the saved value round-trips into `cordis.patch.yml`.
4. If the change alters anything README.md documents for the end user (triggers, message shape, config field, install steps, the group-creation walkthrough): update README.md in the same change. There is no `README.zh.md` to keep in sync — this repository ships Chinese-only user docs by design, since the WeCom walkthrough is inherently China-specific.

## Hard constraints (do not undo these deliberately-made decisions)

- **`Config.url` must stay `.volatile()`.** That is what lets `client.js` write a saved URL straight into the live plugin via `ctx.configForms` / `plugins.bundle.config` without DSH unloading and reloading the plugin instance. Making it a plain (non-volatile) field would silently break the config page's "saves apply immediately" behavior.
- **`currentLocale()` reads DSH's own language setting — never reintroduce an env var.** It reads the `locale` plugin row's volatile `preference` field (Settings → General → Language) through the optional `configEditor` service, falls back to the host OS/`Intl` locale, and only then defaults to `zh`. A `DSH_NOTIFY_LANG`-style escape hatch was deliberately removed; see the repository history (`git log -p -- index.js` around the commit titled "Drop dsh-webhook-notification references; follow DSH's own language setting") for why.
- **One message format only: WeCom's `{msgtype: 'markdown'}`.** This plugin does not grow a generic-webhook mode, a second channel type (macOS, Slack, Feishu, ...), or a per-channel template override — that is the explicit scope boundary that keeps `index.js` a single small file. A request for another channel/format is a new plugin, not a feature added here.
- **No build step, ever.** `index.js` and `client.js` are published byte-for-byte as written. Do not add TypeScript, a bundler, or a `prepare`/`prepack` compile step "to clean things up" — that would reopen exactly the "needs a build before it runs" problem this repository avoids, and would break the `file:`/`link:` local-install path DSH plugin development relies on.
- **`@deepseek-ai/schemastery` stays a `peerDependency`, with a `devDependency` pinned to the identical range.** The peer is what resolves to the copy DSH's own installation ships at runtime (see `docs/user/develop/basic/publish.md` in a DSH source checkout: "packages whose instances the plugin must share with the host" go under both `peerDependencies` and `devDependencies`). The dev copy exists only so `pnpm install`/`pnpm test` have something to resolve locally and in CI. **Dependabot only ever proposes the devDependency bump** (see `.github/dependabot.yml`'s comment) — widen `peerDependencies` to match in the same PR, by hand, or the two silently drift apart and a user on an older/newer DSH could get a schema mismatch this repository's own tests would never catch.

## Releasing

### One-time setup, before the very first tag push

This package has never been published (`npm view dsh-wecom-notification` 404s as of this writing), and [`release.yml`](.github/workflows/release.yml) authenticates purely through npm's zero-token OIDC Trusted Publishing — which requires a Trusted Publisher to already be configured **on an existing package**. Nothing in this repository can do that bootstrap step for you (it needs your npm login + 2FA); do it once, by hand, before the first `v0.1.0` tag:

1. From a clean checkout, `pnpm run verify`, then `npm login` (if not already) and `npm publish` once — a plain, un-staged, classic publish, so `0.1.0` is live and you own the package name immediately. (Staged publishing can also *create* a brand-new package non-interactively via a granular access token — see npm's ["staged publishing now supports creating new packages"](https://github.blog/changelog/2026-10-02-npm-staged-publishing-now-supports-creating-new-packages) — but a one-time manual `npm publish` is simpler and needs no token to manage afterward.)
2. On npmjs.com → the package's **Settings → Trusted Publisher** → add a GitHub Actions publisher: repository `lastorder/dsh-wecom-notification`, workflow file `.github/workflows/release.yml`. Restrict it to **stage-only** (no "publish directly"), matching the posture `release.yml`'s own comments describe.
3. From then on, every `vX.Y.Z` tag push runs fully automated with no npm token anywhere in this repository or its secrets.

### Every release after that

1. Edit `package.json`'s `version`.
2. Commit as `Release vX.Y.Z: <summary>` — this exact commit message becomes the GitHub Release body verbatim (see `release.yml`'s "Read the release notes from the tagged commit" step).
3. `git tag -a vX.Y.Z -m "..."` and `git push --tags` (or `git push origin vX.Y.Z`).
4. [`release.yml`](.github/workflows/release.yml) runs `pnpm run verify`, checks the tag matches `package.json`'s version, then `npm stage publish` via OIDC, packs a tarball, and creates a GitHub Release **marked pre-release**.
5. **You still have to approve it.** The Trusted Publisher is stage-only on purpose: even a fully automated, fully green workflow run only gets the new version into npm's stage queue. Go to `https://www.npmjs.com/package/dsh-wecom-notification?activeTab=versions` (or run `npm stage ls` / `npm stage approve`, 2FA required) to actually make it installable. After approving, edit the GitHub Release and uncheck "pre-release".

Do not run `npm publish`/`npm stage publish` by hand for an ordinary release — only to recover from a CI outage, and even then run `pnpm run verify` first. Do not add a second workflow or script that publishes; `release.yml` is the only path, and the npm Trusted Publisher must stay stage-only (never flip it to "publish directly" from CI) — the human approval step is the actual control, not a formality.

## CI/release infrastructure notes

- **Third-party GitHub Actions are pinned to a full commit SHA**: `softprops/action-gh-release` runs in a job holding `contents: write` and `id-token: write`, so a moved tag on that repository would be a direct path into this repository's release pipeline. First-party `actions/*` and `pnpm/*` steps may stay on major tags. Dependabot proposes the new SHA with its version comment updated — read the diff before merging, don't just approve it blind.
- `.github/dependabot.yml` groups GitHub Actions bumps into one weekly PR, and schemastery's devDependency bump into its own weekly PR (see the hard constraint above about keeping the peer range in sync by hand).

## Editing this file

No Chinese counterpart by design, same reasoning as the reference project this repository's release tooling was adapted from: this file is read by tooling and by whoever is driving the next release, not by the end user. Keep it scoped to *where a change goes* and *how to ship it*; README.md owns everything about what the plugin does and how a human sets up WeCom.
