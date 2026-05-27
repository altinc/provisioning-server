require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');

const logger = require('./utils/logger');
const { clientRateLimiter, adminRateLimiter } = require('./utils/rateLimiter');
const { requestLogger, errorHandler, securityLogger } = require('./middleware');
const provisioningRoutes = require('./routes/provisioning');
const binaryRoutes = require('./routes/binaries');
const adminRoutes = require('./routes/admin');
const xmlAppsRoutes = require('./routes/xmlApps');
const xmlAppsYealinkRoutes = require('./routes/xmlAppsYealink');
const xmlProxyRoutes = require('./routes/xmlProxy');

const gwProxyRoutes = require('./routes/gwProxy');


const redisService = require('./services/redis');


const app = express();
const PORT = process.env.PORT || 3000;

// ENHANCED: Better trust proxy configuration for Cloudflare + Nginx
// This must be set BEFORE any middleware that uses req.ip
if (process.env.NODE_ENV === 'production') {
  // For production with Cloudflare + Nginx, we need to trust 2 proxies:
  // 1. Cloudflare 2. Nginx
  app.set('trust proxy', 2);
  logger.info('Trust proxy set to 2 (Cloudflare + Nginx)');
} else {
  // In development, trust all proxies for flexibility
  app.set('trust proxy', true);
  logger.info('Trust proxy set to true (development)');
}

// ENHANCED: Custom IP extraction middleware for Cloudflare + Nginx
const extractRealIP = (req, res, next) => {
  // Store original IP for debugging
  const originalIP = req.ip;
  const originalIPs = req.ips;
  
  // Priority order for IP extraction:
  // 1. CF-Connecting-IP (Cloudflare's original visitor IP)
  // 2. X-Real-IP (Nginx real IP)
  // 3. X-Forwarded-For (first IP in chain)
  // 4. req.ip (Express extracted IP)
  
  let realIP = null;
  
  // Check Cloudflare's connecting IP header (highest priority)
  const cfConnectingIP = req.get('CF-Connecting-IP');
  if (cfConnectingIP && isValidIP(cfConnectingIP)) {
    realIP = cfConnectingIP;
    req.ipSource = 'CF-Connecting-IP';
  }
  
  // Check X-Real-IP (Nginx)
  if (!realIP) {
    const xRealIP = req.get('X-Real-IP');
    if (xRealIP && isValidIP(xRealIP)) {
      realIP = xRealIP;
      req.ipSource = 'X-Real-IP';
    }
  }
  
  // Check X-Forwarded-For (first valid IP)
  if (!realIP) {
    const xForwardedFor = req.get('X-Forwarded-For');
    if (xForwardedFor) {
      const ips = xForwardedFor.split(',').map(ip => ip.trim());
      for (const ip of ips) {
        if (isValidIP(ip) && !isPrivateIP(ip)) {
          realIP = ip;
          req.ipSource = 'X-Forwarded-For';
          break;
        }
      }
    }
  }
  
  // Fall back to Express extracted IP
  if (!realIP && originalIP && isValidIP(originalIP)) {
    realIP = originalIP;
    req.ipSource = 'req.ip';
  }
  
  // Final fallback
  if (!realIP) {
    realIP = 'unknown';
    req.ipSource = 'fallback';
  }
  
  // Override req.ip with the real IP
  req.ip = realIP;
  
  // Store debug info
  req.ipDebug = {
    extractedIP: realIP,
    source: req.ipSource,
    originalIP: originalIP,
    originalIPs: originalIPs,
    headers: {
      'CF-Connecting-IP': req.get('CF-Connecting-IP'),
      'X-Real-IP': req.get('X-Real-IP'),
      'X-Forwarded-For': req.get('X-Forwarded-For'),
      'X-Forwarded-Proto': req.get('X-Forwarded-Proto')
    }
  };
  
  // Log IP extraction details for debugging (only in development or when debug logging is enabled)
  if (process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug') {
    logger.debug('IP extraction details', {
      url: req.url,
      extractedIP: realIP,
      source: req.ipSource,
      originalIP: originalIP,
      headers: req.ipDebug.headers
    });
  }
  
  next();
};

// Helper function to validate IP addresses
function isValidIP(ip) {
  if (!ip || typeof ip !== 'string') return false;
  
  // IPv4 regex
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  // IPv6 regex (simplified)
  const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
  
  if (ipv4Regex.test(ip)) {
    // Validate IPv4 ranges
    const parts = ip.split('.');
    return parts.every(part => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255;
    });
  }
  
  // Basic IPv6 validation
  return ipv6Regex.test(ip) || ip.includes('::');
}

