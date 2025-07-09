const express = require('express');
const { param, validationResult } = require('express-validator');
const router = express.Router();

const { 
  validateMac, 
  authenticateDevice, 
  detectDeviceType, 
  updateLastProvision 
} = require('../middleware');

const provisioningController = require('../controllers/provisioning');
const odooService = require('../services/odoo');
const logger = require('../utils/logger');

// ==================== VALIDATION MIDDLEWARE ====================

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Input validation failed', {
      ip: req.ip,
      url: req.url,
      errors: errors.array(),
      userAgent: req.get('User-Agent')
    });
    return res.status(400).json({ 
      error: 'Invalid input parameters',
      details: errors.array()
    });
  }
  next();
};

// ==================== TOKEN EXTRACTION ====================

const extractTokenFromPath = [
  param('token').optional().isAlphanumeric().isLength({ min: 16, max: 64 })
    .withMessage('Token must be alphanumeric and between 16-64 characters'),
  handleValidationErrors,
  (req, res, next) => {
    const { token } = req.params;
    if (token) {
      req.query.token = token; // Put token in query for authenticateDevice middleware
    }
    next();
  }
];

// ==================== COMMON MIDDLEWARE CHAINS ====================

const provisioningMiddleware = [
  validateMac, 
  extractTokenFromPath,
  authenticateDevice, 
  detectDeviceType, 
  updateLastProvision
];

// ==================== PROVISIONING ROUTES ====================

// Define supported prefixes and their routes
const prefixes = ['/odoo', '/vvx', '/gs/21xx', '/yealink', '/v3'];

// Apply the same routes to each prefix
prefixes.forEach(prefix => {
  // Polycom concatenated format MUST come FIRST (before generic .cfg)
  // Otherwise the generic .cfg route will match first
  router.get(`${prefix}/:token?/:macWithType.cfg`, 
    (req, res, next) => {
      const { macWithType, token } = req.params;
      
      // Check if this ends with a Polycom config type
      let configType = null;
      let mac = null;
      
      if (macWithType.endsWith('reg')) {
        configType = 'reg';
        mac = macWithType.slice(0, -3);
      } else if (macWithType.endsWith('sip')) {
        configType = 'sip';
        mac = macWithType.slice(0, -3);
      } else if (macWithType.endsWith('softkey')) {
        configType = 'softkey';
        mac = macWithType.slice(0, -7);
      } else {
        // Not a Polycom format, skip to next route
        return next('route');
      }
      
      // Validate it's a valid MAC
      if (!mac.match(/^[0-9a-fA-F]{12}$/)) {
        return next('route');
      }
      
      req.params.mac = mac;
      req.params.configType = configType;
      
      if (token) {
        req.query.token = token;
      }
      
      next();
    },
    ...provisioningMiddleware, 
    provisioningController.renderPolycomConfig
  );
  
  // XML formats (Grandstream, Cisco, HT series)
  router.get(`${prefix}/:token?/:mac.xml`, ...provisioningMiddleware, provisioningController.renderConfig);
  
  // Yealink formats
  router.get(`${prefix}/:token?/:mac.boot`, ...provisioningMiddleware, provisioningController.renderYealinkBoot);
  router.get(`${prefix}/:token?/:mac.reg`, ...provisioningMiddleware, provisioningController.renderYealinkConfig);
  router.get(`${prefix}/:token?/:mac.sys`, ...provisioningMiddleware, provisioningController.renderYealinkConfig);
  
  // Standard CFG format (multiple vendors) - AFTER Polycom concatenated
  router.get(`${prefix}/:token?/:mac.cfg`, ...provisioningMiddleware, provisioningController.renderConfig);
  router.get(`${prefix}/:token?/:mac-web.cfg`, ...provisioningMiddleware, provisioningController.renderConfig);
  
  // Polycom with colon separator
  router.get(`${prefix}/:token?/:mac:configType(reg|sip|softkey).cfg`, ...provisioningMiddleware, provisioningController.renderPolycomConfig);
  
  // Algo pager
  router.get(`${prefix}/:token?/:mac.conf`, ...provisioningMiddleware, provisioningController.renderAlgoConfig);
  
  // Snom
  router.get(`${prefix}/:token?/:mac.snom`, ...provisioningMiddleware, provisioningController.renderSnomConfig);
  router.get(`${prefix}/:token?/:mac-firmware.snom`, validateMac, (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send('snomM300firmware');
  });
});

// ==================== GROUNDWIRE ROUTES ====================

