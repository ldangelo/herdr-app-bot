// Pure helpers for scripts/build-host.mjs, kept apart so they can be tested without compiling anything.

const TARGETS = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
};

export const PLATFORM_KEYS = Object.keys(TARGETS);

/** `process.platform`/`process.arch` as the key used in the manifest and in file names ("darwin-arm64"). */
export function platformKey(platform, arch) {
  const os = platform === "win32" ? "windows" : platform;
  const key = `${os}-${arch}`;
  if (!(key in TARGETS)) throw new Error(`no standalone host build for ${platform}/${arch}`);
  return key;
}

export function bunTarget(key) {
  const target = TARGETS[key];
  if (target == null) throw new Error(`unknown host target "${key}" (one of ${PLATFORM_KEYS.join(", ")})`);
  return target;
}

export function assetFileName(key) {
  return `herdr-bot-${key}${key.startsWith("windows-") ? ".exe" : ""}`;
}

/**
 * Adds one built asset to a manifest (creating it, or replacing that platform's entry), so builds for several
 * platforms, possibly on different machines, can each add theirs. A different version starts a fresh manifest:
 * mixing assets of two versions would let an old checksum meet a new file.
 */
export function mergeManifest(existing, version, key, asset) {
  const base = existing != null && existing.version === version && typeof existing.assets === "object" && existing.assets !== null ? existing : { version, assets: {} };
  return { version, assets: { ...base.assets, [key]: { file: asset.file, sha256: asset.sha256, size: asset.size } } };
}
