// app/services/redis.js - Fixed Version for Redis v4+
const { createClient } = require('redis');
const logger = require('../utils/logger');

class RedisService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // Start with 1 second
  }

  async connect() {
    try {
      this.client = createClient({
        url: process.env.REDIS_URL || 'redis://redis:6379',
        retry_strategy: (options) => {
          if (options.error && options.error.code === 'ECONNREFUSED') {
            logger.error('Redis connection refused');
          }
          if (options.total_retry_time > 1000 * 60 * 60) {
            // End reconnecting after 1 hour
            return new Error('Retry time exhausted');
          }
          if (options.attempt > this.maxReconnectAttempts) {
            return new Error('Max reconnection attempts reached');
          }
          // Exponential backoff
          return Math.min(options.attempt * 100, 3000);
        }
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis client connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });

      this.client.on('ready', () => {
        logger.info('Redis client ready');
        this.isConnected = true;
      });

      this.client.on('end', () => {
        logger.warn('Redis client connection ended');
        this.isConnected = false;
      });

      await this.client.connect();
      return this.client;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      this.isConnected = false;
      throw error;
    }
  }

  async get(key) {
    if (!this.isConnected) {
      logger.warn('Redis not connected, attempting to reconnect');
      try {
        await this.connect();
      } catch (error) {
        logger.error('Redis reconnection failed:', error);
        return null;
      }
    }

    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      this.isConnected = false;
      return null;
    }
  }

  async set(key, value) {
    if (!this.isConnected) {
      logger.warn('Redis not connected for SET operation');
      return false;
    }

    try {
      await this.client.set(key, value);
      return true;
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  async setex(key, seconds, value) {
    if (!this.isConnected) {
      logger.warn('Redis not connected for SETEX operation');
      return false;
    }

    try {
      await this.client.setEx(key, seconds, value);
      return true;
    } catch (error) {
      logger.error(`Redis SETEX error for key ${key}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  async del(key) {
    if (!this.isConnected) {
      logger.warn('Redis not connected for DEL operation');
      return false;
    }

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis DEL error for key ${key}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  async exists(key) {
    if (!this.isConnected) {
      return false;
    }

    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Redis EXISTS error for key ${key}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  async flushAll() {
    if (!this.isConnected) {
      logger.warn('Redis not connected for FLUSHALL operation');
      return false;
    }

    try {
      await this.client.flushAll();
      logger.info('Redis cache cleared');
      return true;
    } catch (error) {
      logger.error('Redis FLUSHALL error:', error);
      this.isConnected = false;
      return false;
    }
  }

  // ==================== FIXED DEVICE STATISTICS METHODS ====================

  /**
   * Update device statistics with proper error handling and atomic operations
   * FIXED: Updated for Redis v4+ result format
   * @param {string} mac - Device MAC address
   * @param {Object} stats - Statistics to update
   * @param {string} stats.lastSeen - ISO timestamp
   * @param {string} stats.lastIP - IP address
   * @param {string} stats.lastUserAgent - User agent string
   * @param {number} stats.statusCode - HTTP status code
   * @returns {boolean} Success status
   */
  async updateDeviceStats(mac, stats) {
    if (!this.isConnected) {
      logger.warn('Redis not connected for device stats update');
      return false;
    }

    try {
      const statsKey = `device:stats:${mac}`;
      
      // Use multi/exec for atomic operations
      const multi = this.client.multi();
      
      // Update basic stats
      multi.hSet(statsKey, {
        lastSeen: stats.lastSeen,
        lastIP: stats.lastIP,
        lastUserAgent: stats.lastUserAgent
      });
      
      // Increment counters
      multi.hIncrBy(statsKey, 'totalRequests', 1);
      
      if (stats.statusCode >= 200 && stats.statusCode < 400) {
        multi.hIncrBy(statsKey, 'successfulRequests', 1);
      } else if (stats.statusCode >= 400) {
        multi.hIncrBy(statsKey, 'failedRequests', 1);
      }
      
      // Set TTL (keep stats for 90 days)
      multi.expire(statsKey, 90 * 24 * 60 * 60);
      
      const results = await multi.exec();
      
      // FIXED: In Redis v4+, check for Error instances instead of result.error
      const failed = results.some(result => result instanceof Error);
      if (failed) {
        logger.warn(`Some device stats operations failed for ${mac}:`, results);
        return false;
      }
      
      logger.debug(`Updated device stats for ${mac}:`, {
        statusCode: stats.statusCode,
        operations: results.length
      });
      
      return true;
    } catch (error) {
      logger.error(`Error updating device stats for ${mac}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Scan for all device statistics keys in Redis
   * @returns {Array} Array of device:stats:* keys
   */
  async scanDeviceStatKeys() {
    if (!this.isConnected) {
      logger.warn('Redis not connected for SCAN operation');
      return [];
    }

    try {
      const keys = [];
      let cursor = 0;
      
      do {
        const result = await this.client.scan(cursor, {
          MATCH: 'device:stats:*',
          COUNT: 1000
        });
        cursor = result.cursor;
        keys.push(...result.keys);
        logger.debug(`SCAN iteration: cursor=${cursor}, found ${result.keys.length} keys`);
      } while (cursor !== 0);
      
      logger.info(`Scanned ${keys.length} device stat keys from Redis`);
      return keys;
    } catch (error) {
      logger.error('Redis SCAN error for device stats:', error);
      this.isConnected = false;
      return [];
    }
  }

  /**
   * Bulk fetch device statistics using Redis pipeline with proper error handling
   * FIXED: Updated for Redis v4+ result format where multi().exec() returns results directly
   * @param {Array} keys - Array of Redis keys to fetch
   * @returns {Array} Array of device statistics objects
   */
  async bulkGetDeviceStats(keys) {
    if (!this.isConnected || keys.length === 0) {
      logger.warn(`bulkGetDeviceStats: isConnected=${this.isConnected}, keys.length=${keys.length}`);
      return [];
    }

    try {
      logger.debug(`Starting bulk fetch for ${keys.length} keys`);
      
      // Use multi() for bulk operations
      const multi = this.client.multi();
      
      keys.forEach(key => {
        multi.hGetAll(key);
      });
      
      const results = await multi.exec();
      logger.debug(`Multi returned ${results.length} results`);
      
      const devices = [];
      
      // FIXED: In Redis v4+, multi().exec() returns results directly, not as {error, result} objects
      results.forEach((data, index) => {
        const key = keys[index];
        
        logger.debug(`Processing result ${index}: key=${key}, dataType=${typeof data}, hasData=${!!data}, dataKeys=${data && typeof data === 'object' ? Object.keys(data).length : 'N/A'}`);
        
        // Check if we have valid hash data
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          const mac = key.replace('device:stats:', '');
          
          const deviceData = {
            mac: mac,
            lastSeen: data.lastSeen || null,
            lastIP: data.lastIP || 'Unknown',
            lastUserAgent: data.lastUserAgent || 'Unknown',
            totalRequests: parseInt(data.totalRequests || 0),
            successfulRequests: parseInt(data.successfulRequests || 0),
            failedRequests: parseInt(data.failedRequests || 0)
          };
          
          devices.push(deviceData);
          logger.debug(`Added device: ${mac} with ${deviceData.totalRequests} requests`);
        } else {
          logger.warn(`Failed to process key: ${key}, data:`, data);
        }
      });
      
      logger.info(`Bulk fetch completed: ${devices.length} devices processed from ${keys.length} keys`);
      return devices;
    } catch (error) {
      logger.error('Redis bulk get device stats error:', error);
      this.isConnected = false;
      return [];
    }
  }

  /**
   * Get statistics for a single device
   * @param {string} mac - Device MAC address
   * @returns {Object|null} Device statistics object or null if not found
   */
  async getDeviceStats(mac) {
    if (!this.isConnected) {
      return null;
    }

    try {
      const stats = await this.client.hGetAll(`device:stats:${mac}`);
      
      if (Object.keys(stats).length === 0) {
        return null;
      }
      
      return {
        mac: mac,
        lastSeen: stats.lastSeen || null,
        lastIP: stats.lastIP || 'Unknown',
        lastUserAgent: stats.lastUserAgent || 'Unknown',
        totalRequests: parseInt(stats.totalRequests || 0),
        successfulRequests: parseInt(stats.successfulRequests || 0),
        failedRequests: parseInt(stats.failedRequests || 0)
      };
    } catch (error) {
      logger.error(`Redis get device stats error for ${mac}:`, error);
      this.isConnected = false;
      return null;
    }
  }

  /**
   * Get all device statistics efficiently
   * @returns {Array} Array of all device statistics
   */
  async getAllDeviceStats() {
    try {
      logger.debug('Getting all device stats...');
      const keys = await this.scanDeviceStatKeys();
      logger.debug(`Found ${keys.length} device stat keys`);
      
      if (keys.length === 0) {
        logger.warn('No device stat keys found in Redis');
        return [];
      }
      
      const devices = await this.bulkGetDeviceStats(keys);
      logger.debug(`Bulk fetch returned ${devices.length} devices`);
      
      return devices;
    } catch (error) {
      logger.error('Error getting all device stats:', error);
      return [];
    }
  }

  /**
   * Clear device statistics for a specific MAC address
   * @param {string} mac - Device MAC address
   * @returns {boolean} Success status
   */
  async clearDeviceStats(mac) {
    if (!this.isConnected) {
      return false;
    }

    try {
      await this.client.del(`device:stats:${mac}`);
      logger.info(`Cleared device stats for: ${mac}`);
      return true;
    } catch (error) {
      logger.error(`Error clearing device stats for ${mac}:`, error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Get device statistics summary (counts, etc.)
   * @returns {Object} Summary statistics
   */
  async getDeviceStatsSummary() {
    try {
      const devices = await this.getAllDeviceStats();
      
      const summary = {
        totalDevices: devices.length,
        totalRequests: devices.reduce((sum, device) => sum + device.totalRequests, 0),
        totalSuccessful: devices.reduce((sum, device) => sum + device.successfulRequests, 0),
        totalFailed: devices.reduce((sum, device) => sum + device.failedRequests, 0),
        activeToday: 0, // Devices seen in last 24 hours
        activeWeek: 0   // Devices seen in last 7 days
      };
      
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      devices.forEach(device => {
        if (device.lastSeen) {
          const lastSeen = new Date(device.lastSeen);
          if (lastSeen > oneDayAgo) {
            summary.activeToday++;
          }
          if (lastSeen > oneWeekAgo) {
            summary.activeWeek++;
          }
        }
      });
      
      return summary;
    } catch (error) {
      logger.error('Error getting device stats summary:', error);
      return {
        totalDevices: 0,
        totalRequests: 0,
        totalSuccessful: 0,
        totalFailed: 0,
        activeToday: 0,
        activeWeek: 0
      };
    }
  }

  // ==================== END DEVICE STATISTICS METHODS ====================

  async disconnect() {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('Redis client disconnected');
      } catch (error) {
        logger.error('Error disconnecting Redis client:', error);
      }
    }
    this.isConnected = false;
  }

  getStatus() {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

const redisService = new RedisService();

redisService.connect().catch(error => {
  logger.error('Initial Redis connection failed:', error);
});

module.exports = redisService;
