const moment = require('moment-timezone');
const logger = require('../utils/logger');
const { createRotatingKeyService } = require('../utils/auth');

// Configuration constants
const provisionUrl = process.env.PROVISION_URL_BASE || 'https://pro.altinc.ca/odoo';
const httpAuthUsername = process.env.HTTP_AUTH_USERNAME || 'altinc';
const httpAuthPassword = process.env.HTTP_AUTH_PASSWORD || 'Jan2019!';

// Extract base URL from PROVISION_URL (remove path like /odoo)
// function extractBaseUrl(url) {
//   try {
//     const urlObj = new URL(url);
//     return `${urlObj.protocol}//${urlObj.host}`;
//   } catch (error) {
//     logger.warn(`Invalid URL format: ${url}`, error);
//     return 'https://pro.altinc.ca';
//   }
// }

// Use PROVISION_URL as the base for server address
const serverAddr = provisionUrl
/**
 * Clean name by removing apostrophes
 */
function cleanName(str) {
  return str ? str.toString().replace(/'/g, '') : '';
}

/**
 * Get GMT offset in hours format (+/-HH:MM)
 */
function getGmtOffsetHours(timezone) {
  try {
    const now = moment().tz(timezone);
    const offset = now.utcOffset();
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    const sign = offset >= 0 ? '+' : '-';
    return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  } catch (error) {
    logger.warn(`Invalid timezone: ${timezone}`, error);
    return '+00:00';
  }
}

/**
 * Get GMT offset in seconds
 */
function getGmtOffsetSeconds(timezone) {
  try {
    const now = moment().tz(timezone);
    return now.utcOffset() * 60; // Convert minutes to seconds
  } catch (error) {
    logger.warn(`Invalid timezone: ${timezone}`, error);
    return 0;
  }
}

/**
 * Get Canadian timezone format
 */
function getCanadianTimezone(olsonTz) {
  const mapping = {
    'America/Vancouver': 'CAN-8',
    'America/Edmonton': 'CAN-7',
    'America/Winnipeg': 'CAN-6',
    'America/Toronto': 'CAN-5',
    'America/Halifax': 'CAN-4',
    'America/St_Johns': 'CAN-3.5'
  };
  return mapping[olsonTz] || 'Unknown timezone';
}

/**
 * Process device and user data into template variables
 */
function processDeviceData(deviceData, mac, userAgent, isGroundwire = false) {
  const { device, site, partners, organizations } = deviceData;
  
  // Generate token for provisioning URLs
  const keyService = createRotatingKeyService();
  const token = mac ? keyService.getCurrentAndNextKeys(mac).current : '';
  
  // Initialize template variables
  const templateVars = {
    mac: mac.toUpperCase(),
    srvtoggle: '0',
    orgid: '',
    model: '',
    vlan: '',
    headset: '',
    tz: '',
    city: '',
    country: '',
    timezone: '',
    hours: '',
    seconds: '',
    callwaiting: 1,
    provision_url: provisionUrl,
    http_auth_username: httpAuthUsername,
    http_auth_password: httpAuthPassword,
    // New provisioning URLs with token and MAC
    provisioning_url: mac ? `${serverAddr}/v3/${token}` : '',
    apps_button_url_grandstream: mac ? `${serverAddr}/xmlApps/menu/${token}/${mac.toUpperCase()}` : '',
    apps_button_url_yealink: mac ? `${serverAddr}/xmlAppsYealink/menu/${token}/${mac.toUpperCase()}` : '',
    // NEW: Firmware URL
    firmware_url: `${serverAddr}/fw`,
    // Yealink-specific timezone variables
    yealink_offset: '',
    yealink_timezone_name: ''
  };

  // Add user accounts (up to 8)
  for (let i = 1; i <= 8; i++) {
    templateVars[`ext${i}`] = '';
    templateVars[`display${i}`] = '';
    templateVars[`username${i}`] = '';
    templateVars[`password${i}`] = '';
    templateVars[`server${i}`] = '';
    templateVars[`srvtoggle${i}`] = '';
  }

  // Add handset fields for DECT phones
  for (let i = 1; i <= 8; i++) {
    templateVars[`handset${i}`] = '';
  }

  // Process device settings
  if (device) {
    templateVars.model = device.x_model || '';
    templateVars.vlan = device.x_vlan || '';
    templateVars.headset = device.x_headset || '';
    templateVars.callwaiting = device.x_call_waiting || 1;
  }

  // Process site settings
  if (site) {
    templateVars.tz = site.x_gtz || '';
    templateVars.city = cleanName(site.x_city ? site.x_city[1] : '');
    templateVars.country = (site.x_co && site.x_co[1] === 'Canada') ? 'CA' : 'US';
    
    if (site.x_tz) {
      templateVars.timezone = getCanadianTimezone(site.x_tz);
      templateVars.hours = getGmtOffsetHours(site.x_tz);
      templateVars.seconds = getGmtOffsetSeconds(site.x_tz);
      
      // Yealink-specific timezone variables
      try {
        const now = moment().tz(site.x_tz);
        const offsetMinutes = now.utcOffset();
        const hours = Math.floor(Math.abs(offsetMinutes) / 60);
        const minutes = Math.abs(offsetMinutes) % 60;
        const sign = offsetMinutes >= 0 ? '+' : '-';
        templateVars.yealink_offset = `${sign}${hours}:${minutes.toString().padStart(2, '0')}`;
        templateVars.yealink_timezone_name = site.x_tz; // e.g., 'America/Toronto'
      } catch (error) {
        logger.warn(`Error processing Yealink timezone for ${site.x_tz}:`, error);
        templateVars.yealink_offset = '+0:00';
        templateVars.yealink_timezone_name = 'UTC';
      }
    }
  }

  // Process partners and organizations
  if (partners && organizations) {
    // Set main server toggle based on first organization
    if (organizations[0]) {
      const org = organizations[0];
      templateVars.orgid = org.x_legacy || '';
      
      if (org.x_kazoo_enabled) {
        templateVars.srvtoggle = '1';
      }
    }

    // Process each partner/user account
    partners.forEach((partner, index) => {
      if (index >= 8) return; // Max 8 accounts
      
      const accountNum = index + 1;
      const org = organizations[index];
      
      if (!partner || !org) return;

      // Determine server
      let server = '';
      let srvToggle = '1';
      
      if (!org.x_kazoo_enabled) {
        server = org.x_pbxip || '';
        srvToggle = '0';
      } else {
        server = org.x_kazoo_realm || '';
        srvToggle = '1';
      }

      // Set account details
      templateVars[`ext${accountNum}`] = partner.x_voip_ext || '';
      templateVars[`display${accountNum}`] = partner.x_voip_ext && partner.firstname ? 
        `${partner.x_voip_ext} : ${partner.firstname}` : '';
      templateVars[`server${accountNum}`] = server;
      templateVars[`srvtoggle${accountNum}`] = srvToggle;

      // Determine username based on Kazoo vs legacy
      if (srvToggle === '0' || !partner.x_kazoo_enabled || !org.x_kazoo_enabled) {
        templateVars[`username${accountNum}`] = partner.x_voip_ext || '';
      } else {
        // For Groundwire, use mobile credentials if available
        if (isGroundwire && partner.x_mobile_user) {
          templateVars[`username${accountNum}`] = partner.x_mobile_user;
        } else {
          templateVars[`username${accountNum}`] = partner.x_voip_user || '';
        }
      }

      // Set password
      if (isGroundwire && partner.x_mobile_secret) {
        templateVars[`password${accountNum}`] = partner.x_mobile_secret;
      } else {
        templateVars[`password${accountNum}`] = partner.x_voip_secret || '';
      }

      // Process handsets for DECT phones
      if (partner.x_device && Array.isArray(partner.x_device)) {
        partner.x_device.forEach((deviceId, handsetIndex) => {
          if (handsetIndex < 8 && deviceId.x_unique && deviceId.x_unique.length < 12) {
            templateVars[`handset${handsetIndex + 1}`] = deviceId.x_unique;
          }
        });
      }
    });

    // For Groundwire, add token support
    if (isGroundwire && partners[0] && templateVars.username1) {
      const keyService = createRotatingKeyService();
      const tokens = keyService.getCurrentAndNextKeys(templateVars.username1);
      templateVars.token1 = tokens.current;
      templateVars.pid = partners[0].id || '';
    }
  }

  return templateVars;
}

/**
 * Render configuration for XML-based phones (Grandstream, Cisco, etc.)
 */
async function renderConfig(req, res) {
  try {
    const { deviceData, normalizedMac, templateFile } = req;
    
    const templateVars = processDeviceData(deviceData, normalizedMac, req.get('User-Agent'));
    
    // Prepend devices/ to the template path if not already present
    const templatePath = templateFile.startsWith('devices/') ? templateFile : `devices/${templateFile}`;
    
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.render(templatePath, templateVars);
    
    logger.info(`Rendered XML config for device: ${normalizedMac}`, {
      template: templatePath,
      deviceType: req.deviceType
    });
  } catch (error) {
    logger.error(`Error rendering config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render configuration for Yealink phones
 */
async function renderYealinkConfig(req, res) {
  try {
    const { deviceData, normalizedMac } = req;
    
    const templateVars = processDeviceData(deviceData, normalizedMac, req.get('User-Agent'));
    
    // Determine which template to use based on the endpoint
    let templateName = 'devices/yealink/yealink-system.cfg'; // default
    
    if (req.url.endsWith('.reg')) {
      templateName = 'devices/yealink/yealink-reg.cfg';
    } else if (req.url.endsWith('.sys')) {
      templateName = 'devices/yealink/yealink-system.cfg';
    }
    
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.render(templateName, templateVars);
    
    logger.info(`Rendered Yealink config (${templateName}) for device: ${normalizedMac}`);
  } catch (error) {
    logger.error(`Error rendering Yealink config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render boot configuration for Yealink phones
 */
async function renderYealinkBoot(req, res) {
  try {
    const { deviceData, normalizedMac } = req;
    
    const templateVars = processDeviceData(deviceData, normalizedMac, req.get('User-Agent'));
    
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.render('devices/yealink/yealink-boot.cfg', templateVars);
    
    logger.info(`Rendered Yealink boot config for device: ${normalizedMac}`);
  } catch (error) {
    logger.error(`Error rendering Yealink boot config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render Polycom configurations
 */
async function renderPolycomConfig(req, res) {
  try {
    const { deviceData, normalizedMac } = req;
    const { configType } = req.params; // 'reg', 'sip', 'softkey'
    
    const templateVars = processDeviceData(deviceData, normalizedMac, req.get('User-Agent'));
    
    let templateName = 'sip.cfg';
    switch (configType) {
      case 'reg':
        templateName = 'reg.cfg';
        break;
      case 'softkey':
        templateName = 'softkey.cfg';
        break;
      case 'sip':
      default:
        templateName = 'sip.cfg';
        break;
    }
    
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.render(`devices/vvx/${templateName}`, templateVars);
    
    logger.info(`Rendered Polycom ${configType} config for device: ${normalizedMac}`);
  } catch (error) {
    logger.error(`Error rendering Polycom config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render Algo pager configuration
 */
async function renderAlgoConfig(req, res) {
  try {
    const { deviceData, normalizedMac } = req;
    const userAgent = req.get('User-Agent') || '';
    
    let templateFile = 'algo-pager.cfg';
    if (userAgent.includes('Algo-8301') || userAgent.includes('Mozilla')) {
      templateFile = 'algo-8301.cfg';
    }
    
    const templateVars = processDeviceData(deviceData, normalizedMac, userAgent);
    
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.render(`devices/${templateFile}`, templateVars);
    
    logger.info(`Rendered Algo config for device: ${normalizedMac}`, { template: templateFile });
  } catch (error) {
    logger.error(`Error rendering Algo config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render Snom configuration
 */
async function renderSnomConfig(req, res) {
  try {
    const { deviceData, normalizedMac } = req;
    const userAgent = req.get('User-Agent') || '';
    
    let templateFile = 'snom-m300.xml';
    if (userAgent.includes('snomD735') || userAgent.includes('snomD785')) {
      templateFile = 'snom-d735.xml';
    }
    
    const templateVars = processDeviceData(deviceData, normalizedMac, userAgent);
    
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.render(`devices/${templateFile}`, templateVars);
    
    logger.info(`Rendered Snom config for device: ${normalizedMac}`, { template: templateFile });
  } catch (error) {
    logger.error(`Error rendering Snom config for ${req.normalizedMac}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Render Groundwire configuration
 */
async function renderGroundwireConfig(req, res) {
  try {
    const { deviceData } = req;
    const { pid } = req.params;
    
    if (!deviceData || !deviceData.partners || deviceData.partners.length === 0) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    // Find the specific partner by ID
    const partner = deviceData.partners.find(p => p.id.toString() === pid);
    if (!partner) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    const templateVars = processDeviceData(deviceData, '', req.get('User-Agent'), true);
    templateVars.pid = pid;
    
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.render('devices/groundwire.xml', templateVars);
    
    logger.info(`Rendered Groundwire config for partner: ${pid}`);
  } catch (error) {
    logger.error(`Error rendering Groundwire config for partner ${req.params.pid}:`, error);
    res.status(500).json({ error: 'Failed to render configuration' });
  }
}

/**
 * Generate QR code for Groundwire
 */
async function generateQRCode(req, res) {
  try {
    // This would require implementing QR code generation
    // For now, return the XML that would be encoded
    const { deviceData } = req;
    const { pid } = req.params;
    
    if (!deviceData || !deviceData.partners || deviceData.partners.length === 0) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    const partner = deviceData.partners.find(p => p.id.toString() === pid);
    const org = deviceData.organizations[0];
    
    if (!partner || !org) {
      return res.status(404).json({ error: 'Partner or organization not found' });
    }

    const xml = `<?xml version='1.0' encoding='utf-8'?><AccountConfig version='1'><Account><RegisterServer>${org.x_kazoo_realm}</RegisterServer><OutboundServer></OutboundServer><UserID>${partner.x_mobile_user}</UserID><AuthID>${partner.x_mobile_user}</AuthID><AuthPass>${partner.x_mobile_secret}</AuthPass><AccountName>${partner.x_voip_ext}</AccountName><DisplayName>${partner.x_voip_ext}</DisplayName><Dialplan>{x+|*x+|*++}</Dialplan><RandomPort>0</RandomPort><SecOutboundServer></SecOutboundServer><DNS>SRV</DNS><Voicemail>${partner.x_voip_ext}</Voicemail></Account></AccountConfig>`;

    // TODO: Implement actual QR code generation using a library like 'qrcode'
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(xml);
    
    logger.info(`Generated QR code content for partner: ${pid}`);
  } catch (error) {
    logger.error(`Error generating QR code for partner ${req.params.pid}:`, error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
}

module.exports = {
  renderConfig,
  renderYealinkConfig,
  renderYealinkBoot,
  renderPolycomConfig,
  renderAlgoConfig,
  renderSnomConfig,
  renderGroundwireConfig,
  generateQRCode
};