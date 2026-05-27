// HTTP-level integration tests against the real app.js (now safely requirable
// thanks to the require.main === module guard). Exercises the full Express
// stack: middleware (MAC validation, device detection, first-provision auth),
// the provisioning controller, and template rendering over real HTTP.
const path = require('path');

// app.js configures nunjucks with a cwd-relative 'templates' path; point cwd at
// the repo root so it resolves to <repo>/templates (where the templates live).
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ORIGINAL_CWD = process.cwd();
process.chdir(REPO_ROOT);
process.env.NODE_ENV = 'test'; // disables the template watcher (set by Jest anyway)
process.env.AUTH_SECRET = 'test-secret';

// Replace external services so no network (Odoo/Redis) is touched.
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/redis', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  getStatus: () => ({ connected: false }),
  get: jest.fn().mockResolvedValue(null),
  setex: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  updateDeviceStats: jest.fn().mockResolvedValue(true),
}));
jest.mock('../services/odoo', () => ({
  getDeviceData: jest.fn(),
  getDeviceDataLight: jest.fn(),
  updateLastProvision: jest.fn().mockResolvedValue(undefined),
  clearDeviceCache: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const odoo = require('../services/odoo');
const auth = require('../utils/auth'); // real auth (logger is mocked) to mint valid tokens
const app = require('../app');

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
});

function buildDeviceData(numPartners) {
  const partners = [];
  const organizations = [];
  for (let i = 1; i <= numPartners; i++) {
    partners.push({
      id: i,
      firstname: `User${i}`,
      x_voip_ext: `${200 + i}`,
      x_voip_user: `user${i}`,
      x_voip_secret: `secret${i}`,
      x_kazoo_enabled: true,
      commercial_partner_id: [1, 'Org'],
    });
    organizations.push({ x_kazoo_enabled: true, x_kazoo_realm: 'sip.altinc.ca', x_legacy: 'ORG1' });
  }
  return {
    id: 99,
    // x_last_prov falsy => first-provision path, so no auth token is required
    device: { id: 99, x_last_prov: false, x_model: 'GXW4224', x_vlan: '', x_headset: '', x_call_waiting: 1 },
    site: null,
    partners,
    organizations,
  };
}

describe('app is importable without listening (require.main guard)', () => {
  test('exports the Express app as a function', () => {
    expect(typeof app).toBe('function');
  });

  test('GET /health responds 200 through the real middleware stack', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('GXW4224 provisioning over HTTP (end to end)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('serves the GXW4224 template with Profile-1 server and per-port FXS credentials', async () => {
    odoo.getDeviceData.mockResolvedValue(buildDeviceData(24));

    const res = await request(app)
      .get('/odoo/cfg000b82abcdef.xml')
      .set('User-Agent', 'Grandstream GXW4224 1.0.3.10');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toMatch(/<P47>sip\.altinc\.ca<\/P47>/);     // shared SIP server
    expect(res.text).toMatch(/<P4060>user1<\/P4060>/);           // FXS port 1
    expect(res.text).toMatch(/<P4120>secret1<\/P4120>/);
    expect(res.text).toMatch(/<P4083>user24<\/P4083>/);          // FXS port 24
    expect(res.text).toMatch(/<P4143>secret24<\/P4143>/);
    // Confirms the device is no longer served the GXP2130 desk-phone template:
    expect(res.text).not.toMatch(/<P35>/);
  });

  test('unknown device returns 404 (still authenticates via Odoo lookup)', async () => {
    odoo.getDeviceData.mockResolvedValue(null);

    const res = await request(app)
      .get('/odoo/cfg000b82ffffff.xml')
      .set('User-Agent', 'Grandstream GXW4224 1.0.3.10');

    expect(res.status).toBe(404);
  });
});

// Regression coverage for the Yealink XML-apps flow after removing the duplicate
// buildYealinkAppUrl declaration. Confirms the (now single) definition still
// produces correct navigation URLs end to end.
describe('Yealink XML-apps menu flow', () => {
  const mac = '805ec0aabbcc';

  test('renders the apps menu with correctly-built per-feature URLs', async () => {
    const token = auth.generateAuthToken(mac).current;

    const res = await request(app).get(`/xmlAppsYealink/menu/${token}/${mac}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toMatch(/<YealinkIPPhoneTextMenu/);
    // buildYealinkAppUrl output shape: <base>/xmlAppsYealink/<feature>/<token>/<mac>
    expect(res.text).toContain(`/xmlAppsYealink/cfwd/${token}/${mac}`);
    expect(res.text).toContain(`/xmlAppsYealink/voicemail/${token}/${mac}`);
    expect(res.text).toContain(`/xmlAppsYealink/redirect/${token}/${mac}`);
  });

  test('rejects an invalid token with 403', async () => {
    const res = await request(app).get(`/xmlAppsYealink/menu/0000000000000000/${mac}`);
    expect(res.status).toBe(403);
  });
});
