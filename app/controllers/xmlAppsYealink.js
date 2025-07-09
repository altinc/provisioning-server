/**
 * Yealink XML Applications Controller
 * 
 * Handles business logic for Yealink XML-based phone applications like call forwarding,
 * conference management, etc. Converts Kazoo/Odoo data to Yealink XML format.
 */
const logger = require('../utils/logger');
const kazooService = require('../services/kazoo');
const odooService = require('../services/odoo');
const redisService = require('../services/redis');

/**
 * Helper function to get device details from Odoo and Kazoo
 * Reused from the existing implementation
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
 * Build URL for Yealink XML app navigation
 * @param {Object} req - Express request object 
 * @param {string} feature - Feature name (e.g., "cfwd", "voicemail")
 * @param {Object} params - Additional query parameters
 * @returns {string} Full URL
 */
function buildYealinkAppUrl(req, feature, params = {}) {
  const baseUrl = getBaseUrl(req);
  
  // Get token and MAC from request
  const token = req.authToken;
  const mac = req.normalizedMac;
  
  // Build the base URL with the path format for path parameters
  let url = `${baseUrl}/xmlAppsYealink/${feature}/${token}/${mac}`;
  
  // Add additional query parameters
  if (Object.keys(params).length > 0) {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    url += `?${queryString}`;
  }
  
  logger.debug(`Built URL for Yealink ${feature}: ${url}`, {
    mac: mac,
    token: token ? 'present' : 'missing'
  });
  
  return url;
}

/**
 * Render the Yealink XML apps menu
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderAppsMenu(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering Yealink XML apps menu for device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      token: token
    });
    
    // Get URLs for navigation
    const cfwdUrl = buildYealinkAppUrl(req, 'cfwd');
    const voicemailUrl = buildYealinkAppUrl(req, 'voicemail');
    const redirectUrl = buildYealinkAppUrl(req, 'redirect');
    const conferenceUrl = buildYealinkAppUrl(req, 'conference');
    const parkingUrl = buildYealinkAppUrl(req, 'parking');
    
    // Template variables
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
    res.render('xml-apps-yealink/apps-menu.xml', templateVars);
  } catch (error) {
    logger.error(`Error rendering Yealink XML apps menu: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering XML apps menu');
  }
}

/**
 * Build URL for Yealink XML app navigation
 * @param {Object} req - Express request object 
 * @param {string} feature - Feature name (e.g., "cfwd", "voicemail")
 * @param {Object} params - Additional query parameters
 * @returns {string} Full URL
 */
function buildYealinkAppUrl(req, feature, params = {}) {
  const baseUrl = getBaseUrl(req);
  
  // Get token and MAC from request
  const token = req.authToken;
  const mac = req.normalizedMac;
  
  // Build the base URL - IMPORTANT: Don't nest paths with token and mac
  let url = `${baseUrl}/xmlAppsYealink/${feature}/${token}/${mac}`;
  
  // Add additional query parameters
  if (Object.keys(params).length > 0) {
    const queryString = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    url += `?${queryString}`;
  }
  
  logger.debug(`Built URL for Yealink ${feature}: ${url}`, {
    mac: mac,
    token: token ? 'present' : 'missing'
  });
  
  return url;
}

