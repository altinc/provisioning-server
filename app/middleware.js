const logger = require('./utils/logger');
const { validateAuthToken, generateAuthToken } = require('./utils/auth');
const odooService = require('./services/odoo');

// Track failed authentication attempts in memory (use Redis in production)
const failedAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

/**
 * ENHANCED: Request logging middleware with comprehensive IP tracking
 */
const requestLogger = (req, res, next) => {
  const start = Date.now();
  const { method, url, ip } = req;
  const userAgent = req.get('User-Agent') || 'Unknown';

  // Enhanced logging with IP source tracking
  const logData = {
    ip,
    userAgent,
    timestamp: new Date().toISOString(),
    method,
    url
  };

  // Add IP source information if available
  if (req.ipSource) {
    logData.ipSource = req.ipSource;
  }

  // Add debug IP info for troubleshooting (only in development or debug mode)
  if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
    if (req.ipDebug) {
      logData.ipDebug = {
        source: req.ipDebug.source,
        originalIP: req.ipDebug.originalIP,
        cfConnectingIP: req.ipDebug.headers['CF-Connecting-IP'],
        xRealIP: req.ipDebug.headers['X-Real-IP'],
        xForwardedFor: req.ipDebug.headers['X-Forwarded-For']
      };
    }
  }

  // Log the request with enhanced IP information
  logger.info(`${method} ${url}`, logData);

  // Log response when finished with additional details
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    const responseLogData = {
      ip,
      userAgent,
      duration: `${duration}ms`,
      statusCode: res.statusCode,
      method,
      url
    };

    // Add IP source for response log too
    if (req.ipSource) {
      responseLogData.ipSource = req.ipSource;
    }

    // Add MAC address if available (for provisioning requests)
    if (req.normalizedMac) {
      responseLogData.mac = req.normalizedMac;
    }

    // Add device type if detected
    if (req.deviceType) {
      responseLogData.deviceType = req.deviceType;
    }

    // Add template file if available
    if (req.templateFile) {
      responseLogData.templateFile = req.templateFile;
    }

    // Add first provision flag if available
    if (req.isFirstProvision !== undefined) {
      responseLogData.isFirstProvision = req.isFirstProvision;
    }

    // Add debug auth bypass flag if present
    if (req.debugAuthBypass) {
      responseLogData.debugAuthBypass = true;
    }

    logger.info(`${method} ${url} - ${res.statusCode}`, responseLogData);
  });

  next();
};

/**
 * ENHANCED: Security event logging middleware with better IP tracking
 */
const securityLogger = (req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(data) {
    const baseSecurityLog = {
      ip: req.ip,
      url: req.url,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    };

    // Add IP source information
    if (req.ipSource) {
      baseSecurityLog.ipSource = req.ipSource;
    }

    // Add MAC if available for security events
    if (req.normalizedMac) {
      baseSecurityLog.mac = req.normalizedMac;
    }

    // Log security-relevant events
    if (res.statusCode === 401) {
      logger.warn('Authentication failed', {
        ...baseSecurityLog,
        statusCode: res.statusCode,
        securityEvent: 'auth_failed'
      });
    } else if (res.statusCode === 403) {
      logger.warn('Authorization failed', {
        ...baseSecurityLog,
        statusCode: res.statusCode,
        securityEvent: 'auth_denied'
      });
    } else if (res.statusCode === 404 && (req.url.includes('.xml') || req.url.includes('.cfg'))) {
      logger.warn('Device configuration not found', {
        ...baseSecurityLog,
        statusCode: res.statusCode,
        securityEvent: 'config_not_found'
      });
    } else if (res.statusCode === 429) {
      logger.warn('Rate limit exceeded', {
        ...baseSecurityLog,
        statusCode: res.statusCode,
        securityEvent: 'rate_limit_exceeded'
      });
    }
    
    return originalSend.call(this, data);
  };
  
  next();
};

/**
 * Check if IP is locked out due to failed attempts
 */
