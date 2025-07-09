const xmlrpc = require('xmlrpc');
const logger = require('../utils/logger');
const redisService = require('./redis');

class OdooService {
  constructor() {
    this.config = {
      host: process.env.ODOO_HOST || 'odoo.host',
      port: process.env.ODOO_PORT || 8069,
      database: process.env.ODOO_DB || 'odooDatabase',
      username: process.env.ODOO_USER || 'odoo@domain.ca',
      password: process.env.ODOO_PASSWORD || 'sssssssssssss'
    };

    // Connection pooling
    this.maxConnections = parseInt(process.env.ODOO_MAX_CONNECTIONS) || 5;
    this.commonClients = [];
    this.objectClients = [];
    this.availableCommonClients = [];
    this.availableObjectClients = [];
    this.requestQueue = [];

    this.uid = null;
    this.cacheTimeout = 86400; // 24 hours (24 * 60 * 60)

    this.initializePool();
  }

  initializePool() {
    logger.info(`Initializing Odoo connection pool with ${this.maxConnections} connections`);
    
    for (let i = 0; i < this.maxConnections; i++) {
      // Common clients
      const commonClient = xmlrpc.createClient({
        host: this.config.host,
        port: this.config.port,
        path: '/xmlrpc/common'
      });
      this.commonClients.push(commonClient);
      this.availableCommonClients.push(commonClient);

      // Object clients  
      const objectClient = xmlrpc.createClient({
        host: this.config.host,
        port: this.config.port,
        path: '/xmlrpc/object'
      });
      this.objectClients.push(objectClient);
      this.availableObjectClients.push(objectClient);
    }
  }

  async getCommonClient() {
    return new Promise((resolve) => {
      if (this.availableCommonClients.length > 0) {
        const client = this.availableCommonClients.pop();
        resolve(client);
      } else {
        // Queue the request
        this.requestQueue.push({ type: 'common', resolve });
      }
    });
  }

  async getObjectClient() {
    return new Promise((resolve) => {
      if (this.availableObjectClients.length > 0) {
        const client = this.availableObjectClients.pop();
        resolve(client);
      } else {
        // Queue the request
        this.requestQueue.push({ type: 'object', resolve });
      }
    });
  }

  releaseCommonClient(client) {
    this.availableCommonClients.push(client);
    this.processQueue();
  }

  releaseObjectClient(client) {
    this.availableObjectClients.push(client);
    this.processQueue();
  }

  processQueue() {
    if (this.requestQueue.length === 0) return;

    const request = this.requestQueue.shift();
    if (request.type === 'common' && this.availableCommonClients.length > 0) {
      const client = this.availableCommonClients.pop();
      request.resolve(client);
    } else if (request.type === 'object' && this.availableObjectClients.length > 0) {
      const client = this.availableObjectClients.pop();
      request.resolve(client);
    } else {
      // Put it back at the front
      this.requestQueue.unshift(request);
    }
  }

  async authenticate() {
    if (this.uid) return this.uid;

    const client = await this.getCommonClient();
    
    try {
      const uid = await new Promise((resolve, reject) => {
        client.methodCall('login', [
          this.config.database,
          this.config.username,
          this.config.password
        ], (err, value) => {
          if (err) reject(err);
          else resolve(value);
        });
      });

      this.uid = uid;
      logger.info('Authenticated with Odoo', { uid });
      return uid;
    } catch (error) {
      logger.error('Odoo authentication failed:', error);
      throw new Error('Failed to authenticate with Odoo');
    } finally {
      this.releaseCommonClient(client);
    }
  }

  async executeMethod(model, method, args = [], fields = []) {
    await this.authenticate();

    const client = await this.getObjectClient();
    
    try {
      return new Promise((resolve, reject) => {
        client.methodCall('execute', [
          this.config.database,
          this.uid,
          this.config.password,
          model,
          method,
          ...args,
          ...(fields.length > 0 ? [fields] : [])
        ], (err, value) => {
          if (err) reject(err);
          else resolve(value);
        });
      });
    } finally {
      this.releaseObjectClient(client);
    }
  }

