/**
 * Yealink XML Applications Routes
 * 
 * Handles routes for Yealink XML-based phone applications like call forwarding,
 * conference management, etc.
 */
const express = require('express');
const { param, query, validationResult } = require('express-validator');
const router = express.Router();

const xmlAppsYealinkController = require('../controllers/xmlAppsYealink');
const auth = require('../utils/auth');
const logger = require('../utils/logger');

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Yealink XML App validation failed', {
      ip: req.ip,
      url: req.url,
      errors: errors.array(),
      userAgent: req.get('User-Agent')
    });
    return res.status(400).send('Invalid parameters');
  }
  next();
};

// Authentication middleware for XML apps
const authenticateXmlApp = (req, res, next) => {
  try {
    // For Yealink, the MAC and token might be in query parameters
    const mac = req.params.mac || req.query.mac;
    const token = req.params.token || req.query.token;
    
    if (!mac) {
      logger.warn('Yealink XML App access attempted without MAC', {
        ip: req.ip,
        url: req.url,
        userAgent: req.get('User-Agent')
      });
      return res.status(400).send('MAC address required');
    }

    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();

    // Check for token authentication
    if (!token) {
      logger.warn('Yealink XML App access attempted without token', {
        ip: req.ip,
        mac: normalizedMac,
        url: req.url,
        userAgent: req.get('User-Agent')
      });
      return res.status(403).send('Authentication token required');
    }

    const isValidToken = auth.validateAuthToken(normalizedMac, token);
    if (!isValidToken) {
      logger.warn('Invalid token for Yealink XML App access', {
        ip: req.ip,
        mac: normalizedMac,
        url: req.url,
        userAgent: req.get('User-Agent')
      });
      return res.status(403).send('Invalid authentication token');
    }

    // Store the normalized MAC and token for use in controllers
    req.normalizedMac = normalizedMac;
    req.authToken = token;
    next();
  } catch (error) {
    logger.error('Error in Yealink XML App authentication:', error);
    res.status(500).send('Authentication error');
  }
};

// Path parameter validation for routes with parameters in the path
const validatePathParams = [
  param('token').isString().isLength({ min: 16, max: 64 })
    .withMessage('Token must be alphanumeric and between 16-64 characters'),
  param('mac').isString().isLength({ min: 12, max: 17 })
    .withMessage('MAC address must be 12-17 characters'),
  handleValidationErrors
];

// Query parameter validation for routes with parameters in the query string
const validateQueryParams = [
  query('token').optional().isString().isLength({ min: 16, max: 64 })
    .withMessage('Token must be alphanumeric and between 16-64 characters'),
  query('mac').optional().isString().isLength({ min: 12, max: 17 })
    .withMessage('MAC address must be 12-17 characters'),
  handleValidationErrors
];

// ============================ XML App Routes ============================

// Main menu
router.get('/menu/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderAppsMenu);
router.get('/menu', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderAppsMenu);

// Call Forwarding - Fixed routes with flat structure
router.get('/cfwd/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderCallForwarding);
router.get('/cfwd_ring_style/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderRingStyleMenu);
router.get('/cfwd_number/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderNumberInput);
router.get('/cfwd_save/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.saveCallForwarding);

// Call Forwarding - Query string versions
router.get('/cfwd', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderCallForwarding);
router.get('/cfwd_ring_style', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderRingStyleMenu);
router.get('/cfwd_number', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderNumberInput);
router.get('/cfwd_save', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.saveCallForwarding);
// Conference management
router.get('/conference/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderConference);
router.get('/conference', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderConference);

// Voicemail settings - Menu-based approach
router.get('/voicemail/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderVoicemail);
router.get('/vm_email/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderEmailInput);
router.get('/vm_toggle/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderVmToggle);
router.get('/vm_save/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.saveVoicemail);

// Voicemail settings - Query string versions
router.get('/voicemail', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderVoicemail);
router.get('/vm_email', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderEmailInput);
router.get('/vm_toggle', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderVmToggle);
router.get('/vm_save', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.saveVoicemail);

// Parking management
router.get('/parking/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderParking);
router.get('/parking', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderParking);

// Call redirection with path parameters
router.get('/redirect/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderRedirect);
router.get('/redirect_rule/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.renderRedirectRule);
router.get('/redirect_save/:token/:mac', validatePathParams, authenticateXmlApp, xmlAppsYealinkController.saveRedirect);

// Call redirection with query parameters (fallback)
router.get('/redirect', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderRedirect);
router.get('/redirect_rule', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.renderRedirectRule);
router.get('/redirect_save', validateQueryParams, authenticateXmlApp, xmlAppsYealinkController.saveRedirect);

// ============================ Error handling ============================
// Generic error handler for Yealink XML apps
router.use((err, req, res, next) => {
  logger.error('Yealink XML App error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    ip: req.ip,
    mac: req.normalizedMac
  });
  
  // For Yealink XML apps, return a valid XML error response
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<YealinkIPPhoneTextScreen>
  <Title>Error</Title>
  <Text>An error occurred. Please try again later.</Text>
  <SoftKey index="1">
    <Label>Exit</Label>
    <URI>SoftKey:Exit</URI>
  </SoftKey>
</YealinkIPPhoneTextScreen>`);
});

module.exports = router;