const checkRateLimit = (ip) => {
  const attempts = failedAttempts.get(ip);
  if (!attempts) return false;
  
  if (attempts.count >= MAX_FAILED_ATTEMPTS) {
    const timeSinceLastAttempt = Date.now() - attempts.lastAttempt;
    if (timeSinceLastAttempt < LOCKOUT_DURATION) {
      return true; // Still locked out
    } else {
      // Lockout expired, reset counter
      failedAttempts.delete(ip);
      return false;
    }
  }
  
  return false;
};

/**
 * ENHANCED: Record failed authentication attempt with IP source tracking
 */
const recordFailedAttempt = (ip, ipSource = 'unknown', additionalInfo = {}) => {
  const attempts = failedAttempts.get(ip) || { count: 0, lastAttempt: Date.now() };
  attempts.count++;
  attempts.lastAttempt = Date.now();
  failedAttempts.set(ip, attempts);
  
  logger.warn('Failed authentication attempt recorded', {
    ip,
    ipSource,
    attemptCount: attempts.count,
    timestamp: new Date().toISOString(),
    ...additionalInfo
  });
  
  if (attempts.count >= MAX_FAILED_ATTEMPTS) {
    logger.error('IP address locked out due to excessive failed attempts', {
      ip,
      ipSource,
      lockoutDuration: LOCKOUT_DURATION / 1000 / 60 + ' minutes',
      timestamp: new Date().toISOString(),
      ...additionalInfo
    });
  }
};

/**
 * ENHANCED: Clear failed attempts for successful authentication
 */
const clearFailedAttempts = (ip, ipSource = 'unknown', additionalInfo = {}) => {
  if (failedAttempts.has(ip)) {
    failedAttempts.delete(ip);
    logger.info('Failed attempts cleared for successful authentication', { 
      ip, 
      ipSource,
      ...additionalInfo 
    });
  }
};

/**
 * ENHANCED: Authentication middleware with better IP tracking
 */
