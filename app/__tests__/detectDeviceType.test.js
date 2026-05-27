// Unit tests for device-type detection (templateFile routing).
// Mock logger to avoid file I/O and odoo to avoid xmlrpc/redis side effects on import.
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
// Factory mock so the real odoo module (which builds an xmlrpc client pool on
// construction) never loads. detectDeviceType doesn't touch odoo anyway.
jest.mock('../services/odoo', () => ({ getDeviceData: jest.fn(), updateLastProvision: jest.fn() }));

const { detectDeviceType } = require('../middleware');

function detect(userAgent, originalMacParam) {
  const req = {
    get: (h) => (h.toLowerCase() === 'user-agent' ? userAgent : undefined),
    originalMacParam,
    normalizedMac: '000b82abcdef',
    ip: '127.0.0.1',
    ipSource: 'test',
  };
  const next = jest.fn();
  detectDeviceType(req, {}, next);
  return { req, next };
}

describe('detectDeviceType - GXW42xx gateway routing', () => {
  test('GXW4224 User-Agent routes to GXW4224.xml', () => {
    const { req, next } = detect('Grandstream GXW4224 1.0.3.10');
    expect(req.templateFile).toBe('GXW4224.xml');
    expect(req.deviceType).toBe('grandstream_gateway');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('GXW4216 User-Agent routes to GXW4224.xml', () => {
    const { req } = detect('Grandstream GXW4216 1.0.3.10');
    expect(req.templateFile).toBe('GXW4224.xml');
    expect(req.deviceType).toBe('grandstream_gateway');
  });

  // Real-world case: GXW gateways fetch cfg<MAC>.xml, so originalMacParam has the
  // "cfg" prefix. GXW detection must win over the generic cfg-prefix fallback,
  // otherwise the device gets the GXP2130 desk-phone template (the original bug).
  test('GXW4224 with cfg-prefixed MAC still routes to GXW4224.xml (not GXP fallback)', () => {
    const { req } = detect('Grandstream GXW4224 1.0.3.10', 'cfg000b82abcdef');
    expect(req.templateFile).toBe('GXW4224.xml');
    expect(req.deviceType).toBe('grandstream_gateway');
  });
});

describe('detectDeviceType - regressions (existing devices unchanged)', () => {
  test('HT818 still routes to HT818.xml', () => {
    const { req } = detect('Grandstream HT818 1.0.0.0');
    expect(req.templateFile).toBe('HT818.xml');
    expect(req.deviceType).toBe('grandstream_ata');
  });

  test('GXP2170 still routes to GXP2130.xml', () => {
    const { req } = detect('Grandstream GXP2170 1.0.0.0');
    expect(req.templateFile).toBe('GXP2130.xml');
    expect(req.deviceType).toBe('grandstream_gxp');
  });

  test('unknown UA with cfg prefix still falls back to GXP2130.xml', () => {
    const { req } = detect('UnknownAgent/1.0', 'cfg000b82abcdef');
    expect(req.templateFile).toBe('GXP2130.xml');
    expect(req.deviceType).toBe('grandstream_gxp');
  });

  // Documents the current scope boundary: 32/48-port models are intentionally
  // NOT routed here yet (the template covers 24 ports). They fall back like before.
  test('GXW4232 is not yet routed to the 24-port template', () => {
    const { req } = detect('Grandstream GXW4232 1.0.3.10', 'cfg000b82abcdef');
    expect(req.templateFile).not.toBe('GXW4224.xml');
  });
});