/**
 * Render call forwarding interface for Yealink - Main Menu
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderCallForwarding(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering call forwarding main menu for Yealink device: ${mac}`);
    
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
    
    // Build URLs for navigation - use separate paths
    const ringStyleUrl = buildYealinkAppUrl(req, 'cfwd_ring_style');
    const numberUrl = buildYealinkAppUrl(req, 'cfwd_number');
    const saveUrl = buildYealinkAppUrl(req, 'cfwd_save');
    const appsMenuUrl = buildYealinkAppUrl(req, 'menu');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      ringStyleUrl,
      numberUrl,
      saveUrl,
      appsMenuUrl,
      enabled: callForward.enabled ? 1 : 0,
      number: callForward.number || '',
      substitute: callForward.substitute ? 1 : 0,
      require_keypress: callForward.require_keypress ? 1 : 0,
      keep_caller_id: callForward.keep_caller_id ? 1 : 0,
      direct_calls_only: callForward.direct_calls_only ? 1 : 0,
      failover: callForward.failover ? 1 : 0,
      kazooData: data.kazooData || {}
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/cfwd.xml', templateVars);
    
    logger.info(`Rendered call forwarding main menu for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink call forwarding menu: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering call forwarding menu');
  }
}
/**
 * Render ring style selection menu for Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderRingStyleMenu(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering ring style menu for Yealink device: ${mac}`);
    
    // Get device and user data to get current number
    const data = await getDeviceData(mac);
    let number = '';
    
    // Get current number from user data if available
    if (data.user && data.user.call_forward && data.user.call_forward.number) {
      number = data.user.call_forward.number;
    }
    
    // Build URLs for navigation
    const cfwdUrl = buildYealinkAppUrl(req, 'cfwd');
    const saveUrl = buildYealinkAppUrl(req, 'cfwd_save');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      cfwdUrl,
      saveUrl,
      number
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/cfwd-ring-style.xml', templateVars);
    
    logger.info(`Rendered ring style menu for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink ring style menu: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering ring style menu');
  }
}
/**
 * Render number input screen for Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderNumberInput(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering number input for Yealink device: ${mac}`);
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    // Initialize call forwarding settings with defaults
    let callForward = {
      enabled: false,
      number: '',
      substitute: false,
      failover: false
    };
    
    // If we have Kazoo user data, get actual call forwarding settings
    if (data.user && data.user.call_forward) {
      callForward = {
        enabled: data.user.call_forward.enabled || false,
        number: data.user.call_forward.number || '',
        substitute: data.user.call_forward.substitute || false,
        failover: data.user.call_forward.failover || false
      };
    }
    
    // Build URLs for navigation
    const cfwdUrl = buildYealinkAppUrl(req, 'cfwd');
    const saveUrl = buildYealinkAppUrl(req, 'cfwd_save');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      cfwdUrl,
      saveUrl,
      number: callForward.number || '',
      enabled: callForward.enabled ? 1 : 0,
      substitute: callForward.substitute ? 1 : 0,
      failover: callForward.failover ? 1 : 0
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/cfwd-number.xml', templateVars);
    
    logger.info(`Rendered number input for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink number input: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering number input');
  }
}
/**
 * Save call forwarding settings from Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveCallForwarding(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from query string (Yealink uses GET)
    const number = req.query.number || '';
    const substitute = parseInt(req.query.substitute || 0);
    
    // Log the incoming parameters
    logger.info(`Processing Yealink call forwarding save`, {
      ip: req.ip,
      mac,
      substitute,
      number
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data.kazooData || !data.kazooData.account_id || !data.kazooData.user_id) {
      logger.warn(`Missing Kazoo data for Yealink device: ${mac}`);
      return res.status(404).send('Device not found or missing Kazoo integration');
    }
    
    // Determine enabled, substitute and failover based on substitute value
    // Substitute values:
    // 0 = Desk + Cell (enabled=true, substitute=false, failover=false)
    // 1 = Cell Only (enabled=true, substitute=true, failover=false)
    // 2 = Failover (enabled=true, substitute=false, failover=true)
    // 4 = Off (enabled=false, substitute=false, failover=false)
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
    } else {  // Desk + Cell (default)
      enabled = true;
      actualSubstitute = false;
      failover = false;
    }
    
    // Update Kazoo
    if (data.kazooData && data.kazooData.account_id && data.kazooData.user_id) {
      // Get existing settings to preserve other fields
      let existingSettings = {};
      if (data.user && data.user.call_forward) {
        existingSettings = data.user.call_forward;
      }
      
      const callForward = {
        ...existingSettings,
        enabled: enabled,
        number: number,
        substitute: actualSubstitute,
        failover: failover
      };
      
      await kazooService.updateCallForwarding(
        data.kazooData.account_id, 
        data.kazooData.user_id, 
        callForward
      );
      
      logger.info(`Updated call forwarding settings for Yealink device: ${mac}`, {
        ip: req.ip,
        settings: callForward
      });
    } else {
      logger.warn(`Cannot update call forwarding - missing Kazoo data for Yealink device: ${mac}`);
    }
    
    // Build URLs for navigation
    const returnUrl = buildYealinkAppUrl(req, 'cfwd');
    const menuUrl = buildYealinkAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/cfwd-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
  } catch (error) {
    logger.error(`Error saving Yealink call forwarding: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error saving call forwarding settings');
  }
}

/**
 * Render conference management interface for Yealink
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
                        (conference._read_only && conference._read_only.moderators ? conference._read_only.moderators : 0),
      menuUrl: buildYealinkAppUrl(req, 'menu')
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/conference.xml', templateVars);
    
    logger.info(`Rendered conference interface for Yealink device: ${mac}`, {
      ip: req.ip,
      action: action,
      isLocked: isLocked
    });
  } catch (error) {
    logger.error(`Error rendering Yealink conference: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering conference management');
  }
}

/**
 * Render voicemail settings interface for Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderVoicemail(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering voicemail settings for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data || !data.kazooData || !data.kazooData.account_id || !data.kazooData.user_id) {
      logger.warn(`Missing Kazoo data for Yealink device: ${mac}`);
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
    
    // Build URLs for navigation
    const emailUrl = buildYealinkAppUrl(req, 'vm_email');
    const vmToggleUrl = buildYealinkAppUrl(req, 'vm_toggle');
    const saveUrl = buildYealinkAppUrl(req, 'vm_save');
    const appsMenuUrl = buildYealinkAppUrl(req, 'menu');
    
    // Prepare template variables - use boolean directly, not integer
    const templateVars = {
      mac: mac,
      token,
      emailUrl,
      vmToggleUrl,
      saveUrl,
      appsMenuUrl,
      email: vmSettings.email,
      vm_to_email_enabled: vmSettings.vm_to_email_enabled, // Boolean value
      kazooData: data.kazooData
    };
    
    // Render the voicemail XML template
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/voicemail.xml', templateVars);
    
    logger.info(`Rendered voicemail settings for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink voicemail settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering voicemail settings');
  }
}

/**
 * Render email input screen for voicemail
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderEmailInput(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering email input for Yealink device: ${mac}`);
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    // Get current email and vm_to_email_enabled setting
    let email = '';
    let vm_to_email_enabled = 0;
    
    if (data.partner) {
      email = data.partner.email || '';
    }
    
    try {
      if (data.kazooData && data.kazooData.account_id && data.kazooData.user_id) {
        await kazooService.initialize(data.kazooData.account_id);
        const userData = await kazooService.getUser(data.kazooData.account_id, data.kazooData.user_id);
        
        if (userData) {
          email = userData.email || email;
          vm_to_email_enabled = userData.vm_to_email_enabled ? 1 : 0;
        }
      }
    } catch (error) {
      logger.warn(`Could not fetch Kazoo user data: ${error.message}`);
      // Continue with default settings
    }
    
    // Build URLs for navigation
    const voicemailUrl = buildYealinkAppUrl(req, 'voicemail');
    const saveUrl = buildYealinkAppUrl(req, 'vm_save');
    
    // Prepare template variables
    const templateVars = {
      mac,
      token,
      voicemailUrl,
      saveUrl,
      email,
      vm_to_email_enabled
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/vm-email.xml', templateVars);
    
    logger.info(`Rendered email input for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink email input: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering email input');
  }
}

/**
 * Render VM to Email toggle menu
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderVmToggle(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering VM to Email toggle for Yealink device: ${mac}`);
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    // Get current email
    let email = '';
    
    if (data.partner) {
      email = data.partner.email || '';
    }
    
    try {
      if (data.kazooData && data.kazooData.account_id && data.kazooData.user_id) {
        await kazooService.initialize(data.kazooData.account_id);
        const userData = await kazooService.getUser(data.kazooData.account_id, data.kazooData.user_id);
        
        if (userData) {
          email = userData.email || email;
        }
      }
    } catch (error) {
      logger.warn(`Could not fetch Kazoo user data: ${error.message}`);
      // Continue with default settings
    }
    
    // Build URLs for navigation
    const voicemailUrl = buildYealinkAppUrl(req, 'voicemail');
    const saveUrl = buildYealinkAppUrl(req, 'vm_save');
    
    // Prepare template variables
    const templateVars = {
      mac,
      token,
      voicemailUrl,
      saveUrl,
      email
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/vm-toggle.xml', templateVars);
    
    logger.info(`Rendered VM to Email toggle for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
  } catch (error) {
    logger.error(`Error rendering Yealink VM toggle: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering VM toggle');
  }
}

/**
 * Save voicemail settings from Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveVoicemail(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from query string (Yealink uses GET)
    const email = req.query.email || '';
    const vm_to_email_enabled = req.query.vm_to_email_enabled === 'true' || req.query.vm_to_email_enabled === '1';
    
    logger.info(`Saving voicemail settings for Yealink device: ${mac}`, {
      ip: req.ip,
      email,
      vm_to_email_enabled
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data || !data.kazooData || !data.kazooData.account_id || !data.kazooData.user_id) {
      logger.warn(`Missing Kazoo data for Yealink device: ${mac}`);
      return res.status(404).send('Device not found or missing Kazoo integration');
    }
    
    // Update Kazoo if we have the necessary data
    try {
      // Initialize the Kazoo service with the account ID
      await kazooService.initialize(data.kazooData.account_id);
      
      // Get current user data first
      const user = await kazooService.getUser(data.kazooData.account_id, data.kazooData.user_id);
      
      // Update only the specific fields we want to change
      const updatedUser = {
        ...user,
        email: email,
        vm_to_email_enabled: vm_to_email_enabled
      };
      
      logger.info(`Updating voicemail settings for user ${data.kazooData.user_id}`, {
        email,
        vm_to_email_enabled,
        account_id: data.kazooData.account_id
      });
      
      // Update the user using the Kazoo API
      const response = await kazooService.axios.post(`/accounts/${data.kazooData.account_id}/users/${data.kazooData.user_id}`, {
        data: updatedUser
      });
      
      if (response.status === 200) {
        logger.info(`Successfully updated voicemail settings for user ${data.kazooData.user_id}`);
        
        // Clear the cache
        const cacheKey = `kazoo:user:${data.kazooData.account_id}:${data.kazooData.user_id}`;
        await redisService.del(cacheKey);
      } else {
        throw new Error(`Unexpected response: ${response.status}`);
      }
    } catch (error) {
      // Enhanced error logging
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
    const returnUrl = buildYealinkAppUrl(req, 'voicemail');
    const menuUrl = buildYealinkAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/vm-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
    
    logger.info(`Saved voicemail settings for Yealink device: ${mac}`, {
      ip: req.ip,
      email,
      vm_to_email_enabled
    });
  } catch (error) {
    logger.error(`Error saving Yealink voicemail settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error saving voicemail settings');
  }
}
/**
 * Render parking management interface for Yealink
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
      menuUrl: buildYealinkAppUrl(req, 'menu')
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/parking.xml', templateVars);
    
    logger.info(`Rendered parking management for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      lotsInUse: parkingLots.filter(lot => lot.inUse).length
    });
  } catch (error) {
    logger.error(`Error rendering Yealink parking management: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering parking management');
  }
}

/**
 * Enhanced implementation for Yealink Redirect functionality
 * Addresses the circular reference error in JSON.stringify
 */

