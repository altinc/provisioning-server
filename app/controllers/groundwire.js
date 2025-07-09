const logger = require('../utils/logger');

/**
 * Detect mobile operating system from User-Agent
 * @param {string} userAgent - The User-Agent string
 * @returns {string} 'ios', 'android', or 'unknown'
 */
function getMobileOperatingSystem(userAgent) {
  if (/android/i.test(userAgent)) {
    return 'android';
  }
  
  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return 'ios';
  }
  
  return 'unknown';
}

/**
 * Render the Groundwire setup page
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderGroundwire(req, res) {
  try {
    const { id } = req.params;
    const userAgent = req.get('User-Agent') || '';
    const userOS = getMobileOperatingSystem(userAgent);
    
    // Log the request
    logger.info('Groundwire setup page requested', {
      id,
      userOS,
      userAgent,
      ip: req.ip,
      ipSource: req.ipSource
    });
    
    // Validate ID is numeric
    if (id && !/^\d+$/.test(id)) {
      logger.warn('Invalid Groundwire ID format', {
        id,
        ip: req.ip
      });
      return res.status(400).send('Invalid ID format');
    }
    
    // Determine page state
    let page = 'error';
    if (userOS !== 'unknown' && id) {
      page = id;
    }
    
    // Build provisioning URL
    const provisioningUrl = id ? `provlinkbs:pro.altinc.ca/odoo/${id}.gw` : '';
    
    // App store URLs
    const appStoreUrls = {
      ios: 'https://itunes.apple.com/us/app/acrobits-groundwire/id378503081?mt=8',
      android: 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.aliengroundwire&hl=en'
    };
    
    // Render template
    res.render('groundwire/index.html', {
      title: 'Alt Telecom - Install Groundwire',
      page,
      id,
      userOS,
      provisioningUrl,
      appStoreUrls,
      showSetup: userOS !== 'unknown' && id,
      showError: userOS === 'unknown' || !id,
      currentYear: new Date().getFullYear()
    });
    
  } catch (error) {
    logger.error('Error rendering Groundwire page:', error);
    res.status(500).send('Internal server error');
  }
}

/**
 * Render the Groundwire success page
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function renderGroundwireSuccess(req, res) {
  try {
    logger.info('Groundwire success page requested', {
      ip: req.ip,
      ipSource: req.ipSource
    });
    
    res.render('groundwire/success.html', {
      title: 'Alt Telecom - Success',
      currentYear: new Date().getFullYear()
    });
    
  } catch (error) {
    logger.error('Error rendering Groundwire success page:', error);
    res.status(500).send('Internal server error');
  }
}

module.exports = {
  renderGroundwire,
  renderGroundwireSuccess
};