router.get('/odoo/:pid.gw', [
  param('pid').isNumeric().withMessage('Partner ID must be numeric'),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { pid } = req.params;
      
      logger.info('Groundwire config request', {
        pid,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      // Get partner data directly
      const partnerFields = [
        'id', 'firstname', 'x_voip_ext', 'x_voip_user', 'x_voip_secret',
        'x_mobile_user', 'x_mobile_secret', 'commercial_partner_id',
        'x_kazoo_enabled', 'x_site'
      ];
      
      const partners = await odooService.executeMethod(
        'res.partner',
        'read',
        [[parseInt(pid)], partnerFields]
      );

      if (!partners || partners.length === 0) {
        logger.warn('Partner not found for Groundwire config', {
          pid,
          ip: req.ip
        });
        return res.status(404).json({ error: 'Partner not found' });
      }

      const partner = partners[0];

      // Get site data from partner's x_site field
      let siteData = null;
      if (partner.x_site && partner.x_site[0]) {
        const siteFields = ['x_gtz', 'x_city', 'x_co', 'x_tz'];
        const sites = await odooService.executeMethod(
          'kazoo_mgmt.sites',
          'read',
          [[partner.x_site[0]], siteFields]
        );
        siteData = sites[0] || null;
      }

      // Get organization data
      let organizationData = null;
      if (partner.commercial_partner_id && partner.commercial_partner_id[0]) {
        const orgFields = [
          'name', 'ref', 'x_kazoo_realm', 'x_pbxip', 
          'x_kazoo_enabled', 'x_legacy'
        ];
        
        const orgs = await odooService.executeMethod(
          'res.partner',
          'read',
          [[partner.commercial_partner_id[0]], orgFields]
        );
        
        organizationData = orgs[0] || null;
      }

      // Format data to match expected structure
      const deviceData = {
        device: null, // Groundwire doesn't need device data
        site: siteData,
        partners: [partner],
        organizations: [organizationData]
      };

      req.deviceData = deviceData;
      req.params.pid = pid;
      next();
    } catch (error) {
      logger.error(`Error loading partner data for Groundwire ${req.params.pid}:`, error);
      res.status(500).json({ error: 'Failed to load partner data' });
    }
  }
], updateLastProvision, provisioningController.renderGroundwireConfig);

router.get('/:pid.gw', [
  param('pid').isNumeric().withMessage('Partner ID must be numeric'),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { pid } = req.params;
      
      logger.info('Groundwire config request', {
        pid,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      // Get partner data directly
      const partnerFields = [
        'id', 'firstname', 'x_voip_ext', 'x_voip_user', 'x_voip_secret',
        'x_mobile_user', 'x_mobile_secret', 'commercial_partner_id',
        'x_kazoo_enabled', 'x_site'
      ];
      
      const partners = await odooService.executeMethod(
        'res.partner',
        'read',
        [[parseInt(pid)], partnerFields]
      );

      if (!partners || partners.length === 0) {
        logger.warn('Partner not found for Groundwire config', {
          pid,
          ip: req.ip
        });
        return res.status(404).json({ error: 'Partner not found' });
      }

      const partner = partners[0];

      // Get site data from partner's x_site field
      let siteData = null;
      if (partner.x_site && partner.x_site[0]) {
        const siteFields = ['x_gtz', 'x_city', 'x_co', 'x_tz'];
        const sites = await odooService.executeMethod(
          'kazoo_mgmt.sites',
          'read',
          [[partner.x_site[0]], siteFields]
        );
        siteData = sites[0] || null;
      }

      // Get organization data
      let organizationData = null;
      if (partner.commercial_partner_id && partner.commercial_partner_id[0]) {
        const orgFields = [
          'name', 'ref', 'x_kazoo_realm', 'x_pbxip', 
          'x_kazoo_enabled', 'x_legacy'
        ];
        
        const orgs = await odooService.executeMethod(
          'res.partner',
          'read',
          [[partner.commercial_partner_id[0]], orgFields]
        );
        
        organizationData = orgs[0] || null;
      }

      // Format data to match expected structure
      const deviceData = {
        device: null, // Groundwire doesn't need device data
        site: siteData,
        partners: [partner],
        organizations: [organizationData]
      };

      req.deviceData = deviceData;
      req.params.pid = pid;
      next();
    } catch (error) {
      logger.error(`Error loading partner data for Groundwire ${req.params.pid}:`, error);
      res.status(500).json({ error: 'Failed to load partner data' });
    }
  }
], updateLastProvision, provisioningController.renderGroundwireConfig);



module.exports = router;