/**
 * Render call redirection interface for Yealink
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderRedirect(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    logger.info(`Rendering call redirection for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Get device and user data
    const data = await getDeviceData(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      logger.warn('Missing Kazoo account data', { mac });
      throw new Error('Missing Kazoo account data');
    }
    
    const accountId = data.kazooData.account_id;
    
    // Get available temporal rules using the kazooService
    const rules = await kazooService.getTemporalRules(accountId);
    
    // Sort rules by name
    const sortedRules = rules.sort((a, b) => {
      if (a.name && b.name) {
        return a.name.localeCompare(b.name);
      }
      return 0;
    });
    
    // Get the first 3 rules (as in original PHP)
    const limitedRules = sortedRules.slice(0, 3);
    
    // Prepare data for template
    const ruleData = {
      ids: limitedRules.map(rule => rule.id),
      names: limitedRules.map(rule => rule.name || 'Unnamed Rule'),
      states: limitedRules.map(rule => {
        // Check rule state: null=time-based, true=on, false=off
        if (rule.enabled === true) return 'on';
        if (rule.enabled === false) return 'off';
        return 'time';
      }),
    };
    
    // Build URLs for navigation - add new rule URL
    const redirectRuleUrl = buildYealinkAppUrl(req, 'redirect_rule');
    
    // Prepare template variables
    const templateVars = {
      mac: mac,
      token,
      redirectRuleUrl,
      menuUrl: buildYealinkAppUrl(req, 'menu'),
      ruleIds: ruleData.ids,
      ruleNames: ruleData.names,
      ruleStates: ruleData.states,
      accountId: accountId,
      title: 'Call Routing'
    };
    
    logger.debug('Template variables for Yealink redirect.xml:', templateVars);
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/redirect.xml', templateVars);
    
    logger.info(`Rendered call redirection for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      rules: ruleData.names.length
    });
  } catch (error) {
    logger.error(`Error rendering Yealink call redirection: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering call redirection');
  }
}

/**
 * Render rule details menu for a specific temporal rule
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderRedirectRule(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    const { ruleId, ruleName, state } = req.query;
    
    if (!ruleId || !ruleName) {
      logger.warn('Missing required parameters for redirect rule', {
        mac,
        params: req.query
      });
      throw new Error('Missing required parameters');
    }
    
    logger.info(`Rendering call redirection rule for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      ruleId,
      ruleName
    });
    
    // Build URLs for navigation
    const saveUrl = buildYealinkAppUrl(req, 'redirect_save');
    const redirectUrl = buildYealinkAppUrl(req, 'redirect');
    
    // Prepare template variables
    const templateVars = {
      mac,
      token,
      ruleId,
      ruleName,
      currentState: state || 'time',
      saveUrl,
      redirectUrl
    };
    
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/redirect-rule.xml', templateVars);
    
    logger.info(`Rendered call redirection rule for Yealink device: ${mac}`, {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      ruleId,
      ruleName
    });
  } catch (error) {
    logger.error(`Error rendering Yealink call redirection rule: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      error: error.stack
    });
    res.status(500).send('Error rendering call redirection rule');
  }
}

/**
 * Save redirect settings for a single rule using PATCH for partial updates
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function saveRedirect(req, res) {
  try {
    const mac = req.normalizedMac;
    const token = req.authToken;
    
    // Get parameters from request body or query
    const { ruleId, status } = req.query;
    
    if (!ruleId || !status) {
      logger.warn('Missing required parameters for save redirect', {
        mac,
        params: req.query
      });
      throw new Error('Missing required parameters');
    }
    
    logger.info(`Saving redirect settings for Yealink device: ${mac}`, {
      ip: req.ip,
      ruleId,
      status
    });
    
    // Get device data to get the correct account ID
    const data = await getDeviceData(mac);
    
    if (!data.kazooData || !data.kazooData.account_id) {
      throw new Error('Missing Kazoo account data');
    }
    
    // Use the account ID from device data
    const accountId = data.kazooData.account_id;
    
    // Initialize Kazoo connection if needed
    await kazooService.initialize(accountId);
    
    if (status === 'on' || status === 'off') {
      // For enabling/disabling, we can use PATCH with just the enabled field
      const enabled = status === 'on';
      
      logger.info(`Setting rule ${ruleId} to ${status === 'on' ? 'Always On' : 'Always Off'}`, {
        ruleId,
        accountId,
        enabled
      });
      
      try {
        // Use PATCH instead of POST for partial updates
        const response = await kazooService.axios.patch(`/accounts/${accountId}/temporal_rules/${ruleId}`, {
          data: {
            enabled: enabled
          }
        });
        
        if (response.status !== 200) {
          throw new Error(`Unexpected response status: ${response.status}`);
        }
        
        logger.info(`Successfully set rule ${ruleId} to ${status === 'on' ? 'Always On' : 'Always Off'}`);
      } catch (error) {
        // Safe error handling
        const errorMessage = error.message || 'Unknown error';
        let statusCode = 'unknown';
        let responsePreview = 'No data';
        
        try {
          if (error.response) {
            statusCode = error.response.status || 'unknown';
            if (error.response.data) {
              responsePreview = typeof error.response.data === 'string' 
                ? error.response.data.substring(0, 100) 
                : JSON.stringify(error.response.data).substring(0, 100);
            }
          }
        } catch (extractError) {
          responsePreview = 'Error extracting response data';
        }
        
        logger.error(`Error updating rule ${ruleId}:`, {
          message: errorMessage,
          status: statusCode,
          responsePreview
        });
        
        throw new Error(`Failed to update rule: ${errorMessage}`);
      }
    } else if (status === 'time') {
      // For time-based, we need to get the full rule first and then update
      try {
        logger.info(`Getting current rule data for ${ruleId}`, {
          ruleId,
          accountId
        });
        
        // Get current rule data
        const ruleResponse = await kazooService.axios.get(`/accounts/${accountId}/temporal_rules/${ruleId}`);
        
        if (!ruleResponse.data || !ruleResponse.data.data) {
          throw new Error('Invalid response format from Kazoo API');
        }
        
        // Extract the rule data
        const ruleData = ruleResponse.data.data;
        
        logger.info(`Setting rule ${ruleId} to Time Based`, {
          ruleId,
          accountId
        });
        
        // If the rule has enabled property, remove it using PATCH
        if (ruleData.hasOwnProperty('enabled')) {
          // Use PATCH to remove the 'enabled' property
          const response = await kazooService.axios.patch(`/accounts/${accountId}/temporal_rules/${ruleId}`, {
            data: {
              enabled: null  // Setting to null will remove the property in some APIs
            }
          });
          
          if (response.status !== 200) {
            throw new Error(`Unexpected response status: ${response.status}`);
          }
          
          logger.info(`Successfully set rule ${ruleId} to Time Based`);
        } else {
          logger.info(`Rule ${ruleId} is already Time Based (no enabled property)`);
        }
      } catch (error) {
        // Safe error handling
        const errorMessage = error.message || 'Unknown error';
        let statusCode = 'unknown';
        let responsePreview = 'No data';
        
        try {
          if (error.response) {
            statusCode = error.response.status || 'unknown';
            if (error.response.data) {
              responsePreview = typeof error.response.data === 'string' 
                ? error.response.data.substring(0, 100) 
                : JSON.stringify(error.response.data).substring(0, 100);
            }
          }
        } catch (extractError) {
          responsePreview = 'Error extracting response data';
        }
        
        logger.error(`Error setting rule ${ruleId} to Time Based:`, {
          message: errorMessage,
          status: statusCode,
          responsePreview
        });
        
        throw new Error(`Failed to set rule to Time Based: ${errorMessage}`);
      }
    }
    
    // Build URLs for navigation
    const returnUrl = buildYealinkAppUrl(req, 'redirect');
    const menuUrl = buildYealinkAppUrl(req, 'menu');
    
    // Render success screen
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.render('xml-apps-yealink/redirect-success.xml', {
      mac: mac,
      token,
      returnUrl,
      menuUrl
    });
    
    logger.info(`Updated call redirection rule for device: ${mac}`, {
      ip: req.ip,
      ruleId,
      status
    });
  } catch (error) {
    // Safe error handling for the outer try/catch
    logger.error(`Error saving Yealink redirect settings: ${error.message}`, {
      mac: req.normalizedMac,
      ip: req.ip,
      stack: error.stack
    });
    
    // Send a more user-friendly error response
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<YealinkIPPhoneTextScreen>
  <Title>Error</Title>
  <Text>Unable to update call routing settings. Please try again later or contact support.</Text>
  <SoftKey index="1">
    <Label>Back</Label>
    <URI>${buildYealinkAppUrl(req, 'redirect')}</URI>
  </SoftKey>
  <SoftKey index="4">
    <Label>Exit</Label>
    <URI>SoftKey:Exit</URI>
  </SoftKey>
</YealinkIPPhoneTextScreen>`);
  }
}

module.exports = {
  renderAppsMenu,
  renderCallForwarding,
  renderRingStyleMenu,
  renderNumberInput,
  saveCallForwarding,
  renderConference,
  renderVoicemail,
  renderEmailInput,
  renderVmToggle,
  saveVoicemail,
  renderParking,
  renderRedirect,
  renderRedirectRule,
  saveRedirect
};