const authenticateDevice = async (req, res, next) => {
  try {
    const { mac } = req.params;
    const { token } = req.query; // Token comes from query string ?token=xxx
    const clientIP = req.ip;
    const ipSource = req.ipSource || 'unknown';
    
    // Check for token auth bypass (DEBUG MODE)
    const isTokenAuthDisabled = process.env.DISABLE_TOKEN_AUTH === 'true';
    
    if (!mac) {
      return res.status(400).json({ error: 'MAC address required' });
    }

    // Check if IP is locked out (still apply rate limiting even in debug mode)
    if (checkRateLimit(clientIP)) {
      logger.warn('Request blocked due to rate limiting', {
        ip: clientIP,
        ipSource,
        mac: req.normalizedMac,
        timestamp: new Date().toISOString()
      });
      return res.status(429).json({ 
        error: 'Too many failed attempts. Please try again later.',
        retryAfter: Math.ceil(LOCKOUT_DURATION / 1000)
      });
    }

    // MAC is already normalized by validateMac middleware
    const normalizedMac = req.normalizedMac;

    // Check if device exists in Odoo
    const deviceData = await odooService.getDeviceData(normalizedMac);
    
    if (!deviceData) {
      recordFailedAttempt(clientIP, ipSource, { 
        mac: normalizedMac,
        userAgent: req.get('User-Agent'),
        reason: 'device_not_found'
      });
      logger.warn(`Device not found: ${normalizedMac}`, { 
        ip: clientIP,
        ipSource,
        userAgent: req.get('User-Agent')
      });
      return res.status(404).json({ error: 'Device not found' });
    }

    // If device has never been provisioned, allow without token
    // Handle Odoo Char field that could be: "", "false", false, null, undefined
    const lastProv = deviceData.device.x_last_prov;
    const isFirstProvision = !lastProv || 
                           lastProv === false || 
                           lastProv === 'false' || 
                           lastProv === '' ||
                           lastProv === '0';
    
    if (isFirstProvision) {
      clearFailedAttempts(clientIP, ipSource, { 
        mac: normalizedMac,
        reason: 'first_provision'
      });
      logger.info(`First-time provisioning for device: ${normalizedMac}`, { 
        ip: clientIP,
        ipSource,
        x_last_prov: lastProv,
        x_last_prov_type: typeof lastProv
      });
      req.deviceData = deviceData;
      req.isFirstProvision = true;
      return next();
    }

    // DEBUG MODE: Check if token authentication is disabled
    if (isTokenAuthDisabled) {
      clearFailedAttempts(clientIP, ipSource, { 
        mac: normalizedMac,
        reason: 'debug_mode_bypass'
      });
      
      // Still log what would have happened with token validation
      if (token) {
        const isValidToken = validateAuthToken(normalizedMac, token);
        logger.info(`[DEBUG MODE] Token auth bypassed for device: ${normalizedMac}`, {
          ip: clientIP,
          ipSource,
          providedToken: token,
          tokenWouldBeValid: isValidToken,
          userAgent: req.get('User-Agent'),
          warning: 'DISABLE_TOKEN_AUTH is enabled - this should only be used for debugging!'
        });
      } else {
        logger.info(`[DEBUG MODE] Token auth bypassed for device: ${normalizedMac}`, {
          ip: clientIP,
          ipSource,
          noTokenProvided: true,
          userAgent: req.get('User-Agent'),
          warning: 'DISABLE_TOKEN_AUTH is enabled - this should only be used for debugging!'
        });
      }
      
      req.deviceData = deviceData;
      req.isFirstProvision = false;
      req.debugAuthBypass = true; // Flag for logging purposes
      return next();
    }

    // Normal token validation (when DISABLE_TOKEN_AUTH is not set or false)
    if (token) {
      const isValidToken = validateAuthToken(normalizedMac, token);
      if (!isValidToken) {
        recordFailedAttempt(clientIP, ipSource, { 
          mac: normalizedMac,
          userAgent: req.get('User-Agent'),
          reason: 'invalid_token',
          providedToken: token
        });
        logger.warn(`Invalid auth token for device: ${normalizedMac}`, { 
          ip: clientIP,
          ipSource,
          providedToken: token,
          userAgent: req.get('User-Agent')
        });
        return res.status(403).json({ error: 'Invalid authentication token' });
      }
      clearFailedAttempts(clientIP, ipSource, { 
        mac: normalizedMac,
        reason: 'valid_token'
      });
    } else {
      // Device has been provisioned before but no token provided
      recordFailedAttempt(clientIP, ipSource, { 
        mac: normalizedMac,
        userAgent: req.get('User-Agent'),
        reason: 'missing_token'
      });
      logger.warn(`Missing auth token for previously provisioned device: ${normalizedMac}`, { 
        ip: clientIP,
        ipSource,
        userAgent: req.get('User-Agent')
      });
      return res.status(403).json({ 
        error: 'Authentication token required',
        hint: 'Device has been previously provisioned and requires authentication'
      });
    }

    req.deviceData = deviceData;
    req.isFirstProvision = false;
    next();
  } catch (error) {
    logger.error('Authentication error:', {
      error: error.message,
      stack: error.stack,
      ip: req.ip,
      ipSource: req.ipSource,
      mac: req.params.mac,
      userAgent: req.get('User-Agent')
    });
    res.status(500).json({ error: 'Authentication failed' });
  }
};

/**
 * Detect device type based on User-Agent and request format
 */
