const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { param, query, validationResult } = require('express-validator');
const router = express.Router();

const { parseBasicAuth, validateBasicAuth, generateAuthToken } = require('../utils/auth');
const logger = require('../utils/logger');
const redisService = require('../services/redis');
const odooService = require('../services/odoo');
const { validateMac } = require('../middleware');

// Session-based auth middleware for admin portal
const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.authenticated) {
    // Save the URL they were trying to access
    if (!req.path.startsWith('/login') && req.method === 'GET') {
      req.session.returnTo = req.originalUrl;
    }
    
    // For API endpoints, return JSON error
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // For web pages, redirect to login
    return res.redirect('/admin/login');
  }
  next();
};

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Invalid input parameters',
      details: errors.array()
    });
  }
  next();
};

// Helper function to read log files
async function readLogFile(filename, lines = 1000) {
  try {
    const logPath = path.join(process.cwd(), 'logs', filename);
    
    // Check if file exists first
    try {
      await fs.access(logPath);
    } catch (accessError) {
      logger.info(`Log file ${filename} does not exist yet, returning empty array`);
      return [];
    }
    
    const data = await fs.readFile(logPath, 'utf8');
    const logLines = data.split('\n').filter(line => line.trim());
    
    // Return last N lines
    return logLines.slice(-lines);
  } catch (error) {
    logger.warn(`Could not read log file ${filename}:`, error.message);
    return [];
  }
}

// Helper function to parse log entries
function parseLogEntry(line) {
  try {
    const parsed = JSON.parse(line);
    
    let mac = null;
    
    // Try to extract MAC from URL (e.g., "/odoo/cfg44DBD2231CD9.xml" or "/odoo/44DBD2231CD9.xml")
    if (parsed.message && parsed.message.includes('GET ')) {
      const urlMatch = parsed.message.match(/GET\s+\/[^\/]*\/(?:cfg)?([0-9a-fA-F]{12})\./i);
      if (urlMatch) {
        mac = urlMatch[1].toLowerCase();
      }
    }
    
    // Try to extract MAC from message text (e.g., "Token auth bypassed for device: 44dbd2231cd9")
    if (!mac && parsed.message) {
      const messageMatch = parsed.message.match(/device:\s*([0-9a-fA-F]{12})/i);
      if (messageMatch) {
        mac = messageMatch[1].toLowerCase();
      }
    }
    
    // Try to extract MAC from any 12-character hex string in the message
    if (!mac && parsed.message) {
      const hexMatch = parsed.message.match(/[0-9a-fA-F]{12}/g);
      if (hexMatch) {
        mac = hexMatch[0].toLowerCase();
      }
    }
    
    return {
      timestamp: parsed.timestamp,
      level: parsed.level,
      message: parsed.message,
      meta: parsed.meta || {},
      ip: parsed.ip,
      mac: mac,
      userAgent: parsed.userAgent,
      statusCode: parsed.statusCode,
      duration: parsed.duration,
      url: parsed.url,
      method: parsed.method
    };
  } catch (error) {
    // Fallback for non-JSON log lines
    return {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: line,
      meta: {},
      raw: true
    };
  }
}

// Helper function to get device provisioning history from logs
async function getDeviceHistory(mac) {
  try {
    const logs = await readLogFile('combined.log', 5000);
    const deviceLogs = logs
      .map(parseLogEntry)
      .filter(entry => 
        entry.mac === mac || 
        (entry.message && entry.message.includes(mac)) ||
        (entry.url && entry.url.includes(mac))
      )
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 100);
    
    return deviceLogs;
  } catch (error) {
    logger.error('Error getting device history:', error);
    return [];
  }
}

// ==================== AUTH ROUTES (NO AUTH REQUIRED) ====================

// Login page
router.get('/login', (req, res) => {
  // If already logged in, redirect to dashboard
  if (req.session && req.session.authenticated) {
    return res.redirect('/admin/dashboard');
  }
  
  res.render('admin/login.html', {
    error: req.query.error
  });
});

