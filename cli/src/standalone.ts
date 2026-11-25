/**
 * Whether this process is a compiled single-file binary (`bun build --compile`) rather than `node main.ts`.
 * A compiled Bun program's modules live in a virtual filesystem (`/$bunfs/root/...`, `B:/~BUN/root/...` on Windows),
 * so its own `import.meta.url` says so. Pass `import.meta.url` of a module in the bundle.
 */
export function isStandaloneBinary(moduleUrl: string): boolean {
  return moduleUrl.includes("/$bunfs/") || moduleUrl.includes("/~BUN/");
}
