const express = require('express');
const axios = require('axios');
const https = require('https');
const logger = require('../utils/logger');

const router = express.Router();

// Create an axios instance with SSL verification disabled
const axiosInstance = axios.create({
  baseURL: 'https://96.126.70.132',
  httpsAgent: new https.Agent({
    rejectUnauthorized: false // Ignore SSL certificate errors
  }),
  timeout: 30000, // 30 second timeout
  maxRedirects: 5,
  validateStatus: () => true, // Don't throw on any status code
  maxContentLength: 50 * 1024 * 1024, // 50MB max
  maxBodyLength: 50 * 1024 * 1024 // 50MB max
});

// Proxy all requests under /xml
router.all('*', async (req, res) => {
  const startTime = Date.now();
  
  try {
    logger.info('Proxying XML request', {
      method: req.method,
      url: req.url,
      targetUrl: `https://96.126.70.132/xml${req.url}`,
      ip: req.ip,
      ipSource: req.ipSource,
      userAgent: req.get('User-Agent')
    });
    
    // Build the target URL
    const targetPath = `/xml${req.url}`;
    
    // Forward the request - NOT using stream responseType
    const response = await axiosInstance({
      method: req.method,
      url: targetPath,
      data: req.body,
      headers: {
        ...req.headers,
        host: '96.126.70.132', // Override host header
        'x-forwarded-for': req.ip,
        'x-forwarded-proto': req.protocol,
        'x-forwarded-host': req.get('host')
      },
      params: req.query,
      responseType: 'arraybuffer' // Get the full response as buffer
    });
    
    const duration = Date.now() - startTime;
    
    // Log the response
    logger.info('XML proxy response', {
      statusCode: response.status,
      method: req.method,
      url: req.url,
      ip: req.ip,
      duration: `${duration}ms`,
      contentLength: response.data.length,
      contentType: response.headers['content-type']
    });
    
    // Copy response headers
    Object.entries(response.headers).forEach(([key, value]) => {
      res.set(key, value);
    });
    
    // Set the status code and send the complete response
    res.status(response.status).send(Buffer.from(response.data));
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    logger.error('XML proxy error', {
      error: error.message,
      method: req.method,
      url: req.url,
      ip: req.ip,
      duration: `${duration}ms`,
      stack: error.stack,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers
      } : undefined
    });
    
    // Send error response
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Proxy error',
        message: 'Failed to proxy request to XML server',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  }
});

module.exports = router;