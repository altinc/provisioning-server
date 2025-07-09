const rateLimit = require('express-rate-limit');
const logger = require('./logger');

// Configuration from environment variables
const config = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes default
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  adminMaxRequests: parseInt(process.env.ADMIN_RATE_LIMIT_MAX_REQUESTS) || 200
};

/**
 * Create a rate limiter with common configuration
 * @param {Object} options - Rate limiter options
 * @returns {Function} Express rate limit middleware
 */
const createRateLimiter = (options) => {
  return rateLimit({
    windowMs: config.windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    // Use the extracted real IP from our IP extraction middleware
    keyGenerator: (req) => {
      return req.ip || 'unknown';
    },
    // Skip rate limiting for health checks
    skip: (req) => {
      return req.url === '/health';
    },
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        ipSource: req.ipSource,
        userAgent: req.get('User-Agent'),
        url: req.url,
        path: req.path,
        method: req.method,
        type: options.type || 'unknown'
      });
      res.status(429).json({ 
        error: options.message || 'Too many requests from this IP',
        retryAfter: Math.ceil(config.windowMs / 1000)
      });
    },
    ...options
  });
};

/**
 * Client rate limiter - for general client requests
 * Limit: RATE_LIMIT_MAX_REQUESTS per RATE_LIMIT_WINDOW_MS
 */
const clientRateLimiter = createRateLimiter({
  max: config.maxRequests,
  message: 'Too many requests from this IP. Please try again later.',
  type: 'client'
});

/**
 * Admin rate limiter - for admin endpoints
 * Limit: ADMIN_RATE_LIMIT_MAX_REQUESTS per RATE_LIMIT_WINDOW_MS
 */
const adminRateLimiter = createRateLimiter({
  max: config.adminMaxRequests,
  message: 'Too many admin requests from this IP. Please try again later.',
  type: 'admin'
});

// Log rate limiter configuration on startup
logger.info('Rate limiter configured', {
  windowMs: config.windowMs,
  windowMinutes: config.windowMs / 60000,
  clientMaxRequests: config.maxRequests,
  adminMaxRequests: config.adminMaxRequests
});

module.exports = {
  clientRateLimiter,
  adminRateLimiter,
  config
};