const detectDeviceType = (req, res, next) => {
  const userAgent = req.get('User-Agent') || '';
  
  let deviceType = 'unknown';
  let templateFile = 'GXP2130.xml'; // Default template

  // Check if this is a Grandstream cfg-prefixed request
  const hasCfgPrefix = req.originalMacParam && req.originalMacParam.toLowerCase().startsWith('cfg');

  // Device type detection logic from original Python code
  if (userAgent.includes('GXP2130') || userAgent.includes('GXP2135') || userAgent.includes('GXP2140') || userAgent.includes('GXP2170')) {
    deviceType = 'grandstream_gxp';
    templateFile = 'GXP2130.xml';
  } else if (userAgent.includes('GXP1450')) {
    deviceType = 'grandstream_gxp';
    templateFile = 'GXP1450.xml';
  } else if (userAgent.includes('DP715')) {
    deviceType = 'grandstream_dect';
    templateFile = 'DP715.xml';
  } else if (userAgent.includes('GXV3275') || userAgent.includes('GXV3200') || userAgent.includes('GXV3240')) {
    deviceType = 'grandstream_video';
    templateFile = 'GXV3200.xml';
  } else if (userAgent.includes('GAC2500')) {
    deviceType = 'grandstream_video';
    templateFile = 'GXV3200.xml';
  } else if (userAgent.includes('HT-502') || userAgent.includes('HT704')) {
    deviceType = 'grandstream_ata';
    templateFile = 'HT502.xml';
  } else if (userAgent.includes('HT812')) {
    deviceType = 'grandstream_ata';
    templateFile = 'HT812.xml';
  } else if (userAgent.includes('HT813')) {
    deviceType = 'grandstream_ata';
    templateFile = 'HT813.xml';
  } else if (userAgent.includes('HT814') || userAgent.includes('HT818')) {
    deviceType = 'grandstream_ata';
    templateFile = 'HT818.xml';
  } else if (userAgent.includes('SPA303') || userAgent.includes('SPA504G')) {
    deviceType = 'cisco_spa';
    templateFile = 'SPA303.xml';
  } else if (userAgent.includes('snomM300')) {
    deviceType = 'snom_dect';
    templateFile = 'snom-m300.xml';
  } else if (userAgent.includes('snomD735') || userAgent.includes('snomD785')) {
    deviceType = 'snom_desk';
    templateFile = 'snom-d735.xml';
  } else if (userAgent.includes('Algo-8301')) {
    deviceType = 'algo_pager';
    templateFile = 'algo-8301.cfg';
  } else if (userAgent.includes('PolycomVVX') || userAgent.includes('Polycom')) {
    deviceType = 'polycom_vvx';
    templateFile = 'vvx.cfg'; // You'll need to create this template
      } else if (req.originalMacParam && req.originalMacParam.match(/^(?:4825|6416|0004f)/i)) {
    // MAC prefix detection for Polycom phones when no User-Agent
    deviceType = 'polycom_vvx';
    templateFile = 'vvx.cfg';
  } else if (userAgent.includes('Mozilla')) {
    // Browser access - default to GXP template for testing
    deviceType = 'browser';
    templateFile = 'GXP2130.xml';
  } else if (hasCfgPrefix) {
    // If no User-Agent match but has cfg prefix, assume Grandstream
    deviceType = 'grandstream_gxp';
    templateFile = 'GXP2130.xml';
  }

  req.deviceType = deviceType;
  req.templateFile = templateFile;
  
  logger.debug(`Device detection: ${deviceType}`, {
    userAgent,
    templateFile,
    mac: req.normalizedMac,
    originalMac: req.originalMacParam,
    hasCfgPrefix,
    ip: req.ip,
    ipSource: req.ipSource
  });

  next();
};

/**
 * ENHANCED: Update last provision timestamp and track device statistics in Redis
 */
const updateLastProvision = async (req, res, next) => {
  try {
    // Update x_last_prov field in Odoo and track stats in Redis after successful response
    res.on('finish', async () => {
      if (req.deviceData && req.normalizedMac) {
        const mac = req.normalizedMac;
        const timestamp = new Date().toISOString();
        const ip = req.ip;
        const ipSource = req.ipSource || 'unknown';
        const userAgent = req.get('User-Agent') || 'Unknown';
        const statusCode = res.statusCode;

        // Update Odoo timestamp for successful responses
        if (statusCode === 200) {
          try {
            await odooService.updateLastProvision(req.deviceData.id);
            
            const logData = {
              ip,
              ipSource,
              deviceId: req.deviceData.device.id,
              mac,
              statusCode
            };
            
            // Add debug flag to log if auth was bypassed
            if (req.debugAuthBypass) {
              logData.debugAuthBypass = true;
              logData.warning = 'Device updated while DISABLE_TOKEN_AUTH was enabled';
            }
            
            logger.info(`Updated last provision timestamp for device: ${mac}`, logData);
          } catch (error) {
            logger.error(`Failed to update last provision timestamp: ${error.message}`, {
              mac,
              deviceId: req.deviceData.device.id,
              ip,
              ipSource,
              error: error.message
            });
          }
        }

        // Track stats in Redis for all responses using the new method
        try {
          const redisService = require('./services/redis');
          
          const statsData = {
            lastSeen: timestamp,
            lastIP: ip,
            lastUserAgent: userAgent,
            statusCode: statusCode
          };
          
          const success = await redisService.updateDeviceStats(mac, statsData);
          
          if (success) {
            logger.debug(`Updated Redis stats for device: ${mac}`, {
              statusCode,
              ip,
              ipSource,
              timestamp
            });
          } else {
            logger.warn(`Failed to update Redis stats for device: ${mac}`, {
              ip,
              ipSource
            });
          }
        } catch (error) {
          logger.error(`Failed to update Redis stats for ${mac}:`, {
            error: error.message,
            ip,
            ipSource
          });
          // Don't fail the request if Redis stats update fails
        }
      }
    });
    next();
  } catch (error) {
    logger.error('Error in updateLastProvision middleware:', {
      error: error.message,
      ip: req.ip,
      ipSource: req.ipSource,
      mac: req.normalizedMac
    });
    next(); // Continue anyway, this is not critical
  }
};

