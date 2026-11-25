/**
 * The version of this host. Kept as a constant (not read from package.json at runtime) because the desktop app
 * compiles the host into a different directory layout; core/test/version.test.ts fails if it drifts from package.json.
 * The herdr-app mod asks for a host at least this new (mod/herdr-bot/version.js), so bump both with a release.
 */
export const HOST_VERSION = "1.4.0";
