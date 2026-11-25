# Releasing the herdr-bot host

The herdr-app mod does not bundle the host. On first use it downloads a standalone `herdr-bot` binary (the host and the
`herdr-bot` command in one file), checks its SHA-256 against a manifest, and installs it to `~/.herdr-bot/bin/herdr-bot`.
This is how that binary gets published.

## Cutting a release

1. Bump the version in **all** of these (tests fail if they drift):
   - `package.json` (`version`)
   - `core/src/version.ts` (`HOST_VERSION`), checked by `core/test/version.test.ts`
   - `mod/herdr-bot/version.js` (`REQUIRED_HOST_VERSION`), checked by `mod/test/version.test.js`
2. Merge to `main`, then tag and push: `git tag host-v1.4.0 && git push origin host-v1.4.0`.
3. `.github/workflows/host-release.yml` builds each platform, runs the serve tests against the native builds, merges the
   per-platform manifests (re-verifying every checksum) and creates the release `host-v1.4.0`.

The tag is `host-v<version>`, not `v<version>`: the desktop app's workflow owns `v*.*.*`, and the mod downloads by exact
tag (`.../releases/download/host-v<REQUIRED_HOST_VERSION>`), never `releases/latest`, which any app release would take over.

## What a release contains

`herdr-bot-<os>-<arch>` per platform, a `.sha256` beside each, and `manifest.json`:

```json
{ "version": "1.4.0", "assets": { "darwin-arm64": { "file": "herdr-bot-darwin-arm64", "sha256": "…", "size": 87653106 } } }
```

Platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`. Windows is not supported yet. The two non-native
builds per run (`darwin-x64`, `linux-arm64`) are cross-compiled and not run in CI; try one on real hardware before
announcing a release.

## Building locally

`npm run host:build` builds for this machine into `dist/host/` (needs [bun](https://bun.sh)); `--target <key>` and `--out`
change that. macOS builds are ad-hoc code-signed (Apple silicon refuses an unsigned executable), so a macOS target can only
be built on macOS.

To exercise the whole download path against a build: serve `dist/host` on loopback (any static server), put
`{"hostSource": "http://127.0.0.1:<port>"}` in `<herdr-app home>/herdr-bot.json`, and open the mod.

## How the mod decides the host is acceptable

When it connects, the host sends its version. The mod accepts the same major version at least as new as
`REQUIRED_HOST_VERSION`; anything else (including a host from before versions existed) gets an update prompt that
downloads the required release, stops the old host (its bots keep running) and starts the new one.

## Trust

The checksum catches a damaged or truncated download. The manifest comes from the same place as the binary, so it does not
protect against a compromised release: the release source itself is what is trusted. Signing the manifest is the next step
if that matters.