// Login handler
router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const { username, password } = req.body;
  
  if (validateBasicAuth(username, password)) {
    // Set session
    req.session.authenticated = true;
    req.session.username = username;
    
    logger.info('Admin login successful', {
      username,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    // Redirect to originally requested page or dashboard
    const returnTo = req.session.returnTo || '/admin/dashboard';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } else {
    logger.warn('Failed admin login attempt', {
      username: username || 'not-provided',
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    res.redirect('/admin/login?error=' + encodeURIComponent('Invalid username or password'));
  }
});

// Logout handler
router.get('/logout', (req, res) => {
  const username = req.session ? req.session.username : 'unknown';
  
  req.session.destroy((err) => {
    if (err) {
      logger.error('Error destroying session:', err);
    }
    
    logger.info('Admin logout', {
      username,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    res.redirect('/admin/login');
  });
});

// ==================== PROTECTED ROUTES (REQUIRE AUTH) ====================

// Apply requireAuth to all routes below this point
router.use(requireAuth);

// ==================== WEB UI ROUTES ====================

// Admin Dashboard - Enhanced with Redis device stats
router.get('/dashboard', async (req, res) => {
  try {
    // Ensure logs directory exists
    const logsDir = path.join(process.cwd(), 'logs');
    try {
      await fs.access(logsDir);
    } catch {
      await fs.mkdir(logsDir, { recursive: true });
      logger.info('Created logs directory');
    }
    
    // Helper functions for formatting
    const formatUptime = (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      
      if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
      } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
      } else {
        return `${minutes}m`;
      }
    };
    
    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };
    
    const formatTimestamp = (timestamp) => {
      if (!timestamp) return 'Never';
      return new Date(timestamp).toLocaleString();
    };
    
    // Get system status
    const uptime = process.uptime();
    const memory = process.memoryUsage();
    const redisStatus = redisService.getStatus();
    
    // Get device statistics from Redis (much faster than parsing logs)
    logger.info('Getting device summary from Redis...');
    const deviceSummary = await redisService.getDeviceStatsSummary();
    logger.info('Device summary from Redis:', deviceSummary);
    
    // Get recent log entries for activity feed
    const recentLogs = await readLogFile('combined.log', 50);
    const recentErrors = await readLogFile('error.log', 20);
    
    // Parse logs for dashboard display
    const parsedLogs = recentLogs.map(parseLogEntry);
    const errorLogs = recentErrors.map(parseLogEntry);
    
    // Enhanced stats using Redis data
    const stats = {
      totalRequests: deviceSummary.totalRequests,
      successfulRequests: deviceSummary.totalSuccessful,
      failedRequests: deviceSummary.totalFailed,
      errorCount: errorLogs.length,
      uniqueDevices: deviceSummary.totalDevices,
      activeDevices: deviceSummary.activeToday,
      authFailures: parsedLogs.filter(log => 
        log.message && (
          log.message.includes('Authentication failed') ||
          log.message.includes('Invalid auth token')
        )
      ).length
    };
    
    // Format data for template
    const templateData = {
      title: 'VoIP Provisioning Admin Dashboard',
      uptime: formatUptime(Math.floor(uptime)),
      memory: {
        heapUsed: formatBytes(memory.heapUsed),
        heapTotal: formatBytes(memory.heapTotal),
        rss: formatBytes(memory.rss),
        heapUsedPercent: Math.round((memory.heapUsed / memory.heapTotal) * 100)
      },
      redisStatus,
      stats,
      recentLogs: parsedLogs.slice(0, 20).map(log => ({
        ...log,
        formattedTimestamp: formatTimestamp(log.timestamp)
      })),
      recentErrors: errorLogs.slice(0, 10).map(error => ({
        ...error,
        formattedTimestamp: formatTimestamp(error.timestamp)
      })),
      currentPath: req.path
    };
    
    res.render('admin/dashboard.html', templateData);
  } catch (error) {
    logger.error('Error loading admin dashboard:', error);
    res.status(500).send('Error loading dashboard');
  }
});

// File Manager Dashboard
router.get('/files/manager', (req, res) => {
  res.render('admin/file-manager.html', {
    title: 'File Manager'
  });
});

// Logs Viewer
router.get('/logs', async (req, res) => {
  const { 
    file = 'combined', 
    lines = 500, 
    level, 
    search, 
    mac,
    since 
  } = req.query;
  
  try {
    const filename = file === 'error' ? 'error.log' : 'combined.log';
    const logLines = await readLogFile(filename, parseInt(lines));
    let parsedLogs = logLines.map(parseLogEntry);
    
    // Apply filters
    if (level) {
      parsedLogs = parsedLogs.filter(log => log.level === level);
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      parsedLogs = parsedLogs.filter(log => 
        (log.message && log.message.toLowerCase().includes(searchLower)) ||
        (log.ip && log.ip.includes(search)) ||
        (log.mac && log.mac.toLowerCase().includes(searchLower)) ||
        (log.url && log.url.toLowerCase().includes(searchLower))
      );
    }
    
    if (mac) {
      const macNormalized = mac.replace(/[:-]/g, '').toLowerCase();
      parsedLogs = parsedLogs.filter(log => 
        (log.mac && log.mac === macNormalized) ||
        (log.url && log.url.includes(macNormalized))
      );
    }
    
    if (since) {
      const sinceDate = new Date(since);
      parsedLogs = parsedLogs.filter(log => 
        new Date(log.timestamp) >= sinceDate
      );
    }
    
    // Reverse to show newest first
    parsedLogs.reverse();
    
    res.render('admin/logs.html', {
      title: 'Log Viewer',
      logs: parsedLogs,
      filters: { file, lines, level, search, mac, since },
      totalLogs: parsedLogs.length
    });
  } catch (error) {
    logger.error('Error loading logs:', error);
    res.status(500).send('Error loading logs');
  }
});

// Device Management - NOW USING REDIS BULK OPERATIONS!
router.get('/devices', async (req, res) => {
  try {
    logger.info('Loading device list from Redis...');
    
    // Get all device statistics from Redis using efficient bulk operations
    const devices = await redisService.getAllDeviceStats();
    
    logger.info(`Redis returned ${devices.length} devices`);
    
    if (devices.length > 0) {
      logger.info('Sample device data:', devices[0]);
    }
    
    if (devices.length === 0) {
      logger.warn('No devices found in Redis, checking Redis connection and keys...');
      
      // Debug: Check Redis connection and scan for keys
      const redisStatus = redisService.getStatus();
      logger.info('Redis status:', redisStatus);
      
      if (redisStatus.connected) {
        const keys = await redisService.scanDeviceStatKeys();
        logger.info(`Found ${keys.length} device stat keys in Redis:`, keys.slice(0, 5));
      }
      
      return res.render('admin/devices.html', {
        title: 'Device Management',
        devices: [],
        totalDevices: 0
      });
    }
    
    // Sort by last seen (most recent first)
    devices.sort((a, b) => {
      const aTime = new Date(a.lastSeen || 0);
      const bTime = new Date(b.lastSeen || 0);
      return bTime - aTime;
    });
    
    logger.info(`Loaded device list with ${devices.length} devices from Redis`);
    
    res.render('admin/devices.html', {
      title: 'Device Management',
      devices,
      totalDevices: devices.length
    });
  } catch (error) {
    logger.error('Error loading devices:', error);
    res.status(500).send('Error loading devices');
  }
});

// Device Details - Combine Redis stats with Odoo data efficiently
router.get('/devices/:mac', [
  param('mac').matches(/^[0-9a-fA-F]{12}$/).withMessage('Invalid MAC address format'),
  handleValidationErrors
], async (req, res) => {
  const { mac } = req.params;
  const normalizedMac = mac.toLowerCase(); // Normalize to lowercase for Redis lookup
  
  try {
    logger.info(`Loading device details for MAC: ${mac} (normalized: ${normalizedMac})`);
    
    // Get device statistics from Redis (fast) - use normalized MAC
    const deviceStats = await redisService.getDeviceStats(normalizedMac);
    
    logger.info(`Redis stats for ${normalizedMac}:`, deviceStats);
    
    // Get full device data from Odoo (slower but comprehensive and cached) - use normalized MAC
    let deviceData = null;
    try {
      deviceData = await odooService.getDeviceData(normalizedMac);
      logger.info(`Odoo data found for ${normalizedMac}:`, !!deviceData);
    } catch (error) {
      logger.warn(`Could not fetch Odoo data for ${normalizedMac}:`, error.message);
    }
    
    // Get recent activity history from logs (limited for performance) - use normalized MAC
    const history = await getDeviceHistory(normalizedMac);
    logger.info(`Log history entries for ${normalizedMac}: ${history.length}`);
    
    // Use Redis stats if available, fallback to basic stats
    const stats = deviceStats ? {
      totalRequests: deviceStats.totalRequests,
      successfulRequests: deviceStats.successfulRequests,
      failedRequests: deviceStats.failedRequests,
      lastSeen: deviceStats.lastSeen,
      firstSeen: history.length > 0 ? history[history.length - 1].timestamp : null
    } : {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastSeen: deviceData?.device?.x_last_prov || null,
      firstSeen: null
    };
    
    logger.info(`Final stats for ${normalizedMac}:`, stats);
    
    res.render('admin/device-details.html', {
      title: `Device Details - ${mac}`,
      mac: mac, // Display original case
      deviceData,
      history: history.slice(0, 50), // Show last 50 entries
      stats
    });
  } catch (error) {
    logger.error(`Error loading device details for ${mac}:`, error);
    res.status(500).send('Error loading device details');
  }
});

// Troubleshooting Tools
router.get('/troubleshoot', (req, res) => {
  res.render('admin/troubleshoot.html', {
    title: 'Troubleshooting Tools'
  });
});

// Real-time logs endpoint (Server-Sent Events)
router.get('/logs/stream', (req, res) => {
  // Set up Server-Sent Events
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Log stream connected' })}\n\n`);
  
  // Set up log file watcher (simplified - in production, use proper file watching)
  const interval = setInterval(async () => {
    try {
      const recentLogs = await readLogFile('combined.log', 10);
      const parsedLogs = recentLogs.map(parseLogEntry);
      
      res.write(`data: ${JSON.stringify({ 
        type: 'logs', 
        logs: parsedLogs.slice(-5) // Send last 5 entries
      })}\n\n`);
    } catch (error) {
      logger.error('Error streaming logs:', error);
    }
  }, 5000); // Update every 5 seconds
  
  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
  });
});