// Helper function to check if IP is private/internal
function isPrivateIP(ip) {
  if (!ip || typeof ip !== 'string') return true;
  
  // Private IPv4 ranges
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^127\./,
    /^169\.254\./,
    /^::1$/,
    /^fc00:/,
    /^fe80:/
  ];
  
  return privateRanges.some(range => range.test(ip));
}

// Apply IP extraction BEFORE any other middleware
app.use(extractRealIP);

// FIXED: HTTPS enforcement middleware
const enforceHTTPS = (req, res, next) => {
  // Only enforce HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    // Check both forwarded protocol and forwarded SSL header (for Cloudflare)
    const forwarded = req.get('X-Forwarded-Proto');
    const cloudflareSSL = req.get('CF-Visitor');
    
    let isHTTPS = false;
    
    // Check X-Forwarded-Proto header
    if (forwarded === 'https') {
      isHTTPS = true;
    }
    
    // Check Cloudflare's CF-Visitor header
    if (cloudflareSSL) {
      try {
        const cfVisitor = JSON.parse(cloudflareSSL);
        if (cfVisitor.scheme === 'https') {
          isHTTPS = true;
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
    
    // Check if request is already secure
    if (req.secure) {
      isHTTPS = true;
    }
    
    if (!isHTTPS) {
      logger.warn('HTTP request redirected to HTTPS', { 
        ip: req.ip, 
        url: req.url,
        userAgent: req.get('User-Agent'),
        ipSource: req.ipSource,
        headers: {
          'X-Forwarded-Proto': req.get('X-Forwarded-Proto'),
          'CF-Visitor': req.get('CF-Visitor')
        }
      });
      return res.redirect(301, `https://${req.get('host')}${req.url}`);
    }
  }
  next();
};

// Apply HTTPS enforcement
app.use(enforceHTTPS);

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || process.env.AUTH_SECRET || 'your-session-secret-here',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  name: 'voip-admin-session' // Custom session name
}));

// Enhanced security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));

// Apply rate limiting
app.use(clientRateLimiter);

// Apply stricter rate limiting for admin endpoints
app.use('/admin', adminRateLimiter);

// Serve static files from public directory
app.use(express.static('public'));

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configure Nunjucks with security considerations
const env = nunjucks.configure('templates', {
  autoescape: true,
  express: app,
  // Watch templates for live reload, except under test where the chokidar
  // handle would keep the Jest process alive. Prod/dev behaviour is unchanged.
  watch: process.env.NODE_ENV !== 'test',
  trimBlocks: false,   // Change to false
  lstripBlocks: false,  // Change to false
  preserveLinebreaks: true,  // Add this
  noCache: process.env.NODE_ENV === 'development',
  tags: {
    commentStart: '<!--',  // Treat XML comments as Nunjucks comments
    commentEnd: '-->'
  }
});

// Add custom filters for template compatibility
env.addFilter('upper', (str) => str ? str.toString().toUpperCase() : '');
env.addFilter('lower', (str) => str ? str.toString().toLowerCase() : '');
env.addFilter('truncate', (str, length = 50) => {
  if (!str) return '';
  return str.length > length ? str.substring(0, length) + '...' : str;
});

// Add helper filters for admin templates
env.addFilter('formatTimestamp', (timestamp) => {
  if (!timestamp) return 'Never';
  return new Date(timestamp).toLocaleString();
});

env.addFilter('timeAgo', (timestamp) => {
  if (!timestamp) return 'Never';
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
});

env.addFilter('formatUptime', (seconds) => {
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
});

env.addFilter('formatBytes', (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
});

env.addFilter('sum', (arr, attribute) => {
  if (!arr || !Array.isArray(arr)) return 0;
  return arr.reduce((sum, item) => {
    const value = attribute ? (item[attribute] || 0) : (item || 0);
    return sum + (typeof value === 'number' ? value : 0);
  }, 0);
});

env.addFilter('selectattr', (arr, attr, op = '==', value) => {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.filter(item => {
    const itemValue = item[attr];
    switch (op) {
      case '>': return itemValue > value;
      case '<': return itemValue < value;
      case '>=': return itemValue >= value;
      case '<=': return itemValue <= value;
      case '!=': return itemValue != value;
      case '==':
      default: return itemValue == value;
    }
  });
});

env.addFilter('tojson', (obj) => {
  return JSON.stringify(obj);
});

env.addFilter('dump', (obj) => {
  return JSON.stringify(obj, null, 2);
});

env.addFilter('test_recent', (timestamp, milliseconds) => {
  if (!timestamp) return false;
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  return (now - then) <= milliseconds;
});

// CRITICAL: Apply logging middleware AFTER IP extraction but BEFORE routes
app.use(requestLogger);
app.use(securityLogger);

