const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const router = express.Router();

// Serve static files from public/groundwire directory
const staticPath = path.join(__dirname, '..', 'public', 'groundwire');

// Check if the directory exists
if (!fs.existsSync(staticPath)) {
  logger.warn('Groundwire static directory does not exist', { 
    path: staticPath,
    hint: 'Create the directory and add your HTML files' 
  });
  
  // Create directory if it doesn't exist
  try {
    fs.mkdirSync(staticPath, { recursive: true });
    logger.info('Created groundwire static directory', { path: staticPath });
  } catch (err) {
    logger.error('Failed to create groundwire directory', { error: err.message });
  }
}

// Debug logging to verify path
logger.info('Groundwire static path configured', { staticPath });

// Log all requests
router.use((req, res, next) => {
  const startTime = Date.now();
  
  logger.info('Groundwire static request', {
    method: req.method,
    url: req.url,
    originalUrl: req.originalUrl,
    ip: req.ip,
    ipSource: req.ipSource,
    userAgent: req.get('User-Agent')
  });
  
  // Log response after it's sent
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info('Groundwire static response', {
      statusCode: res.statusCode,
      method: req.method,
      url: req.url,
      ip: req.ip,
      duration: `${duration}ms`
    });
  });
  
  next();
});

// Serve static assets (CSS, JS, images, etc.) with express.static
// This middleware will only serve files that actually exist
router.use(express.static(staticPath, {
  index: false, // Don't serve index.html automatically
  setHeaders: (res, filePath, stat) => {
    // Set cache headers for static assets
    if (filePath.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
      res.set('Cache-Control', 'public, max-age=86400'); // 1 day
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback - serve index.html for all non-file requests
router.get('*', (req, res) => {
  const indexPath = path.join(staticPath, 'index.html');
  
  // Check if index.html exists
  fs.access(indexPath, fs.constants.F_OK, (err) => {
    if (err) {
      logger.error('index.html not found', { 
        path: indexPath,
        url: req.url,
        originalUrl: req.originalUrl
      });
      
      // Return JSON error if no index.html
      res.status(500).json({
        error: 'Configuration error',
        message: 'index.html not found in groundwire directory',
        hint: 'Please ensure your React app build files are in public/groundwire/',
        timestamp: new Date().toISOString()
      });
    } else {
      // Serve index.html for all routes (SPA routing)
      logger.info('Serving index.html for SPA route', {
        requestedUrl: req.url,
        originalUrl: req.originalUrl
      });
      
      res.sendFile(indexPath, (err) => {
        if (err) {
          logger.error('Error serving index.html', { 
            error: err.message,
            path: indexPath 
          });
          res.status(500).json({
            error: 'Server error',
            message: 'Failed to serve application',
            timestamp: new Date().toISOString()
          });
        }
      });
    }
  });
});

module.exports = router;