// ==================== API ENDPOINTS ====================

// Generate auth token for a device
router.post('/api/token/:mac', [
  validateMac
], (req, res) => {
  try {
    const { mac } = req.params;
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    
    const tokens = generateAuthToken(normalizedMac);
    
    const response = {
      mac: normalizedMac,
      tokens: tokens,
      urls: {
        // Token in path format
        config: `${req.protocol}://${req.get('host')}/odoo/${tokens.current}/${normalizedMac}.xml`,
        boot: `${req.protocol}://${req.get('host')}/odoo/${tokens.current}/${normalizedMac}.boot`,
        system: `${req.protocol}://${req.get('host')}/odoo/${tokens.current}/${normalizedMac}.sys`,
        // Token in query format
        configWithQuery: `${req.protocol}://${req.get('host')}/odoo/${normalizedMac}.xml?token=${tokens.current}`
      },
      timestamp: new Date().toISOString()
    };
    
    res.json(response);
    
    logger.info(`Generated auth tokens for device: ${normalizedMac}`, { 
      requestedBy: req.ip,
      adminUser: req.session.username
    });
  } catch (error) {
    logger.error(`Error generating token for ${req.params.mac}:`, error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// Clear device cache
router.delete('/api/cache/:mac', [
  validateMac
], async (req, res) => {
  try {
    const { mac } = req.params;
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    
    await odooService.clearDeviceCache(normalizedMac);
    
    res.json({ 
      message: 'Cache cleared successfully',
      mac: normalizedMac,
      timestamp: new Date().toISOString()
    });
    
    logger.info(`Cleared cache for device: ${normalizedMac}`, { 
      requestedBy: req.ip,
      adminUser: req.session.username
    });
  } catch (error) {
    logger.error(`Error clearing cache for ${req.params.mac}:`, error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Get device info
router.get('/api/device/:mac', [
  validateMac
], async (req, res) => {
  try {
    const { mac } = req.params;
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    
    const deviceData = await odooService.getDeviceData(normalizedMac);
    
    if (!deviceData) {
      return res.status(404).json({ 
        error: 'Device not found',
        mac: normalizedMac,
        timestamp: new Date().toISOString()
      });
    }

    const response = {
      mac: normalizedMac,
      device: deviceData.device,
      site: deviceData.site,
      partners: deviceData.partners.map(p => ({
        id: p.id,
        firstname: p.firstname,
        extension: p.x_voip_ext,
        kazoo_enabled: p.x_kazoo_enabled
      })),
      organizations: deviceData.organizations.map(o => ({
        name: o.name,
        kazoo_enabled: o.x_kazoo_enabled,
        realm: o.x_kazoo_realm,
        pbx_ip: o.x_pbxip
      })),
      timestamp: new Date().toISOString()
    };

    res.json(response);
    
    logger.info(`Retrieved device info: ${normalizedMac}`, { 
      requestedBy: req.ip,
      adminUser: req.session.username
    });
  } catch (error) {
    logger.error(`Error retrieving device info for ${req.params.mac}:`, error);
    res.status(500).json({ error: 'Failed to retrieve device information' });
  }
});

// Clear all cache
router.delete('/api/cache', async (req, res) => {
  try {
    await redisService.flushAll();
    
    res.json({ 
      message: 'All cache cleared successfully',
      timestamp: new Date().toISOString()
    });
    
    logger.info('Flushed all cache', { 
      requestedBy: req.ip,
      adminUser: req.session.username
    });
  } catch (error) {
    logger.error('Error flushing cache:', error);
    res.status(500).json({ error: 'Failed to flush cache' });
  }
});

// Get system status
router.get('/api/status', async (req, res) => {
  try {
    const status = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      redis: redisService.getStatus(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0',
      security: {
        https_enforced: process.env.NODE_ENV === 'production',
        auth_secret_configured: process.env.AUTH_SECRET !== 'your-secret-here',
        admin_password_changed: process.env.ADMIN_PASSWORD !== 'Jan2019!'
      }
    };
    
    res.json(status);
  } catch (error) {
    logger.error('Error getting system status:', error);
    res.status(500).json({ error: 'Failed to get system status' });
  }
});

// Security audit
router.get('/api/security-audit', (req, res) => {
  const securityChecks = {
    timestamp: new Date().toISOString(),
    checks: {
      auth_secret_secure: {
        passed: process.env.AUTH_SECRET !== 'your-secret-here',
        message: process.env.AUTH_SECRET === 'your-secret-here' ? 'Default AUTH_SECRET detected' : 'AUTH_SECRET appears secure'
      },
      admin_password_secure: {
        passed: process.env.ADMIN_PASSWORD !== 'Jan2019!',
        message: process.env.ADMIN_PASSWORD === 'Jan2019!' ? 'Default admin password detected' : 'Admin password changed'
      },
      https_enforced: {
        passed: process.env.NODE_ENV === 'production',
        message: process.env.NODE_ENV === 'production' ? 'HTTPS enforcement enabled' : 'HTTPS enforcement disabled (dev mode)'
      },
      redis_configured: {
        passed: !!process.env.REDIS_URL,
        message: process.env.REDIS_URL ? 'Redis URL configured' : 'Redis URL not configured'
      }
    }
  };

  const allPassed = Object.values(securityChecks.checks).every(check => check.passed);
  securityChecks.overall_status = allPassed ? 'SECURE' : 'NEEDS_ATTENTION';

  res.json(securityChecks);
  
  logger.info('Security audit performed', {
    requestedBy: req.ip,
    overallStatus: securityChecks.overall_status,
    adminUser: req.session.username
  });
});

// Get logs as JSON
router.get('/api/logs', async (req, res) => {
  const { 
    file = 'combined', 
    lines = 100, 
    level, 
    search, 
    mac 
  } = req.query;
  
  try {
    const filename = file === 'error' ? 'error.log' : 'combined.log';
    const logLines = await readLogFile(filename, parseInt(lines));
    let parsedLogs = logLines.map(parseLogEntry);
    
    // Apply filters (same as above)
    if (level) {
      parsedLogs = parsedLogs.filter(log => log.level === level);
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      parsedLogs = parsedLogs.filter(log => 
        (log.message && log.message.toLowerCase().includes(searchLower)) ||
        (log.ip && log.ip.includes(search)) ||
        (log.mac && log.mac.toLowerCase().includes(searchLower))
      );
    }
    
    if (mac) {
      const macNormalized = mac.replace(/[:-]/g, '').toLowerCase();
      parsedLogs = parsedLogs.filter(log => 
        (log.mac && log.mac === macNormalized) ||
        (log.url && log.url.includes(macNormalized))
      );
    }
    
    res.json({
      logs: parsedLogs.reverse(),
      total: parsedLogs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting logs API:', error);
    res.status(500).json({ error: 'Error retrieving logs' });
  }
});

// Get system stats as JSON - Enhanced with Redis device data
router.get('/api/stats', async (req, res) => {
  try {
    // Get device summary from Redis
    const deviceSummary = await redisService.getDeviceStatsSummary();
    
    const stats = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      redis: redisService.getStatus(),
      requests: {
        total: deviceSummary.totalRequests,
        successful: deviceSummary.totalSuccessful,
        failed: deviceSummary.totalFailed
      },
      devices: {
        unique: deviceSummary.totalDevices,
        active_today: deviceSummary.activeToday,
        active_week: deviceSummary.activeWeek
      },
      timestamp: new Date().toISOString()
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('Error getting stats:', error);
    res.status(500).json({ error: 'Error retrieving statistics' });
  }
});

// ==================== TEST ENDPOINTS (DEV ONLY) ====================

if (process.env.NODE_ENV === 'development') {
  router.get('/api/test/:mac', [
    validateMac,
    handleValidationErrors
  ], async (req, res) => {
    try {
      const { mac } = req.params;
      const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
      
      const deviceData = await odooService.getDeviceData(normalizedMac);
      
      res.json({
        mac: normalizedMac,
        found: !!deviceData,
        data: deviceData,
        tokens: generateAuthToken(normalizedMac),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ 
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
}

module.exports = router;