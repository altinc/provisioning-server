/**
 * Fixed Kazoo service implementation with correct URL format and authentication
 * OPTIMIZED VERSION: Added caching, parallel fetching, and request deduplication
 */
const axios = require('axios');
const logger = require('../utils/logger');
const redisService = require('./redis');

class KazooService {
  constructor() {
    // Add /v2 prefix to base URL - this is critical
    const baseURL = process.env.KAZOO_URL || 'http://localhost:8000';
    this.config = {
      baseURL: baseURL.endsWith('/v2') ? baseURL : `${baseURL}/v2`,
      accountId: process.env.KAZOO_ACCOUNT_ID,
      authToken: null,
      pvtApiKey: process.env.KAZOO_API_KEY,
      username: process.env.KAZOO_USERNAME,
      password: process.env.KAZOO_PASSWORD
    };
    this.cacheTimeout = 300; // 5 minutes cache for Kazoo data
    
    // Connection tracking for optimization
    this.lastAuthTime = null;
    this.lastAccountId = null;
    this.tokenValidityPeriod = 3600000; // 1 hour in milliseconds
    
    // Request deduplication
    this.pendingRequests = new Map();
    
    // Create our own axios instance
    this.axios = axios.create({
      baseURL: this.config.baseURL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    logger.info(`Initialized Kazoo service with base URL: ${this.config.baseURL}`);
  }

  /**
   * Authenticate with Kazoo API
   * @returns {Promise<string>} - Auth token
   */
  async authenticate() {
    try {
      // Try username/password auth if available
      if (this.config.username && this.config.password) {
        logger.info(`Authenticating with Kazoo using username: ${this.config.username}`);
        
        const authResponse = await this.axios.put('/user_auth', {
          data: {
            credentials: this.config.password,
            account_name: this.config.accountId,
            method: 'md5'
          }
        });
        
        if (authResponse.data && authResponse.data.auth_token) {
          this.config.authToken = authResponse.data.auth_token;
          
          // Set the auth token header for future requests
          this.axios.defaults.headers.common['X-Auth-Token'] = this.config.authToken;
          
          logger.info('Successfully authenticated with Kazoo');
          return this.config.authToken;
        } else {
          logger.warn('Authentication response missing auth_token', {
            response: JSON.stringify(authResponse.data).substring(0, 500)
          });
          throw new Error('Authentication failed: No auth token received');
        }
      } else if (this.config.pvtApiKey) {
        // Use API key auth - make a proper request to get the auth token
        logger.info('Authenticating with Kazoo using API key');
        
        const authResponse = await this.axios.put('/api_auth', {
          data: {
            api_key: this.config.pvtApiKey
          }
        });
        
        if (authResponse.data && authResponse.data.auth_token) {
          this.config.authToken = authResponse.data.auth_token;
          
          // Set the auth token header for future requests
          this.axios.defaults.headers.common['X-Auth-Token'] = this.config.authToken;
          
          logger.info('Successfully authenticated with Kazoo using API key');
          return this.config.authToken;
        } else {
          logger.warn('Authentication response missing auth_token', {
            response: JSON.stringify(authResponse.data).substring(0, 500)
          });
          throw new Error('Authentication failed: No auth token received');
        }
      } else {
        logger.error('No authentication credentials available for Kazoo');
        throw new Error('No authentication credentials available');
      }
    } catch (error) {
      logger.error('Kazoo authentication failed:', {
        error: error.message,
        response: error.response?.data
      });
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Initialize the Kazoo connection with connection caching
   * @param {string} accountId - The account ID
   * @returns {Promise<void>}
   */
  async initialize(accountId = null) {
    try {
      if (accountId) {
        this.config.accountId = accountId;
      }

      if (!this.config.accountId) {
        throw new Error('No Kazoo account ID provided');
      }

      // Check if we already have a valid connection for this account
      const currentTime = Date.now();
      const tokenExpired = !this.lastAuthTime || 
                           (currentTime - this.lastAuthTime) > this.tokenValidityPeriod;
      
      // Only authenticate if:
      // 1. We don't have an auth token, or
      // 2. The token has expired, or
      // 3. The account ID has changed
      if (!this.axios.defaults.headers.common['X-Auth-Token'] || 
          tokenExpired || 
          this.lastAccountId !== this.config.accountId) {
        
        logger.info(`Initializing Kazoo connection for account: ${this.config.accountId}`);
        
        // Authenticate to get a new token
        await this.authenticate();
        
        // Update tracking variables
        this.lastAuthTime = currentTime;
        this.lastAccountId = this.config.accountId;
        
        logger.debug('Authentication completed and token updated');
      } else {
        logger.debug(`Using existing Kazoo connection for account: ${this.config.accountId}`);
      }
    } catch (error) {
      logger.error(`Failed to initialize Kazoo connection:`, error);
      throw new Error(`Failed to connect to Kazoo API: ${error.message}`);
    }
  }

  /**
   * Get user details from Kazoo API
   * @param {string} accountId - The account ID
   * @param {string} userId - The user ID
   * @returns {Object} - The user details
   */
  async getUser(accountId, userId) {
    try {
      if (!accountId || !userId) {
        throw new Error('Account ID and User ID are required');
      }
      
      // Initialize Kazoo connection
      await this.initialize(accountId);
      
      // Check for cached data first
      const cacheKey = `kazoo:user:${accountId}:${userId}`;
      const cachedUser = await redisService.get(cacheKey);
      
      if (cachedUser) {
        logger.info(`Using cached user data for ${userId}`);
        return JSON.parse(cachedUser);
      }

      // Make request to get user data
      const userUrl = `/accounts/${accountId}/users/${userId}`;
      logger.info(`Fetching user from Kazoo API: ${this.config.baseURL}${userUrl}`);
      
      const response = await this.axios.get(userUrl);
      
      // Log response structure
      logger.debug('Kazoo API user response:', {
        status: response.status,
        hasData: !!response.data,
        responseKeys: response.data ? Object.keys(response.data) : []
      });
      
      // Extract user data from response
      if (response.data && response.data.data) {
        const userData = response.data.data;
        
        // Check if there's a call_forward object
        if (userData.call_forward) {
          logger.info('Found call_forward settings in user data:', {
            enabled: userData.call_forward.enabled,
            number: userData.call_forward.number
          });
        } else {
          logger.info('No call_forward settings found in user data');
        }
        
        // Cache the user data
        await redisService.setex(cacheKey, this.cacheTimeout, JSON.stringify(userData));
        
        return userData;
      } else {
        logger.warn('Kazoo API response missing data property', {
          responseKeys: Object.keys(response.data)
        });
        throw new Error('Invalid response format from Kazoo API');
      }
    } catch (error) {
      logger.error(`Failed to get user ${userId} in account ${accountId}:`, {
        error: error.message,
        response: error.response?.data
      });
      throw new Error(`Failed to get user details: ${error.message}`);
    }
  }

  /**
   * Update user call forwarding settings
   * @param {string} accountId - The account ID
   * @param {string} userId - The user ID
   * @param {Object} callForward - The call forwarding settings
   * @returns {Object} - The updated user details
   */
  async updateCallForwarding(accountId, userId, callForward) {
    try {
      if (!accountId || !userId) {
        throw new Error('Account ID and User ID are required');
      }
      
      // Initialize Kazoo connection
      await this.initialize(accountId);
      
      // Get current user data first
      const user = await this.getUser(accountId, userId);
      
      // Create a copy of the user object
      const updatedUser = { ...user };
      
      // Make sure call_forward property exists
      if (!updatedUser.call_forward) {
        updatedUser.call_forward = {};
      }
      
      // Update call_forward field
      updatedUser.call_forward = {
        ...updatedUser.call_forward,
        ...callForward
      };
      
      logger.info(`Updating call forwarding settings for user ${userId}`, {
        callForward: updatedUser.call_forward
      });
      
      // Make request to update user
      const response = await this.axios.post(`/accounts/${accountId}/users/${userId}`, {
        data: updatedUser
      });
      
      // Extract updated user data from response
      if (response.data && response.data.data) {
        const result = response.data.data;
        
        // Clear the cache
        const cacheKey = `kazoo:user:${accountId}:${userId}`;
        await redisService.del(cacheKey);
        
        logger.info(`Successfully updated call forwarding for user ${userId}`);
        return result;
      } else {
        logger.warn('Kazoo API response missing data property');
        throw new Error('Invalid response format from Kazoo API');
      }
    } catch (error) {
      logger.error(`Failed to update call forwarding for user ${userId}:`, {
        error: error.message,
        response: error.response?.data
      });
      throw new Error(`Failed to update call forwarding: ${error.message}`);
    }
  }
  
  /**
   * OPTIMIZED: Get temporal rules from Kazoo with caching and parallel fetching
   * Only returns rules that have the 'enabled' property (true or false)
   * Time-based rules without 'enabled' property are filtered out
   * @param {string} accountId - Kazoo account ID
   * @returns {Promise<Array>} - Array of temporal rules with enabled property
   */
  async getTemporalRules(accountId) {
    const requestKey = `temporal_rules:${accountId}`;
    
    // Check if there's already a pending request
    if (this.pendingRequests.has(requestKey)) {
      logger.debug(`Deduplicating temporal rules request for ${accountId}`);
      return this.pendingRequests.get(requestKey);
    }
    
    // Create the promise for this request
    const requestPromise = this._getTemporalRulesInternal(accountId)
      .finally(() => {
        // Clean up after request completes
        this.pendingRequests.delete(requestKey);
      });
    
    // Store the pending request
    this.pendingRequests.set(requestKey, requestPromise);
    
    return requestPromise;
  }

  /**
   * Get ALL temporal rules including time-based ones (without filtering)
   * Use this if you need the complete list including time-based rules
   * @param {string} accountId - Kazoo account ID
   * @returns {Promise<Array>} - Array of all temporal rules
   */
  async getAllTemporalRules(accountId) {
    try {
      // Check cache first
      const cacheKey = `kazoo:temporal_rules:all:${accountId}`;
      const cached = await redisService.get(cacheKey);
      
      if (cached) {
        logger.debug(`Using cached ALL temporal rules for account ${accountId}`);
        return JSON.parse(cached);
      }
      
      // Initialize Kazoo connection
      await this.initialize(accountId);
      
      // Get temporal rules summary
      const response = await this.axios.get(`/accounts/${accountId}/temporal_rules`);
      
      if (!response.data || !response.data.data || !Array.isArray(response.data.data)) {
        logger.warn(`Invalid response format for temporal rules`);
        return [];
      }
      
      // Fetch details in parallel
      const detailPromises = response.data.data.map(rule => 
        this.axios.get(`/accounts/${accountId}/temporal_rules/${rule.id}`)
          .then(res => res.data?.data)
          .catch(err => {
            logger.error(`Error fetching temporal rule ${rule.id}:`, err);
            return null;
          })
      );
      
      const detailedRules = await Promise.all(detailPromises);
      const rules = detailedRules.filter(rule => rule !== null);
      
      // Cache for 5 minutes
      await redisService.setex(cacheKey, 300, JSON.stringify(rules));
      
      logger.info(`Retrieved and cached ${rules.length} total temporal rules for account ${accountId}`);
      return rules;
    } catch (error) {
      logger.error(`Error getting all temporal rules for account ${accountId}:`, error);
      throw new Error(`Failed to get temporal rules: ${error.message}`);
    }
  }

  /**
   * Internal implementation of getTemporalRules with caching
   * @private
   */
  async _getTemporalRulesInternal(accountId) {
    try {
      // Check cache first - use different key for filtered rules
      const cacheKey = `kazoo:temporal_rules:enabled_only:${accountId}`;
      const cached = await redisService.get(cacheKey);
      
      if (cached) {
        logger.debug(`Using cached temporal rules for account ${accountId}`);
        return JSON.parse(cached);
      }
      
      // Initialize Kazoo connection
      await this.initialize(accountId);
      
      // Get temporal rules summary with pagination
      const response = await this.axios.get(`/accounts/${accountId}/temporal_rules?paginate=true&page_size=5`);
      
      if (!response.data || !response.data.data || !Array.isArray(response.data.data)) {
        logger.warn(`Invalid response format for temporal rules: ${JSON.stringify(response.data)}`);
        return [];
      }
      
      // Fetch details in parallel instead of sequentially
      const detailPromises = response.data.data.map(rule => 
        this.axios.get(`/accounts/${accountId}/temporal_rules/${rule.id}`)
          .then(res => res.data?.data)
          .catch(err => {
            logger.error(`Error fetching temporal rule ${rule.id}:`, err);
            return null;
          })
      );
      
      const detailedRules = await Promise.all(detailPromises);
      
      // Filter out null results and rules without 'enabled' property
      const rules = detailedRules.filter(rule => {
        if (rule === null) return false;
        
        // Only include rules that have the 'enabled' property (true or false)
        const hasEnabledProperty = rule.hasOwnProperty('enabled');
        
        if (!hasEnabledProperty) {
          logger.debug(`Filtering out temporal rule ${rule.id} - no enabled property (time-based rule)`);
        }
        
        return hasEnabledProperty;
      });
      
      logger.info(`Filtered temporal rules: ${rules.length} with enabled property out of ${detailedRules.filter(r => r !== null).length} total rules`);
      
      // Cache for 5 minutes
      await redisService.setex(cacheKey, 300, JSON.stringify(rules));
      
      logger.info(`Retrieved and cached ${rules.length} temporal rules with enabled property for account ${accountId}`);
      return rules;
    } catch (error) {
      logger.error(`Error getting temporal rules for account ${accountId}:`, error);
      throw new Error(`Failed to get temporal rules: ${error.message}`);
    }
  }

  /**
   * Update a temporal rule's enabled status with safer error handling
   * @param {string} accountId - Kazoo account ID
   * @param {string} ruleId - Temporal rule ID
   * @param {Object} data - Update data
   * @returns {Promise<Object>} - Updated rule
   */
  async updateTemporalRule(accountId, ruleId, data) {
    try {
      // Initialize Kazoo connection
      await this.initialize(accountId);
      
      // Log only safe data without circular references
      const safeLoggingData = {};
      if (data.hasOwnProperty('enabled')) {
        safeLoggingData.enabled = data.enabled;
      } else {
        safeLoggingData.timeBasedRule = true;
      }
      
      logger.info(`Updating temporal rule ${ruleId} for account ${accountId}`, safeLoggingData);
      
      const response = await this.axios.post(`/accounts/${accountId}/temporal_rules/${ruleId}`, {
        data: data
      });
      
      if (!response.data || !response.data.data) {
        throw new Error('Invalid response format');
      }
      
      // Clear the cache after successful update
      const cacheKey = `kazoo:temporal_rules:enabled_only:${accountId}`;
      await redisService.del(cacheKey);
      
      logger.info(`Successfully updated temporal rule ${ruleId}`);
      return response.data.data;
    } catch (error) {
      // Extract only necessary error information to avoid circular references
      const errorMessage = error.message || 'Unknown error';
      const statusCode = error.response?.status || 'unknown';
      
      // Safely extract response data
      let responseData = 'No data';
      try {
        if (error.response && error.response.data) {
          if (typeof error.response.data === 'string') {
            responseData = error.response.data.substring(0, 100);
          } else {
            responseData = JSON.stringify(error.response.data).substring(0, 100);
          }
        }
      } catch (jsonError) {
        responseData = 'Error serializing response data';
      }
      
      logger.error(`Error updating temporal rule ${ruleId}:`, {
        message: errorMessage,
        status: statusCode,
        responsePreview: responseData
      });
      
      throw new Error(`Failed to update temporal rule: ${errorMessage}`);
    }
  }

  /**
   * Get conference details
   * @param {string} accountId - The account ID
   * @param {string} conferenceId - The conference ID
   * @returns {Object} - Conference details
   */
  async getConference(accountId, conferenceId) {
    try {
      await this.initialize(accountId);
      
      const response = await this.axios.get(`/accounts/${accountId}/conferences/${conferenceId}`);
      
      if (response.data && response.data.data) {
        return response.data.data;
      }
      
      throw new Error('Invalid response format');
    } catch (error) {
      logger.error(`Failed to get conference ${conferenceId}:`, error);
      throw error;
    }
  }

  /**
   * Set conference lock status
   * @param {string} accountId - The account ID
   * @param {string} conferenceId - The conference ID
   * @param {boolean} locked - Lock status
   * @returns {Object} - Updated conference
   */
  async setConferenceLock(accountId, conferenceId, locked) {
    try {
      await this.initialize(accountId);
      
      const conference = await this.getConference(accountId, conferenceId);
      conference.is_locked = locked;
      
      const response = await this.axios.post(`/accounts/${accountId}/conferences/${conferenceId}`, {
        data: conference
      });
      
      if (response.data && response.data.data) {
        return response.data.data;
      }
      
      throw new Error('Invalid response format');
    } catch (error) {
      logger.error(`Failed to set conference lock for ${conferenceId}:`, error);
      throw error;
    }
  }

  /**
   * Get active channels
   * @param {string} accountId - The account ID
   * @returns {Array} - Active channels
   */
  async getChannels(accountId) {
    try {
      await this.initialize(accountId);
      
      const response = await this.axios.get(`/accounts/${accountId}/channels`);
      
      if (response.data && response.data.data) {
        return response.data.data;
      }
      
      return [];
    } catch (error) {
      logger.error(`Failed to get channels for account ${accountId}:`, error);
      return [];
    }
  }
}

// Create and export a singleton instance
const kazooService = new KazooService();
module.exports = kazooService;