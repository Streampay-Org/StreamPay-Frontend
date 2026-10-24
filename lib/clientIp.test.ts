import { resolveClientIp, normaliseIp } from './clientIp';

describe('lib/clientIp', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TRUST_PROXY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('normaliseIp', () => {
    it('returns unknown for empty or whitespace-only strings', () => {
      expect(normaliseIp('')).toBe('unknown');
      expect(normaliseIp('   ')).toBe('unknown');
    });

    it('returns IPv4 as-is', () => {
      expect(normaliseIp('192.168.1.1')).toBe('192.168.1.1');
      expect(normaliseIp('  10.0.0.1  ')).toBe('10.0.0.1');
    });

    it('strips port from IPv4 address', () => {
      expect(normaliseIp('192.168.1.1:8080')).toBe('192.168.1.1');
    });

    it('extracts IPv4 from IPv4-mapped IPv6', () => {
      expect(normaliseIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
      expect(normaliseIp('::ffff:0:192.0.2.1')).toBe('192.0.2.1');
    });

    it('normalises and groups IPv6 by /64', () => {
      expect(normaliseIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe(
        '2001:0db8:85a3:08d3::/64'
      );
      expect(normaliseIp('2001:db8:85a3:8d3::1')).toBe(
        '2001:0db8:85a3:08d3::/64'
      );
      expect(normaliseIp('2001:db8:85a3:8d3:ffff:ffff:ffff:ffff')).toBe(
        '2001:0db8:85a3:08d3::/64'
      );
    });

    it('handles bracketed IPv6', () => {
      expect(normaliseIp('[2001:db8:85a3:8d3::1]')).toBe(
        '2001:0db8:85a3:08d3::/64'
      );
      expect(normaliseIp('[2001:db8:85a3:8d3::1]:8080')).toBe(
        '2001:0db8:85a3:08d3::/64'
      );
    });

    it('handles invalid bracketed IPv6 gracefully', () => {
      expect(normaliseIp('[unclosed-bracket')).toBe('[unclosed-bracket');
    });

    it('groups localhost IPv6 ::1 into ::/64', () => {
      expect(normaliseIp('::1')).toBe('0000:0000:0000:0000::/64');
    });

    it('handles invalid IPv6 strings gracefully', () => {
      expect(normaliseIp('2001::85a3::7348')).toBe('2001::85a3::7348');
      expect(normaliseIp('2001:db8:1:2:3:4:5:6:7')).toBe('2001:db8:1:2:3:4:5:6:7');
      expect(normaliseIp('2001:db8::1:2:3:4:5:6:7')).toBe('2001:db8::1:2:3:4:5:6:7');
      expect(normaliseIp('2001:xyz::1')).toBe('2001:xyz::1');
      expect(normaliseIp('2001:12345::1')).toBe('2001:12345::1');
    });

    it('returns raw cleaned string if not parsable', () => {
      expect(normaliseIp('invalid-ip-string')).toBe('invalid-ip-string');
    });
  });

  describe('resolveClientIp', () => {
    it('returns unknown when no proxy headers exist or headers is null', () => {
      expect(resolveClientIp(null as any)).toBe('unknown');
      const headers = new Headers();
      expect(resolveClientIp(headers)).toBe('unknown');
    });

    it('takes XFF entry at length - trustedProxyHops (default 1)', () => {
      const headers = new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
      });
      expect(resolveClientIp(headers)).toBe('2.2.2.2');
    });

    it('takes XFF entry with custom trustedProxyHops = 2', () => {
      const headers = new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3',
      });
      expect(resolveClientIp(headers, { trustedProxyHops: 2 })).toBe('2.2.2.2');
    });

    it('clamps safely if trustedProxyHops exceeds entries count', () => {
      const headers = new Headers({
        'x-forwarded-for': '1.1.1.1',
      });
      expect(resolveClientIp(headers, { trustedProxyHops: 5 })).toBe('1.1.1.1');
    });

    it('prefers x-real-ip when TRUST_PROXY=vercel and ignores XFF', () => {
      process.env.TRUST_PROXY = 'vercel';
      const headers = new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        'x-real-ip': '4.4.4.4',
      });
      expect(resolveClientIp(headers)).toBe('4.4.4.4');
    });

    it('falls back to XFF if TRUST_PROXY=vercel but x-real-ip is missing', () => {
      process.env.TRUST_PROXY = 'vercel';
      const headers = new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2',
      });
      expect(resolveClientIp(headers)).toBe('2.2.2.2');
    });

    it('uses x-real-ip if x-forwarded-for is missing without TRUST_PROXY=vercel', () => {
      const headers = new Headers({
        'x-real-ip': '5.5.5.5',
      });
      expect(resolveClientIp(headers)).toBe('5.5.5.5');
    });

    it('supports Record headers source', () => {
      const headers = {
        'x-forwarded-for': ['8.8.8.8, 9.9.9.9'],
      };
      expect(resolveClientIp(headers)).toBe('9.9.9.9');
    });

    it('supports Map headers source', () => {
      const headers = new Map([['X-Forwarded-For', '8.8.8.8, 9.9.9.9']]);
      expect(resolveClientIp(headers)).toBe('9.9.9.9');
    });
  });
});
