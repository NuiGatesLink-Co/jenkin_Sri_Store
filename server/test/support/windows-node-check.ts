/**
 * #160: on Windows, Node builds whose bundled libuv predates libuv commit aabb765
 * ("win: properly initialize OSVERSIONINFOW", libuv#5107) crash at random with exit
 * code 0xC0000409 — Vitest reports it only as "Worker exited unexpectedly".
 *
 * `uv__is_fast_loopback_fail_supported()` (deps/uv/src/win/tcp.c) passes a stack
 * `OSVERSIONINFOW` to `RtlGetVersion` without setting `dwOSVersionInfoSize`. When the
 * stack garbage in that field happens to equal `sizeof(OSVERSIONINFOEXW)`, Windows
 * writes the 8-byte EX tail past the buffer, over the function's /GS stack cookie,
 * and the process fast-fails on the next loopback `connect()` (every pg, Redis and
 * supertest socket in this suite is 127.0.0.1). Three crash dumps from this machine
 * show it byte for byte — see server/README.md *The e2e suite*.
 *
 * Linux (CI) never runs that file. The fix ships in Node 24.16.0+ and 26.1.0+; the
 * 22.x and 25.x lines did not have it as of 2026-09-14.
 */
export function hasWindowsLoopbackCrashBug(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major <= 23 || major === 25) return true;
  if (major === 24) return minor < 16;
  if (major === 26) return minor < 1;
  return false;
}

export default function setup(): void {
  if (process.platform !== 'win32' || !hasWindowsLoopbackCrashBug(process.version)) return;
  console.warn(
    `\n#160: Node ${process.version} on Windows has a libuv bug that randomly kills an e2e ` +
      'worker with exit code 0xC0000409 ("Worker exited unexpectedly") and drops that ' +
      "file's tests. Upgrade to Node 24.16.0 or later. See server/README.md *The e2e suite*.\n",
  );
}
