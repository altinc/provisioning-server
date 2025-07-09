/**
 * XML Applications Controller
 * 
 * Handles business logic for XML-based phone applications like call forwarding,
 * conference management, etc. These controllers implement the functionality
 * previously provided by the PHP XML app backend.
 * 
 * OPTIMIZED VERSION: Enhanced with caching and performance improvements
 */
const logger = require('../utils/logger');
const kazooService = require('../services/kazoo');
const odooService = require('../services/odoo');
const redisService = require('../services/redis');

/**
 * Helper function to get device details from Odoo and Kazoo
 * @param {string} mac - The device MAC address
 * @returns {Object} Device and user data
 */
async function getDeviceData(mac) {
  try {
    // Get device data from Odoo
    const deviceData = await odooService.getDeviceData(mac);
    
    if (!deviceData) {
      throw new Error('Device not found');
    }
    
    // Extract relevant data
    const device = {
      id: deviceData.device.id,
      mac: mac,
      model: deviceData.device.x_model || '',
      owner: deviceData.device.x_owner || []
    };
    
    const partner = deviceData.partners[0] || null;
    const organization = deviceData.organizations[0] || null;
    
    let user = null;
    let kazooData = {};
    
    // If Kazoo is enabled, get additional data
    if (organization && organization.x_kazoo_enabled === true && 
        partner && partner.x_kazoo_enabled === true) {
      
      // Get Kazoo IDs
      const kazooid = organization.x_kazoo_id;
      const kazoouid = partner.x_kazoo_kid;
      
      if (kazooid && kazoouid) {
        kazooData = {
          account_id: kazooid,
          user_id: kazoouid,
          username: partner.x_voip_user,
          password: partner.x_voip_secret,
          realm: organization.x_kazoo_realm
        };
        
        // Get user data from Kazoo
        try {
          await kazooService.initialize(kazooid);
          user = await kazooService.getUser(kazooid, kazoouid);
        } catch (error) {
          logger.warn(`Failed to get Kazoo user data: ${error.message}`, { mac });
          // Continue without Kazoo user data
        }
      }
    }
    
    return {
      device,
      partner,
      organization,
      user,
      kazooData
    };
  } catch (error) {
    logger.error(`Error getting device data for MAC ${mac}:`, error);
    throw error;
  }
}

/**
 * OPTIMIZED: Helper function to get lightweight device data for XML apps
 * @param {string} mac - The device MAC address
 * @returns {Object} Minimal device data needed for XML apps
 */
async function getDeviceDataLight(mac) {
  try {
    // Try the lightweight version first
    const lightData = await odooService.getDeviceDataLight(mac);
    if (lightData) {
      return lightData;
    }
    
    // Fallback to full data if light version not available
    logger.debug(`Falling back to full device data for ${mac}`);
    return await getDeviceData(mac);
  } catch (error) {
    logger.error(`Error getting device data for MAC ${mac}:`, error);
    throw error;
  }
}

/**
 * Get base URL from request
 * @param {Object} req - Express request object
 * @returns {string} Base URL
 */
function getBaseUrl(req) {
  // Get protocol from X-Forwarded-Proto header or request.protocol
  const protocol = req.get('X-Forwarded-Proto') || req.protocol;
  
  // Get host from request
  const host = req.get('host');
  
  // Construct base URL
  return `${protocol}://${host}`;
}

/**
 * Build URL for XML app navigation
 * @param {Object} req - Express request object 
 * @param {string} feature - Feature name (e.g., "cfwd", "voicemail")
 * @param {Object} params - Additional query parameters
 * @returns {string} Full URL
 */
