import { describe, it, expect } from 'vitest';
import { clientIp, toInet } from './client-ip.js';

const req = (xff: string | undefined, ip?: string) => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  ip,
});

describe('clientIp', () => {
  it('takes the entry nginx appended, not the one the client sent', () => {
    expect(clientIp(req('1.1.1.1, 10.0.0.5', '172.18.0.2'))).toBe('10.0.0.5');
  });

  it('takes a single entry', () => {
    expect(clientIp(req('203.0.113.7', '172.18.0.2'))).toBe('203.0.113.7');
  });

  it('drops an IPv6 zone id', () => {
    expect(clientIp(req('1.1.1.1, fe80::1%eth0'))).toBeNull();
  });

  it('drops garbage', () => {
    expect(clientIp(req('1.1.1.1, not-an-ip'))).toBeNull();
  });

  it('falls back to req.ip when the header is missing', () => {
    expect(clientIp(req(undefined, '::ffff:127.0.0.1'))).toBe('::ffff:127.0.0.1');
    expect(clientIp(req(undefined))).toBeNull();
  });
});

describe('toInet', () => {
  it('keeps a valid address and rejects a list', () => {
    expect(toInet(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(toInet('1.1.1.1, 10.0.0.5')).toBeNull();
  });
});