  /**
   * OPTIMIZED: Get lightweight device data for XML apps
   * Only fetches essential fields needed for Kazoo API operations
   * @param {string} mac - The device MAC address
   * @returns {Object} Minimal device data
   */
  async getDeviceDataLight(mac) {
    const cacheKey = `device:light:${mac}`;
    
    try {
      // Try cache first
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logger.debug(`Cache hit for device light data: ${mac}`);
        return JSON.parse(cached);
      }

      logger.debug(`Cache miss for device light data: ${mac}, querying Odoo`);

      // Query device from Odoo
      const deviceIds = await this.executeMethod(
        'kazoo_mgmt.devices',
        'search',
        [[['x_unique', 'ilike', mac]]]
      );

      if (!deviceIds || deviceIds.length === 0) {
        return null;
      }

      // Get only essential device data
      const deviceData = await this.executeMethod(
        'kazoo_mgmt.devices',
        'read',
        [deviceIds, ['x_unique', 'x_partners']]
      );

      if (!deviceData || deviceData.length === 0) {
        return null;
      }

      const device = deviceData[0];
      
      // Initialize result with device ID
      let result = {
        device: { id: device.id },
        kazooData: null
      };
      
      // Get only the first partner's organization data for Kazoo info
      if (device.x_partners && device.x_partners.length > 0) {
        const partnerData = await this.executeMethod(
          'res.partner',
          'read',
          [[device.x_partners[0]], ['commercial_partner_id', 'x_kazoo_enabled']]
        );
        
        if (partnerData && partnerData[0] && partnerData[0].commercial_partner_id) {
          const orgData = await this.executeMethod(
            'res.partner',
            'read',
            [[partnerData[0].commercial_partner_id[0]], ['x_kazoo_id', 'x_kazoo_enabled']]
          );
          
          if (orgData && orgData[0] && orgData[0].x_kazoo_id) {
            result.kazooData = {
              account_id: orgData[0].x_kazoo_id
            };
          }
        }
      }
      
      // Cache for 1 hour
      await redisService.setex(cacheKey, 3600, JSON.stringify(result));
      
      logger.debug(`Cached light device data for ${mac}`);
      return result;
    } catch (error) {
      logger.error(`Error getting light device data for ${mac}:`, error);
      
      // Try to return cached data if Odoo is down
      try {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          logger.warn(`Odoo unavailable, returning stale cache for light device data: ${mac}`);
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.error('Cache also unavailable:', cacheError);
      }
      
      throw error;
    }
  }

  /**
   * Get device data with expanded Kazoo user ID
   * @param {string} mac - The device MAC address
   * @returns {Object} Device data including Kazoo information
   */
  async getDeviceData(mac) {
    const cacheKey = `device:${mac}`;
    
    try {
      // Try cache first
      const cached = await redisService.get(cacheKey);
      if (cached) {
        logger.debug(`Cache hit for device: ${mac}`);
        return JSON.parse(cached);
      }

      logger.debug(`Cache miss for device: ${mac}, querying Odoo`);

      // Query device from Odoo
      const deviceIds = await this.executeMethod(
        'kazoo_mgmt.devices',
        'search',
        [[['x_unique', 'ilike', mac]]]
      );

      if (!deviceIds || deviceIds.length === 0) {
        return null;
      }

      const deviceFields = [
        'x_unique', 'x_vlan', 'x_headset', 'x_model', 
        'x_partners', 'x_owner', 'x_site', 'x_last_prov', 'x_call_waiting'
      ];

      const deviceData = await this.executeMethod(
        'kazoo_mgmt.devices',
        'read',
        [deviceIds, deviceFields]
      );

      if (!deviceData || deviceData.length === 0) {
        return null;
      }

      const device = deviceData[0];

      // Get site data
      let siteData = null;
      if (device.x_site && device.x_site[0]) {
        const siteFields = ['x_gtz', 'x_city', 'x_co', 'x_tz'];
        const sites = await this.executeMethod(
          'kazoo_mgmt.sites',
          'read',
          [[device.x_site[0]], siteFields]
        );
        siteData = sites[0] || null;
      }

      // Get partner data
      let partnersData = [];
      if (device.x_partners && device.x_partners.length > 0) {
        const partnerFields = [
          'firstname', 'x_voip_ext', 'x_voip_user', 'x_voip_secret',
          'x_mobile_user', 'x_mobile_secret', 'commercial_partner_id',
          'x_kazoo_enabled', 'x_device', 'x_kazoo_uid', 'email'
        ];
        
        const partners = await this.executeMethod(
          'res.partner',
          'read',
          [device.x_partners.sort(), partnerFields]
        );
        
        // Sort by extension
        partnersData = partners.sort((a, b) => 
          (a.x_voip_ext || 0) - (b.x_voip_ext || 0)
        );
        
        // For each partner with x_kazoo_uid, get the kazoo object
        for (const partner of partnersData) {
          if (partner.x_kazoo_uid && Array.isArray(partner.x_kazoo_uid) && partner.x_kazoo_uid[0]) {
            try {
              const kazooObjId = partner.x_kazoo_uid[0];
              
              logger.info(`Expanding x_kazoo_uid ${kazooObjId} for ${mac}`);
              
              // Get the kazoo object record
              const kazooObjFields = ['x_kid', 'x_type', 'x_name'];
              const kazooObjs = await this.executeMethod(
                'kazoo_mgmt.objects',
                'read',
                [[kazooObjId], kazooObjFields]
              );
              
              if (kazooObjs && kazooObjs.length > 0) {
                const kazooObj = kazooObjs[0];
                
                // Add the actual Kazoo ID to the partner data
                partner.x_kazoo_kid = kazooObj.x_kid;
                
                logger.info(`Found Kazoo user ID ${kazooObj.x_kid} for ${mac}`, {
                  objectName: kazooObj.x_name,
                  objectType: kazooObj.x_type
                });
              } else {
                logger.warn(`Kazoo object not found for ID: ${kazooObjId}`);
              }
            } catch (error) {
              logger.error(`Failed to get Kazoo object data: ${error.message}`, {
                mac,
                partnerId: partner.id,
                kazooUid: partner.x_kazoo_uid
              });
            }
          }
        }
      }

      // Get organization data for each partner
      const organizationsData = [];
      for (const partner of partnersData) {
        if (partner.commercial_partner_id && partner.commercial_partner_id[0]) {
          const orgFields = [
            'name', 'ref', 'x_kazoo_realm', 'x_pbxip', 
            'x_kazoo_enabled', 'x_legacy', 'x_kazoo_id'
          ];
          
          const orgs = await this.executeMethod(
            'res.partner',
            'read',
            [[partner.commercial_partner_id[0]], orgFields]
          );
          
          organizationsData.push(orgs[0] || null);
        } else {
          organizationsData.push(null);
        }
      }

      const result = {
        id: device.id,
        device,
        site: siteData,
        partners: partnersData,
        organizations: organizationsData
      };

      // Cache the result
      await redisService.setex(cacheKey, this.cacheTimeout, JSON.stringify(result));
      
      return result;
    } catch (error) {
      logger.error(`Error getting device data for ${mac}:`, error);
      
      // Try to return cached data if Odoo is down
      try {
        const cached = await redisService.get(cacheKey);
        if (cached) {
          logger.warn(`Odoo unavailable, returning stale cache for device: ${mac}`);
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.error('Cache also unavailable:', cacheError);
      }
      
      throw error;
    }
  }

  async updateLastProvision(deviceId) {
    try {
      await this.executeMethod(
        'kazoo_mgmt.devices',
        'write',
        [[deviceId], { x_last_prov: new Date().toISOString() }]
      );

      logger.debug(`Updated last provision timestamp for device ID: ${deviceId}`);
    } catch (error) {
      logger.error(`Failed to update last provision for device ${deviceId}:`, error);
      throw error;
    }
  }

  async clearDeviceCache(mac) {
    const cacheKey = `device:${mac}`;
    const lightCacheKey = `device:light:${mac}`;
    
    await redisService.del(cacheKey);
    await redisService.del(lightCacheKey);
    
    logger.debug(`Cleared cache for device: ${mac}`);
  }

  // Connection pool status for monitoring
  getPoolStatus() {
    return {
      maxConnections: this.maxConnections,
      availableCommon: this.availableCommonClients.length,
      availableObject: this.availableObjectClients.length,
      queueLength: this.requestQueue.length
    };
  }

  // Graceful shutdown
  async destroy() {
    logger.info('Shutting down Odoo connection pool');
    // XML-RPC clients don't need explicit cleanup
    this.availableCommonClients.length = 0;
    this.availableObjectClients.length = 0;
    this.requestQueue.length = 0;
  }
}

module.exports = new OdooService();