function buildXmlAppUrl(req, feature, params = {}) {
  const baseUrl = getBaseUrl(req);
  
  // Get token and MAC from request
  const token = req.authToken;
  const mac = req.normalizedMac;
  
  if (!token || !mac) {
    logger.warn('Missing token or MAC for building URL', {
      ip: req.ip,
      url: req.url,
      feature,
      mac: mac || 'unknown',
      token: token ? 'present' : 'missing'
    });
  }
  
  // Build the base URL with the new path format
  let url = `${baseUrl}/xmlApps/${feature}/${token || 'missing-token'}/${mac || 'unknown-mac'}`;
  
  // Add query string if there are params
  if (Object.keys(params).length > 0) {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    url += `?${queryString}`;
  }
  
  logger.debug(`Built URL for ${feature}: ${url}`, {
    mac: mac,
    token: token ? 'present' : 'missing'
  });
  
  return url;
}

/**
 * Render the XML apps menu
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderAppsMenu(req, res) {
  try {
    // MAC and token are now from path parameters
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering XML apps menu for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      token: token
    });
    
    // Get URLs for navigation
    const cfwdUrl = buildXmlAppUrl(req, 'cfwd');
    const voicemailUrl = buildXmlAppUrl(req, 'voicemail');
    const redirectUrl = buildXmlAppUrl(req, 'redirect');
    const conferenceUrl = buildXmlAppUrl(req, 'conference');
    const parkingUrl = buildXmlAppUrl(req, 'parking');
    
    // Basic template variables
    const templateVars = {
      mac: mac,
      token: token,
      cfwdUrl,
      voicemailUrl,
      redirectUrl,
      conferenceUrl,
      parkingUrl
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/apps.xml', templateVars);
  } catch (error) {
    logger.error(`Error rendering XML apps menu: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering XML apps menu');
  }
}

/**
 * Render call forwarding interface
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderCallForwarding(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering call forwarding for device: ${mac}`);
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    // Initialize call forwarding settings with defaults
    let callForward = {
      enabled: false,
      number: '',
      substitute: false,
      require_keypress: false,
      keep_caller_id: false,
      direct_calls_only: false,
      failover: false
    };
    
    // If we have Kazoo user data, get actual call forwarding settings
    if (data.user && data.user.call_forward) {
      callForward = {
        enabled: data.user.call_forward.enabled || false,
        number: data.user.call_forward.number || '',
        substitute: data.user.call_forward.substitute || false,
        require_keypress: data.user.call_forward.require_keypress || false,
        keep_caller_id: data.user.call_forward.keep_caller_id || false,
        direct_calls_only: data.user.call_forward.direct_calls_only || false,
        failover: data.user.call_forward.failover || false
      };
      
      logger.info(`Retrieved call forwarding settings for ${mac}`, callForward);
    } else {
      logger.info(`No call forwarding settings found for ${mac}, using defaults`);
    }
    
    // Build the URL for saving
    const saveUrl = buildXmlAppUrl(req, 'saveCfwd');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      saveUrl,
      menuUrl: buildXmlAppUrl(req, 'menu'),
      enabled: callForward.enabled ? 1 : 0,
      number: callForward.number,
      substitute: callForward.substitute ? 1 : 0,
      require_keypress: callForward.require_keypress ? 1 : 0,
      keep_caller_id: callForward.keep_caller_id ? 1 : 0,
      direct_calls_only: callForward.direct_calls_only ? 1 : 0,
      failover: callForward.failover ? 1 : 0,
      kazooData: data.kazooData || {}
    };
    
    logger.debug(`Template variables for ${mac}:`, templateVars);
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/cfwd.xml', templateVars);
    
    logger.info(`Rendered call forwarding interface for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering call forwarding: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to load call forwarding settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * Save call forwarding settings
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveCallForwarding(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from request body or query (to support both POST and GET)
    const number = req.body.number || req.query.number || '';
    const substitute = parseInt(req.body.substitute || req.query.substitute || 0);
    const require_keypress = parseInt(req.body.require_keypress || req.query.require_keypress || 0);
    const keep_caller_id = parseInt(req.body.keep_caller_id || req.query.keep_caller_id || 0);
    const direct_calls_only = parseInt(req.body.direct_calls_only || req.query.direct_calls_only || 0);
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    // Determine enabled and failover based on substitute value
    let enabled = true;
    let actualSubstitute = false;
    let failover = false;
    
    if (substitute == 4) {  // Off
      enabled = false;
      actualSubstitute = false;
      failover = false;
    } else if (substitute == 2) {  // Failover
      enabled = true;
      actualSubstitute = false;
      failover = true;
    } else if (substitute == 1) {  // Cell Only
      enabled = true;
      actualSubstitute = true;
      failover = false;
    } else {  // Desk + Cell
      enabled = true;
      actualSubstitute = false;
      failover = false;
    }
    
    // Update Kazoo if we have the necessary data
    if (data.kazooData && data.kazooData.account_id && data.kazooData.user_id) {
      // ENHANCED: Get existing settings first to preserve other fields
      let existingSettings = {};
      if (data.user && data.user.call_forward) {
        existingSettings = data.user.call_forward;
      }
      
      const callForward = {
        ...existingSettings,
        enabled: enabled,
        number: number,
        substitute: actualSubstitute,
        require_keypress: require_keypress == 1,
        keep_caller_id: keep_caller_id == 1,
        direct_calls_only: direct_calls_only == 1,
        failover: failover
      };
      
      await kazooService.updateCallForwarding(
        data.kazooData.account_id, 
        data.kazooData.user_id, 
        callForward
      );
      
      // ENHANCED: Clear the cache after update
      const cacheKey = `kazoo:user:${data.kazooData.account_id}:${data.kazooData.user_id}`;
      await redisService.del(cacheKey);
      
      logger.info(`Updated call forwarding settings for device: ${mac}`, {
        ip: req.ip,
        settings: callForward
      });
    } else {
      logger.warn(`Cannot update call forwarding - missing Kazoo data for device: ${mac}`);
    }
    
    // Build URLs for navigation
    const returnUrl = buildXmlAppUrl(req, 'cfwd');
    const menuUrl = buildXmlAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/cfwd-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
  } catch (error) {
    logger.error(`Error saving call forwarding: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to save call forwarding settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * Render conference management interface
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderConference(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    const { action } = req.query;
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      throw new Error('Missing Kazoo account data');
    }
    
    // Handle action if provided (lock/unlock)
    if (action) {
      // The original PHP handled a hardcoded conference ID - we should get this from config
      const conferenceId = process.env.DEFAULT_CONFERENCE_ID || '676abefe09c3e50283af7212f0d86df1';
      
      if (action === 'lock') {
        await kazooService.setConferenceLock(data.kazooData.account_id, conferenceId, true);
      } else if (action === 'unlock') {
        await kazooService.setConferenceLock(data.kazooData.account_id, conferenceId, false);
      }
    }
    
    // Get conference data
    const conferenceId = process.env.DEFAULT_CONFERENCE_ID || '676abefe09c3e50283af7212f0d86df1';
    const conference = await kazooService.getConference(data.kazooData.account_id, conferenceId);
    
    // Check if conference is locked
    const isLocked = conference._read_only && conference._read_only.is_locked;
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      conferenceId,
      name: conference.name || 'Conference',
      membersPin: conference.member && conference.member.pins ? conference.member.pins[0] : '',
      moderatorPin: conference.moderator && conference.moderator.pins ? conference.moderator.pins[0] : '',
      isLocked: isLocked,
      lockAction: isLocked ? 'unlock' : 'lock',
      lockLabel: isLocked ? 'Unlock' : 'Lock',
      participants: conference._read_only && conference._read_only.participants ? conference._read_only.participants : [],
      totalParticipants: (conference._read_only && conference._read_only.members ? conference._read_only.members : 0) + 
                        (conference._read_only && conference._read_only.moderators ? conference._read_only.moderators : 0)
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/conference.xml', templateVars);
    
    logger.info(`Rendered conference interface for device: ${mac}`, {
      ip: req.ip,
      action: action,
      isLocked: isLocked
    });
  } catch (error) {
    logger.error(`Error rendering conference: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to access conference settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * Render voicemail settings interface
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderVoicemail(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering voicemail settings for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data || !data.kazooData || !data.kazooData.account_id || !data.kazooData.user_id) {
      logger.warn(`Missing Kazoo data for device: ${mac}`);
      return res.status(404).send('Device not found or missing Kazoo integration');
    }
    
    // Get current voicemail settings
    let vmSettings = {
      email: data.partner ? data.partner.email || '' : '',
      vm_to_email_enabled: false
    };
    
    try {
      // Initialize the Kazoo service with the account ID
      await kazooService.initialize(data.kazooData.account_id);
      
      // Fetch user data from Kazoo
      const userData = await kazooService.getUser(data.kazooData.account_id, data.kazooData.user_id);
      
      if (userData) {
        vmSettings.email = userData.email || vmSettings.email;
        vmSettings.vm_to_email_enabled = userData.vm_to_email_enabled || false;
        
        logger.info(`Retrieved voicemail settings for user ${data.kazooData.user_id}`, {
          email: vmSettings.email,
          vm_to_email_enabled: vmSettings.vm_to_email_enabled
        });
      }
    } catch (error) {
      logger.warn(`Could not fetch Kazoo user data: ${error.message}`, {
        mac,
        account_id: data.kazooData.account_id,
        user_id: data.kazooData.user_id
      });
      // Continue with default settings
    }
    
    // Build the URL for saving
    const saveUrl = buildXmlAppUrl(req, 'saveVoicemail');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      saveUrl,
      menuUrl: buildXmlAppUrl(req, 'menu'),
      email: vmSettings.email,
      vm_to_email_enabled: vmSettings.vm_to_email_enabled ? 1 : 0,
      kazooData: data.kazooData
    };
    
    // Render the voicemail XML template
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/voicemail.xml', templateVars);
    
    logger.info(`Rendered voicemail settings for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering voicemail settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to load voicemail settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * Save voicemail settings
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveVoicemail(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from request body or query
    const email = req.body.email || req.query.email || '';
    const vm_to_email_enabled = parseInt(req.body.vm_to_email_enabled || req.query.vm_to_email_enabled || 0);
    
    logger.info(`Saving voicemail settings for device: ${mac}`, {
      ip: req.ip,
      email,
      vm_to_email_enabled
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data || !data.kazooData || !data.kazooData.account_id || !data.kazooData.user_id) {
      logger.warn(`Missing Kazoo data for device: ${mac}`);
      return res.status(404).send('Device not found or missing Kazoo integration');
    }
    
    // Update Kazoo if we have the necessary data
    try {
      // Initialize the Kazoo service with the account ID
      await kazooService.initialize(data.kazooData.account_id);
      
      // ENHANCED: Get current user data first
      const user = await kazooService.getUser(data.kazooData.account_id, data.kazooData.user_id);
      
      // Update only the specific fields we want to change
      const updatedUser = {
        ...user,
        email: email,
        vm_to_email_enabled: vm_to_email_enabled == 1
      };
      
      logger.info(`Updating voicemail settings for user ${data.kazooData.user_id}`, {
        email,
        vm_to_email_enabled,
        account_id: data.kazooData.account_id
      });
      
      // Update the user using the Kazoo API directly
      const response = await kazooService.axios.post(`/accounts/${data.kazooData.account_id}/users/${data.kazooData.user_id}`, {
        data: updatedUser
      });
      
      if (response.status === 200) {
        // ENHANCED: Clear the cache after update
        const cacheKey = `kazoo:user:${data.kazooData.account_id}:${data.kazooData.user_id}`;
        await redisService.del(cacheKey);
        
        logger.info(`Successfully updated voicemail settings for user ${data.kazooData.user_id}`);
      } else {
        throw new Error(`Unexpected response: ${response.status}`);
      }
    } catch (error) {
      // ENHANCED: Better error logging
      if (error.response) {
        logger.error(`Kazoo API error - HTTP ${error.response.status}:`, {
          data: error.response.data,
          mac,
          account_id: data.kazooData.account_id,
          user_id: data.kazooData.user_id
        });
      } else {
        logger.error(`Failed to update voicemail settings: ${error.message}`, {
          mac,
          account_id: data.kazooData.account_id,
          user_id: data.kazooData.user_id,
          error: error.stack
        });
      }
      return res.status(500).send('Failed to update voicemail settings');
    }
    
    // Build URLs for navigation
    const returnUrl = buildXmlAppUrl(req, 'voicemail');
    const menuUrl = buildXmlAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/voicemail-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
    
    logger.info(`Saved voicemail settings for device: ${mac}`, {
      ip: req.ip,
      email,
      vm_to_email_enabled
    });
  } catch (error) {
    logger.error(`Error saving voicemail settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to save voicemail settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * Render parking management interface
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderParking(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      throw new Error('Missing Kazoo account data');
    }
    
    // Get current channels
    const channels = await kazooService.getChannels(data.kazooData.account_id);
    
    // Process channels for parking lots
    const parkingLots = Array(3).fill().map((_, i) => ({
      number: i + 1,
      extension: `*310${i + 1}`,
      inUse: false,
      caller: '',
      duration: ''
    }));
    
    // Populate parking lots with channel data if available
    if (channels && channels.length > 0) {
      for (const channel of channels) {
        // In the original PHP, it looked for specific data to map to parking lots
        // We would need similar logic here based on destination or presence_id
        if (channel.destination && channel.destination.includes('park')) {
          // Extract lot number (simplified example)
          const lotMatch = channel.destination.match(/park(\d+)/);
          if (lotMatch && lotMatch[1]) {
            const lotIndex = parseInt(lotMatch[1]) - 1;
            if (lotIndex >= 0 && lotIndex < parkingLots.length) {
              const callerIdInfo = channel.presence_id ? channel.presence_id.split('@')[0] : 'Unknown';
              parkingLots[lotIndex].inUse = true;
              parkingLots[lotIndex].caller = callerIdInfo;
              parkingLots[lotIndex].duration = channel.elapsed_s || '0';
            }
          }
        }
      }
    }
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      parkingLots,
      menuUrl: buildXmlAppUrl(req, 'menu')
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/parking.xml', templateVars);
    
    logger.info(`Rendered parking management for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      lotsInUse: parkingLots.filter(lot => lot.inUse).length
    });
  } catch (error) {
    logger.error(`Error rendering parking management: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    // ENHANCED: Better error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to load parking information. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * OPTIMIZED: Render call redirection interface with caching and performance improvements
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderRedirect(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering call redirection for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Use lightweight device data for redirect
    const data = await getDeviceDataLight(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      logger.warn('Missing Kazoo account data', { mac });
      throw new Error('Missing Kazoo account data');
    }
    
    const accountId = data.kazooData.account_id;
    
    // Get temporal rules using the optimized service method (with caching)
    // This will only return rules that have the 'enabled' property (true/false)
    // Time-based rules without 'enabled' property are filtered out
    const allRules = await kazooService.getTemporalRules(accountId);
    
    // Only process the first 3 rules since that's all we display
    const limitedRules = allRules
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .slice(0, 3)
      .map(rule => ({
        id: rule.id,
        name: rule.name || `Rule ${rule.id}`,
        enabled: rule.enabled === true
      }));
    
    // Determine which rule is currently active
    const currentDest = limitedRules.findIndex(rule => rule.enabled) + 1;
    
    // Build options array with minimal data
    const ruleOptions = limitedRules.map((rule, index) => ({
      value: index + 1,
      name: rule.name,
      id: rule.id
    }));
    
    // Build URLs
    const ruleIds = limitedRules.map(r => r.id).join(',');
    const saveUrl = buildXmlAppUrl(req, 'saveRedirect');
    
    // Prepare template variables
    const templateVars = {
      mac,
      token,
      saveUrl,
      menuUrl: buildXmlAppUrl(req, 'menu'),
      ruleIds,
      currentDest,
      ruleOptions,
      accountId,
      title: 'CallControl',
      sectionTitle: 'Override'
    };
    
    // Set cache headers for XML response
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'private, max-age=60' // Cache for 1 minute on client
    });
    
    res.render('xml-apps/redirect.xml', templateVars);
    
    logger.info(`Rendered call redirection for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      rules: limitedRules.length,
      currentDest
    });
  } catch (error) {
    logger.error(`Error rendering call redirection: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to load call routing settings. Please try again later." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

/**
 * OPTIMIZED: Save redirect settings with cache invalidation
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveRedirect(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from request body or query
    const dest = parseInt(req.body.dest || req.query.dest || 0);
    const rule_ids = req.body.rule_ids || req.query.rule_ids;
    
    logger.info(`Saving redirect settings for device: ${mac}`, {
      ip: req.ip,
      dest,
      rule_ids
    });
    
    if (!rule_ids) {
      throw new Error('Missing required parameter rule_ids');
    }
    
    // Get device data to get the correct account ID
    const data = await getDeviceDataLight(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      throw new Error('Missing Kazoo account data');
    }
    
    const accountId = data.kazooData.account_id;
    
    // Initialize Kazoo connection if needed
    await kazooService.initialize(accountId);
    
    // Parse temporal rule IDs
    const ruleIds = rule_ids.split(',');
    
    // Process each rule based on dest value
    // dest: 0=all off, 1=first rule on, 2=second rule on, 3=third rule on
    // Note: We only process rules with 'enabled' property (always on/off rules)
    // Time-based rules are not shown in the UI per requirements
    for (let i = 0; i < ruleIds.length && i < 3; i++) {
      const ruleId = ruleIds[i];
      if (!ruleId) continue;
      
      try {
        let enabled = false;
        
        // Only enable the rule that matches dest value
        if (dest > 0 && dest === (i + 1)) {
          enabled = true;
        }
        
        logger.info(`Setting rule ${ruleId} to ${enabled ? 'enabled' : 'disabled'}`, {
          ruleId,
          accountId,
          ruleIndex: i,
          dest
        });
        
        // Use PATCH to update just the enabled field
        const response = await kazooService.axios.patch(`/accounts/${accountId}/temporal_rules/${ruleId}`, {
          data: {
            enabled: enabled
          }
        });
        
        if (response.status !== 200) {
          throw new Error(`Unexpected response status: ${response.status}`);
        }
        
        logger.info(`Successfully updated rule ${ruleId}`);
      } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        logger.error(`Error updating rule ${ruleId}:`, {
          message: errorMessage,
          ruleIndex: i
        });
      }
    }
    
    // Clear the temporal rules cache
    const cacheKey = `kazoo:temporal_rules:enabled_only:${accountId}`;
    await redisService.del(cacheKey);
    
    logger.info(`Updated call redirection for device: ${mac}`, {
      ip: req.ip,
      dest,
      rulesUpdated: Math.min(ruleIds.length, 3)
    });
    
    // Build URLs for navigation
    const returnUrl = buildXmlAppUrl(req, 'redirect');
    const menuUrl = buildXmlAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps/redirect-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
  } catch (error) {
    logger.error(`Error saving redirect settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      stack: error.stack
    });
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<xmlapp title="Error">
  <view>
    <section>
      <text label="Unable to update call routing settings. Please try again later or contact support." />
    </section>
  </view>
  <SoftKeys>
    <Softkey action="QuitApp" label="Exit" />
  </SoftKeys>
</xmlapp>`);
  }
}

module.exports = {
  renderAppsMenu,
  renderCallForwarding,
  saveCallForwarding,
  renderConference,
  renderVoicemail,
  saveVoicemail,
  renderParking,
  renderRedirect,
  saveRedirect
};