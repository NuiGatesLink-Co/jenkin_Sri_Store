import * as net from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The address to record in `audit_log.ip`, or null when it is not one Postgres `inet` accepts.
 * Node accepts an IPv6 zone id (`fe80::1%eth0`); `inet` does not, and a failed audit insert rolls
 * the business write back.
 */
export function toInet(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate || candidate.includes('%') || net.isIP(candidate) === 0) return null;
  return candidate;
}

/**
 * The caller's address as our nginx saw it (#132).
 *
 * Assumes exactly one trusted proxy hop: nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for`,
 * which APPENDS its `$remote_addr` to whatever the client sent. Only the rightmost entry is
 * nginx's; everything left of it is client-controlled. Without the header (a direct hit on the
 * app, as in e2e) `req.ip` is the socket address.
 */
export function clientIp(req: { headers: IncomingHttpHeaders; ip?: string }): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (header) return toInet(header.split(',').at(-1));
  return toInet(req.ip);
}