// Routes
app.use('/', provisioningRoutes);
app.use('/', binaryRoutes); // Binary file serving routes
app.use('/admin', adminRoutes); // admin web ui
app.use('/xmlApps', xmlAppsRoutes); // xml apps
app.use('/xmlAppsYealink', xmlAppsYealinkRoutes);
app.use('/xml', xmlProxyRoutes);
app.use('/groundwire', gwProxyRoutes);

// Health check endpoint with enhanced IP debugging
app.get('/health', (req, res) => {
  const healthData = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
    redis: redisService.getStatus(),
    proxy: {
      trustProxy: app.get('trust proxy'),
      ip: req.ip,
      ips: req.ips,
      ipSource: req.ipSource,
      protocol: req.protocol,
      secure: req.secure,
      headers: {
        'X-Forwarded-Proto': req.get('X-Forwarded-Proto'),
        'X-Forwarded-For': req.get('X-Forwarded-For'),
        'X-Real-IP': req.get('X-Real-IP'),
        'CF-Connecting-IP': req.get('CF-Connecting-IP'),
        'CF-Visitor': req.get('CF-Visitor')
      }
    }
  };
  
  // Include more details in development
  if (process.env.NODE_ENV === 'development') {
    healthData.memory = process.memoryUsage();
    healthData.pid = process.pid;
    healthData.ipDebug = req.ipDebug; // Include full IP debug info
  }
  
  res.json(healthData);
});

// IP debugging endpoint (helpful for troubleshooting)
app.get('/debug/ip', (req, res) => {
  res.json({
    extractedIP: req.ip,
    ipSource: req.ipSource,
    ipDebug: req.ipDebug,
    timestamp: new Date().toISOString()
  });
});

// Security headers endpoint for testing
app.get('/security-test', (req, res) => {
  res.json({
    https_enforced: req.secure || req.header('x-forwarded-proto') === 'https',
    headers_present: {
      hsts: !!res.get('Strict-Transport-Security'),
      csp: !!res.get('Content-Security-Policy'),
      xss_protection: !!res.get('X-XSS-Protection'),
      content_type_options: !!res.get('X-Content-Type-Options')
    },
    ip_info: {
      ip: req.ip,
      ips: req.ips,
      ipSource: req.ipSource,
      protocol: req.protocol,
      secure: req.secure,
      headers: {
        'X-Forwarded-Proto': req.get('X-Forwarded-Proto'),
        'X-Forwarded-For': req.get('X-Forwarded-For'),
        'X-Real-IP': req.get('X-Real-IP'),
        'CF-Connecting-IP': req.get('CF-Connecting-IP')
      }
    },
    ipDebug: req.ipDebug,
    timestamp: new Date().toISOString()
  });
});

// Enhanced error handling
app.use(errorHandler);

// 404 handler with logging (now with proper IP)
app.use((req, res) => {
  logger.warn('404 Not Found', {
    ip: req.ip,
    ipSource: req.ipSource,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent')
  });
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown with cleanup
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);
  
  try {
    await redisService.disconnect();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error('Error closing Redis connection:', error);
  }
  
  process.exit(0);
};

// Start the server and attach process-level handlers only when this file is run
// directly (node app.js / npm start). When the module is required (e.g. by
// supertest in the test suite) it is exported without binding a port or
// registering signal/exception handlers.
function startServer() {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });

  // Start server
  return app.listen(PORT, () => {
    logger.info(`Provisioning server started on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Trust proxy: ${app.get('trust proxy')}`);
    logger.info(`HTTPS enforcement: ${process.env.NODE_ENV === 'production' ? 'enabled' : 'disabled (dev mode)'}`);
    logger.info(`Admin UI available at: /admin/dashboard`);
    logger.info(`IP debugging available at: /debug/ip`);

    // Warn about debug configurations
    if (process.env.DISABLE_TOKEN_AUTH === 'true') {
      logger.error('🚨 DEBUG MODE: Token authentication is DISABLED! This should only be used for debugging/onboarding.');
      logger.error('🚨 Set DISABLE_TOKEN_AUTH=false or remove the variable to re-enable security.');
    }

    // Warn about insecure configurations
    if (process.env.AUTH_SECRET === 'your-secret-here') {
      logger.error('⚠️  CRITICAL: AUTH_SECRET is using default value! Change immediately!');
    }

    if (process.env.NODE_ENV === 'production' && process.env.ADMIN_PASSWORD === 'Jan2019!') {
      logger.error('⚠️  CRITICAL: Default admin password detected in production!');
    }
  });
}

if (require.main === module) {
  startServer();
}

module.exports = app;
