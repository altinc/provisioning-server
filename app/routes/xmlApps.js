/**
 * XML Applications Routes
 * 
 * Handles routes for XML-based phone applications like call forwarding,
 * conference management, etc.
 */
const express = require('express');
const { param, validationResult } = require('express-validator');
const router = express.Router();

const xmlAppsController = require('../controllers/xmlApps');
const { validateAuthToken } = require('../utils/auth');
const logger = require('../utils/logger');

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('XML App validation failed', {
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
    const { mac, token } = req.params;
    
    if (!mac) {
      logger.warn('XML App access attempted without MAC', {
        ip: req.ip,
        url: req.url,
        userAgent: req.get('User-Agent')
      });
      return res.status(400).send('MAC address required');
    }

    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();

    // Check for token authentication
    if (!token) {
      logger.warn('XML App access attempted without token', {
        ip: req.ip,
        mac: normalizedMac,
        url: req.url,
        userAgent: req.get('User-Agent')
      });
      return res.status(403).send('Authentication token required');
    }
    
    const isValidToken = validateAuthToken(normalizedMac, token);
    if (!isValidToken) {
      logger.warn('Invalid token for XML App access', {
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
    logger.error('Error in XML App authentication:', error);
    res.status(500).send('Authentication error');
  }
};

// Path parameter validation
const validateParams = [
  param('token').isString().isLength({ min: 16, max: 64 })
    .withMessage('Token must be alphanumeric and between 16-64 characters'),
  param('mac').isString().isLength({ min: 12, max: 17 })
    .withMessage('MAC address must be 12-17 characters'),
  handleValidationErrors
];

// ============================ XML App Routes ============================

// Main menu
router.get('/menu/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderAppsMenu);

// Call Forwarding
router.get('/cfwd/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderCallForwarding);
router.get('/saveCfwd/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.saveCallForwarding);

// Conference management
router.get('/conference/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderConference);

// Voicemail settings
router.get('/voicemail/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderVoicemail);
router.get('/saveVoicemail/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.saveVoicemail);

// Parking management
router.get('/parking/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderParking);

// Call redirection
router.get('/redirect/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.renderRedirect);
router.get('/saveRedirect/:token/:mac', validateParams, authenticateXmlApp, xmlAppsController.saveRedirect);

// ============================ Error handling ============================
// Generic error handler for XML apps
router.use((err, req, res, next) => {
  logger.error('XML App error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    ip: req.ip,
    mac: req.normalizedMac
  });
  
  // For XML apps, we need to return valid XML even for errors
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8" ?>
<xmlapp title="Error">
 <view>
  <section>
   <text label="An error occurred. Please try again later." />
  </section>
 </view>
 <SoftKeys>
  <Softkey action="QuitApp" label="Exit" />
 </SoftKeys>
</xmlapp>`);
});

module.exports = router;