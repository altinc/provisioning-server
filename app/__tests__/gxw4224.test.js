// Integration test for GXW4224 provisioning: real controller (processDeviceData
// via renderConfig) output is rendered through the real template with the same
// Nunjucks config app.js uses, then asserted against the GXW42xx P-code format.
process.env.AUTH_SECRET = 'test-secret';
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const path = require('path');
const nunjucks = require('nunjucks');
const controller = require('../controllers/provisioning');

const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

function makeNunjucksEnv() {
  return nunjucks.configure(TEMPLATES_DIR, {
    autoescape: true,
    watch: false,
    trimBlocks: false,
    lstripBlocks: false,
    preserveLinebreaks: true,
    noCache: true,
    tags: { commentStart: '<!--', commentEnd: '-->' },
  });
}

function buildDeviceData(numPartners, overrides = {}) {
  const partners = [];
  const organizations = [];
  for (let i = 1; i <= numPartners; i++) {
    partners.push({
      id: i,
      firstname: `User${i}`,
      x_voip_ext: `${200 + i}`,
      x_voip_user: `user${i}`,
      x_voip_secret: overrides.secret ? overrides.secret(i) : `secret${i}`,
      x_kazoo_enabled: true,
      commercial_partner_id: [1, 'Org'],
    });
    organizations.push({
      x_kazoo_enabled: true,
      x_kazoo_realm: 'sip.altinc.ca',
      x_legacy: 'ORG1',
    });
  }
  return {
    id: 99,
    device: { id: 99, x_model: 'GXW4224', x_vlan: '', x_headset: '', x_call_waiting: 1 },
    site: null,
    partners,
    organizations,
  };
}

// Drives the real controller, capturing the templatePath + templateVars it would render.
async function captureTemplateVars(deviceData) {
  const captured = {};
  const req = {
    deviceData,
    normalizedMac: '000b82abcdef',
    templateFile: 'GXW4224.xml',
    deviceType: 'grandstream_gateway',
    get: () => 'Grandstream GXW4224 1.0.3.10',
  };
  const res = {
    set() {},
    render(p, v) { captured.path = p; captured.vars = v; },
    status() { return this; },
    json(o) { captured.json = o; },
  };
  await controller.renderConfig(req, res);
  return captured;
}

describe('GXW4224 controller account expansion (cap raised 8 -> 24)', () => {
  test('populates all 24 accounts, including indexes beyond the old limit of 8', async () => {
    const cap = await captureTemplateVars(buildDeviceData(24));
    expect(cap.json).toBeUndefined(); // no error path
    expect(cap.path).toBe('devices/GXW4224.xml');
    expect(cap.vars.accounts).toHaveLength(24);
    expect(cap.vars.username9).toBe('user9');   // would have been '' under the old cap
    expect(cap.vars.username24).toBe('user24');
    expect(cap.vars.accounts[8].username).toBe('user9');
    expect(cap.vars.accounts[23].username).toBe('user24');
    expect(cap.vars.accounts[23].password).toBe('secret24');
    expect(cap.vars.server1).toBe('sip.altinc.ca');
  });

  test('accounts array is always length 24, with unused ports blank', async () => {
    const cap = await captureTemplateVars(buildDeviceData(3));
    expect(cap.vars.accounts).toHaveLength(24);
    expect(cap.vars.accounts[0].username).toBe('user1');
    expect(cap.vars.accounts[3].username).toBe(''); // port 4 unconfigured
  });
});

describe('GXW4224 template renders verified GXW42xx P-codes', () => {
  const env = makeNunjucksEnv();

  test('maps ports 1-24 to P406x/P409x/P412x/P418x with Profile-1 server in P47', async () => {
    const cap = await captureTemplateVars(buildDeviceData(24));
    const out = env.render('devices/GXW4224.xml', cap.vars);

    expect(out).toMatch(/<gs_provision version="1">/);
    expect(out).toMatch(/<\/gs_provision>/);
    // Shared Profile 1 SIP server
    expect(out).toMatch(/<P47>sip\.altinc\.ca<\/P47>/);
    // FXS port 1
    expect(out).toMatch(/<P4060>user1<\/P4060>/);
    expect(out).toMatch(/<P4090>user1<\/P4090>/);
    expect(out).toMatch(/<P4120>secret1<\/P4120>/);
    expect(out).toMatch(/<P4180>201 : User1<\/P4180>/);
    // FXS port 24 (highest contiguous codes)
    expect(out).toMatch(/<P4083>user24<\/P4083>/);
    expect(out).toMatch(/<P4113>user24<\/P4113>/);
    expect(out).toMatch(/<P4143>secret24<\/P4143>/);
    expect(out).toMatch(/<P4203>224 : User24<\/P4203>/);
    // exactly 24 SIP User ID tags (P4060..P4083), nothing leaks into the next field range
    expect(out.match(/<P40(6[0-9]|7[0-9]|8[0-3])>/g)).toHaveLength(24);
    expect(out).not.toMatch(/<P4084>/);
    // XML comments are consumed by the configured comment tags, not emitted
    expect(out).not.toMatch(/FXS Port/);
  });

  test('XML-escapes special characters in credentials', async () => {
    const cap = await captureTemplateVars(buildDeviceData(1, { secret: () => 'p&w<x>' }));
    const out = env.render('devices/GXW4224.xml', cap.vars);
    expect(out).toMatch(/<P4120>p&amp;w&lt;x&gt;<\/P4120>/);
  });

  test('unconfigured ports render as empty, inert tags', async () => {
    const cap = await captureTemplateVars(buildDeviceData(2));
    const out = env.render('devices/GXW4224.xml', cap.vars);
    expect(out).toMatch(/<P4060>user1<\/P4060>/);
    expect(out).toMatch(/<P4061>user2<\/P4061>/);
    expect(out).toMatch(/<P4062><\/P4062>/); // port 3 empty
    expect(out).toMatch(/<P4083><\/P4083>/); // port 24 empty
  });
});
