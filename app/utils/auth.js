const crypto = require('crypto');
const logger = require('./logger');

class AuthService {
  constructor() {
    this.secret = process.env.AUTH_SECRET || 'your-secret-here';
    this.algorithm = 'sha256';
    this.tokenLength = 16; // Length of generated tokens
    this.provisioningInterval = parseInt(process.env.PROVISIONING_INTERVAL) || 876581; // ~10.14 days in seconds 
  }

  /**
   * Generate a salted hash for a MAC address
   * @param {string} mac - The MAC address
   * @param {number} timestamp - Unix timestamp (optional, defaults to current time)
   * @returns {string} The generated hash
   */
  generateHash(mac, timestamp = null) {
    const currentInterval = timestamp ? 
      Math.floor(timestamp / this.provisioningInterval) : 
      Math.floor(Date.now() / 1000 / this.provisioningInterval);
    
    const message = `${mac}:${currentInterval}`;
    
    const hmac = crypto.createHmac(this.algorithm, this.secret);
    hmac.update(message);
    const hash = hmac.digest('hex');
    
    return hash.substring(0, this.tokenLength);
  }

  /**
   * Generate authentication token for a MAC address
   * @param {string} mac - The MAC address
   * @returns {object} Object containing current and next valid tokens
   */
  generateAuthToken(mac) {
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    
    return {
      current: this.generateHash(normalizedMac, now),
      next: this.generateHash(normalizedMac, now + this.provisioningInterval)
    };
  }

  /**
   * Validate an authentication token for a MAC address
   * @param {string} mac - The MAC address
   * @param {string} providedToken - The token to validate
   * @returns {boolean} True if token is valid
   */
  validateAuthToken(mac, providedToken) {
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    
    // Check current interval
    const currentToken = this.generateHash(normalizedMac, now);
    if (providedToken === currentToken) {
      logger.debug(`Valid token for current interval: ${normalizedMac}`);
      return true;
    }
    
    // Check previous interval (for clock skew/overlap)
    const previousToken = this.generateHash(normalizedMac, now - this.provisioningInterval);
    if (providedToken === previousToken) {
      logger.debug(`Valid token for previous interval: ${normalizedMac}`);
      return true;
    }
    
    // Check next interval (for clock skew)
    const nextToken = this.generateHash(normalizedMac, now + this.provisioningInterval);
    if (providedToken === nextToken) {
      logger.debug(`Valid token for next interval: ${normalizedMac}`);
      return true;
    }
    
    logger.warn(`Invalid token provided for ${normalizedMac}`, {
      provided: providedToken,
      expected: {
        current: currentToken,
        previous: previousToken,
        next: nextToken
      }
    });
    
    return false;
  }

  /**
   * Generate a provisioning URL with authentication token
   * @param {string} mac - The MAC address
   * @param {string} endpoint - The endpoint path (e.g., 'config', 'boot', 'system')
   * @param {string} baseUrl - Base URL of the provisioning server
   * @returns {string} Complete URL with auth token
   */
  generateProvisioningUrl(mac, endpoint, baseUrl = process.env.PROVISION_BASE_URL || 'https://pro.altinc.ca/odoo') {
    const normalizedMac = mac.replace(/[:-]/g, '').toLowerCase();
    const tokens = this.generateAuthToken(normalizedMac);
    
    return `${baseUrl}/${normalizedMac}.${endpoint}?token=${tokens.current}`;
  }

  /**
   * Create a rotating key service compatible with the Python implementation
   * This maintains compatibility with the existing groundwire-config.py
   */
  createRotatingKeyService() {
    return {
      generateKey: (username, timestamp) => {
        const currentInterval = Math.floor(timestamp / this.provisioningInterval);
        const message = `${username}:${currentInterval}`;
        
        const hmac = crypto.createHmac(this.algorithm, this.secret);
        hmac.update(message);
        return hmac.digest('hex').substring(0, this.tokenLength);
      },
      
      getCurrentAndNextKeys: (username) => {
        const now = Math.floor(Date.now() / 1000);
        return {
          current: this.createRotatingKeyService().generateKey(username, now),
          next: this.createRotatingKeyService().generateKey(username, now + this.provisioningInterval)
        };
      },
      
      validateKey: (username, providedKey) => {
        const now = Math.floor(Date.now() / 1000);
        const service = this.createRotatingKeyService();
        
        // Check current, previous, and next intervals
        const intervals = [now, now - this.provisioningInterval, now + this.provisioningInterval];
        
        for (const interval of intervals) {
          if (providedKey === service.generateKey(username, interval)) {
            return true;
          }
        }
        
        return false;
      }
    };
  }

  /**
   * Hash a password using SHA-256 (for compatibility with existing system)
   * @param {string} password - The password to hash
   * @param {string} salt - Optional salt
   * @returns {string} Hashed password
   */
  hashPassword(password, salt = '') {
    const hash = crypto.createHash('sha256');
    hash.update(salt + password);
    return hash.digest('hex');
  }

  /**
   * Generate a random salt
   * @param {number} length - Length of the salt
   * @returns {string} Random salt
   */
  generateSalt(length = 16) {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Validate HTTP Basic Auth credentials (for admin endpoints)
   * @param {string} username - Username
   * @param {string} password - Password
   * @returns {boolean} True if credentials are valid
   */
  validateBasicAuth(username, password) {
    const validUsername = process.env.ADMIN_USERNAME || 'altinc';
    const validPassword = process.env.ADMIN_PASSWORD || 'Jan2019!';
    
    return username === validUsername && password === validPassword;
  }

  /**
   * Extract Basic Auth credentials from Authorization header
   * @param {string} authHeader - The Authorization header value
   * @returns {object|null} Object with username and password, or null if invalid
   */
  parseBasicAuth(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return null;
    }
    
    try {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
      const [username, password] = credentials.split(':');
      return { username, password };
    } catch (error) {
      logger.warn('Failed to parse Basic Auth header:', error);
      return null;
    }
  }
}

const authService = new AuthService();

module.exports = {
  generateAuthToken: (mac) => authService.generateAuthToken(mac),
  validateAuthToken: (mac, token) => authService.validateAuthToken(mac, token),
  generateProvisioningUrl: (mac, endpoint, baseUrl) => authService.generateProvisioningUrl(mac, endpoint, baseUrl),
  createRotatingKeyService: () => authService.createRotatingKeyService(),
  hashPassword: (password, salt) => authService.hashPassword(password, salt),
  generateSalt: (length) => authService.generateSalt(length),
  validateBasicAuth: (username, password) => authService.validateBasicAuth(username, password),
  parseBasicAuth: (authHeader) => authService.parseBasicAuth(authHeader)
};
