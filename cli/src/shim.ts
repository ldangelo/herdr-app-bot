import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Escapes `value` for safe interpolation inside single quotes in a POSIX sh script (handles spaces,
 * `$`, backticks, and embedded double quotes -- app bundles and user home directories can contain any
 * of these). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ShimOptions {
  /** The desktop app ships a compiled copy of the CLI and runs it through its own Electron binary
   * (`<execPath>` is `process.execPath`, `<mainPath>` the compiled `dist/cli/src/main.js`) instead of a
   * system `node`; `ELECTRON_RUN_AS_NODE=1` makes that binary behave as plain Node for this one exec. */
  readonly electronRunAsNode?: boolean;
}

export function shimScript(nodePath: string, mainPath: string, home: string, options: ShimOptions = {}): string {
  const prefix = options.electronRunAsNode === true ? "ELECTRON_RUN_AS_NODE=1 " : "";
  return `#!/bin/sh\nexport HERDR_BOT_HOME=${shQuote(home)}\n${prefix}exec ${shQuote(nodePath)} ${shQuote(mainPath)} "$@"\n`;
}

/** Writes (and chmods) `<home>/bin/herdr-bot` only when its content would actually change, so repeated
 * calls -- the desktop app does this on every start -- do not disturb the file's mtime/permissions for
 * no reason. */
export function installShim(home: string, nodePath: string, mainPath: string, options: ShimOptions = {}): string {
  const dir = join(home, "bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "herdr-bot");
  const content = shimScript(nodePath, mainPath, home, options);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (existing !== content) {
    writeFileSync(path, content, "utf8");
    chmodSync(path, 0o755);
  }
  return path;
}

/** The shim for a compiled binary that is not itself at `<home>/bin/herdr-bot`: just run it, with the home set. */
export function standaloneShimScript(binaryPath: string, home: string): string {
  return `#!/bin/sh\nexport HERDR_BOT_HOME=${shQuote(home)}\nexec ${shQuote(binaryPath)} "$@"\n`;
}

/** True when both paths are the same file, seeing through symlinks (macOS temp dirs are `/var/...` -> `/private/var/...`). */
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

/** Only a script we wrote may be replaced: anything else at that path (a compiled binary, a user's own file) is not ours. */
function isOurShim(content: string): boolean {
  return content.startsWith("#!/bin/sh\nexport HERDR_BOT_HOME=");
}

/**
 * A compiled binary installed at `<home>/bin/herdr-bot` IS the command bots call, so it must never be overwritten
 * with a script; one living anywhere else gets a tiny shim at that path. Returns the path bots should call.
 * Throws rather than replace a file that is not one of our shims.
 */
export function installStandaloneShim(home: string, binaryPath: string): string {
  const dir = join(home, "bin");
  const path = join(dir, "herdr-bot");
  if (existsSync(path) && sameFile(binaryPath, path)) return path;
  mkdirSync(dir, { recursive: true });
  const content = standaloneShimScript(binaryPath, home);
  if (existsSync(path)) {
    const existing = readFileSync(path);
    // Look at raw bytes first so a large binary is never decoded as text.
    if (existing.length > 64 * 1024 || !isOurShim(existing.toString("utf8"))) throw new Error(`${path} exists and is not a herdr-bot shim; not replacing it`);
    if (existing.toString("utf8") === content) return path;
  }
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
  return path;
}