/**
 * ENHANCED: Global error handler with better IP tracking
 */
const errorHandler = (err, req, res, next) => {
  // Log detailed error information
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    ipSource: req.ipSource,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString(),
    mac: req.normalizedMac,
    deviceType: req.deviceType
  });
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  const errorResponse = {
    error: isDevelopment ? err.message : 'Internal server error',
    timestamp: new Date().toISOString()
  };
  
  if (isDevelopment) {
    errorResponse.stack = err.stack;
    errorResponse.details = {
      url: req.url,
      method: req.method,
      params: req.params,
      query: req.query,
      ip: req.ip,
      ipSource: req.ipSource
    };
  }
  
  res.status(err.status || 500).json(errorResponse);
};

/**
 * ENHANCED: MAC address validation with support for Grandstream "cfg" prefix
 */
const validateMac = (req, res, next) => {
  let { mac } = req.params;
  
  if (!mac) {
    logger.warn('MAC address missing in request', {
      ip: req.ip,
      ipSource: req.ipSource,
      url: req.url,
      userAgent: req.get('User-Agent')
    });
    return res.status(400).json({ error: 'MAC address required' });
  }

  // Handle Grandstream "cfg" prefix (e.g., cfg000b82c06b04.xml)
  let originalMac = mac;
  if (mac.toLowerCase().startsWith('cfg')) {
    mac = mac.slice(3); // Remove "cfg" prefix
    logger.debug('Stripped cfg prefix from MAC address', {
      original: originalMac,
      stripped: mac,
      ip: req.ip,
      ipSource: req.ipSource,
      userAgent: req.get('User-Agent')
    });
  }

  // Allow various MAC formats: 12 hex chars with optional separators
  const macRegex = /^[0-9a-fA-F]{2}[:-]?[0-9a-fA-F]{2}[:-]?[0-9a-fA-F]{2}[:-]?[0-9a-fA-F]{2}[:-]?[0-9a-fA-F]{2}[:-]?[0-9a-fA-F]{2}$/;
  
  if (!macRegex.test(mac)) {
    logger.warn('Invalid MAC address format', {
      ip: req.ip,
      ipSource: req.ipSource,
      providedMac: originalMac,
      strippedMac: mac,
      url: req.url,
      userAgent: req.get('User-Agent')
    });
    return res.status(400).json({ error: 'Invalid MAC address format' });
  }

  // Normalize MAC address (remove colons, hyphens, make lowercase)
  req.normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
  
  // Store original for logging purposes
  req.originalMacParam = originalMac;

  logger.debug('MAC address validated', {
    original: originalMac,
    normalized: req.normalizedMac,
    hadCfgPrefix: originalMac.toLowerCase().startsWith('cfg'),
    ip: req.ip,
    ipSource: req.ipSource
  });

  next();
};

// Clean up failed attempts map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of failedAttempts.entries()) {
    if (now - attempts.lastAttempt > LOCKOUT_DURATION) {
      failedAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Clean up every 5 minutes

module.exports = {
  requestLogger,
  securityLogger,
  authenticateDevice,
  detectDeviceType,
  updateLastProvision,
  errorHandler,
  validateMac,
  checkRateLimit,
  recordFailedAttempt,
  clearFailedAttempts
};