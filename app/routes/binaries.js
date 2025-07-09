const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const multer = require('multer'); // Add this
const { body, param, query, validationResult } = require('express-validator'); // Add param and body
const { parseBasicAuth, validateBasicAuth } = require('../utils/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Input validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Input validation failed', {
      ip: req.ip,
      url: req.url,
      errors: errors.array(),
      userAgent: req.get('User-Agent')
    });
    return res.status(400).json({ 
      error: 'Invalid input parameters',
      details: errors.array()
    });
  }
  next();
};

// Admin authentication middleware
const requireAuth = (req, res, next) => {
  const authHeader = req.get('Authorization');
  
  if (!authHeader) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const credentials = parseBasicAuth(authHeader);
  if (!credentials || !validateBasicAuth(credentials.username, credentials.password)) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  next();
};

// Middleware to log binary file access and set appropriate headers
const binaryFileMiddleware = (fileType, maxAge = 86400) => { // Default 1 day cache
  return async (req, res, next) => {
    const startTime = Date.now();
    const { file } = req.params;
    const clientIP = req.ip;
    const userAgent = req.get('User-Agent') || 'Unknown';
    
    // Security: Prevent directory traversal
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      logger.warn('Directory traversal attempt detected', {
        ip: clientIP,
        file,
        userAgent,
        fileType
      });
      return res.status(400).json({ error: 'Invalid file path' });
    }
    
    try {
      // Determine base directory based on file type
      let baseDir;
      let allowedExtensions;
      let contentType;
      
      switch (fileType) {
        case 'firmware':
          baseDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
          allowedExtensions = ['.bin', '.rom', '.img', '.tar', '.zip', '.gz'];
          contentType = 'application/octet-stream';
          break;
        case 'device':
          baseDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
          allowedExtensions = ['.png'];
          contentType = 'image/png';
          break;
        case 'asset':
          baseDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
          allowedExtensions = ['.jpg', '.jpeg'];
          contentType = 'image/jpeg';
          break;
        default:
          return res.status(400).json({ error: 'Invalid file type' });
      }
      
      // Validate file extension
      const fileExtension = path.extname(file).toLowerCase();
      if (!allowedExtensions.includes(fileExtension)) {
        logger.warn('Invalid file extension requested', {
          ip: clientIP,
          file,
          extension: fileExtension,
          allowed: allowedExtensions,
          fileType
        });
        return res.status(400).json({ error: 'File type not allowed' });
      }
      
      const filePath = path.join(baseDir, file);
      
      // Check if file exists and get stats
      try {
        const stats = await fs.stat(filePath);
        
        if (!stats.isFile()) {
          throw new Error('Not a file');
        }
        
        // Set appropriate headers
        res.set({
          'Content-Type': contentType,
          'Content-Length': stats.size,
          'Cache-Control': `public, max-age=${maxAge}`,
          'ETag': `"${stats.mtime.getTime()}-${stats.size}"`,
          'Last-Modified': stats.mtime.toUTCString(),
          'Accept-Ranges': 'bytes' // Enable range requests for large files
        });
        
        // Handle conditional requests (If-None-Match, If-Modified-Since)
        const ifNoneMatch = req.get('If-None-Match');
        const ifModifiedSince = req.get('If-Modified-Since');
        const etag = res.get('ETag');
        
        if (ifNoneMatch === etag || 
            (ifModifiedSince && new Date(ifModifiedSince) >= stats.mtime)) {
          logger.info(`File not modified, sending 304: ${file}`, {
            ip: clientIP,
            fileType,
            size: stats.size
          });
          return res.status(304).end();
        }
        
        // Handle range requests for partial content
        const range = req.get('Range');
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
          const chunksize = (end - start) + 1;
          
          res.status(206);
          res.set({
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Content-Length': chunksize
          });
          
          logger.info(`Serving partial content: ${file}`, {
            ip: clientIP,
            fileType,
            range: `${start}-${end}`,
            totalSize: stats.size
          });
        }
        
        // Store file info for logging after response
        req.fileInfo = {
          path: filePath,
          size: stats.size,
          type: fileType,
          name: file
        };
        
        next();
        
      } catch (fileError) {
        logger.warn(`File not found: ${file}`, {
          ip: clientIP,
          fileType,
          error: fileError.message
        });
        return res.status(404).json({ error: 'File not found' });
      }
      
    } catch (error) {
      logger.error(`Error serving binary file: ${file}`, {
        ip: clientIP,
        fileType,
        error: error.message
      });
      return res.status(500).json({ error: 'Error serving file' });
    }
  };
};

// Middleware to log successful file downloads
const logFileDownload = (req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    if (req.fileInfo && res.statusCode === 200) {
      const duration = Date.now() - startTime;
      logger.info(`File download completed: ${req.fileInfo.name}`, {
        ip: req.ip,
        fileType: req.fileInfo.type,
        size: req.fileInfo.size,
        duration: `${duration}ms`,
        userAgent: req.get('User-Agent'),
        statusCode: res.statusCode
      });
    }
  });
  
  next();
};

// ==================== FILE SERVING ROUTES ====================

// Firmware files route - /fw/filename.bin
router.get('/fw/:file',
  binaryFileMiddleware('firmware', 604800), // 7 days cache for firmware
  logFileDownload,
  (req, res) => {
    res.sendFile(req.fileInfo.path);
  }
);

// Device images route - /devices/model.png
router.get('/devices/:file',
  binaryFileMiddleware('device', 86400), // 1 day cache for device images
  logFileDownload,
  (req, res) => {
    res.sendFile(req.fileInfo.path);
  }
);

// Background assets route - /assets/background.jpg
router.get('/assets/:file',
  binaryFileMiddleware('asset', 43200), // 12 hours cache for assets
  logFileDownload,
  (req, res) => {
    res.sendFile(req.fileInfo.path);
  }
);

// Background assets route - /gs/assets/background.jpg -- can be removed after migration
router.get('/gs/asset/:file',
  binaryFileMiddleware('asset', 43200), // 12 hours cache for assets
  logFileDownload,
  (req, res) => {
    res.sendFile(req.fileInfo.path);
  }
);


// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const { type } = req.params;
    let uploadDir;
    
    switch (type) {
      case 'firmware':
        uploadDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
        break;
      case 'devices':
        uploadDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
        break;
      case 'assets':
        uploadDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
        break;
      default:
        return cb(new Error('Invalid file type'));
    }
    
    // Ensure directory exists
    fs.mkdir(uploadDir, { recursive: true }).then(() => {
      cb(null, uploadDir);
    }).catch(cb);
  },
  filename: function (req, file, cb) {
    // Keep original filename, optionally add timestamp for uniqueness
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
    files: 10 // Max 10 files at once
  },
  fileFilter: function (req, file, cb) {
    const { type } = req.params;
    const allowedExtensions = {
      firmware: ['.bin', '.rom', '.img', '.tar', '.zip', '.gz'],
      devices: ['.png'],
      assets: ['.jpg', '.jpeg']
    };
    
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions[type] && allowedExtensions[type].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed extensions for ${type}: ${allowedExtensions[type].join(', ')}`));
    }
  }
});

// ==================== FILE MANAGER WEB UI ====================

// File Manager Dashboard
router.get('/admin/files/manager', requireAuth, (req, res) => {
  res.render('admin/file-manager.html', {
    title: 'File Manager'
  });
});

// ==================== FILE UPLOAD ENDPOINTS ====================

// Upload files endpoint
router.post('/admin/files/:type/upload', [
  requireAuth,
  param('type').isIn(['firmware', 'devices', 'assets']).withMessage('Invalid file type'),
  handleValidationErrors
], upload.array('files'), async (req, res) => {
  try {
    const { type } = req.params;
    const uploadedFiles = req.files || [];
    
    const results = uploadedFiles.map(file => ({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      path: file.path,
      mimetype: file.mimetype
    }));
    
    logger.info(`Files uploaded to ${type}`, {
      ip: req.ip,
      fileCount: uploadedFiles.length,
      totalSize: uploadedFiles.reduce((sum, file) => sum + file.size, 0),
      filenames: uploadedFiles.map(f => f.filename)
    });
    
    res.json({
      success: true,
      message: `${uploadedFiles.length} file(s) uploaded successfully`,
      files: results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('File upload error:', error);
    res.status(500).json({
      success: false,
      error: 'File upload failed',
      message: error.message
    });
  }
});

// ==================== FILE DELETION ENDPOINTS ====================

// Delete single file
router.delete('/admin/files/:type/:filename', [
  requireAuth,
  param('type').isIn(['firmware', 'devices', 'assets']).withMessage('Invalid file type'),
  param('filename').custom((value) => {
    // Security: Prevent directory traversal
    if (value.includes('..') || value.includes('/') || value.includes('\\')) {
      throw new Error('Invalid filename');
    }
    return true;
  }),
  handleValidationErrors
], async (req, res) => {
  try {
    const { type, filename } = req.params;
    
    let baseDir;
    switch (type) {
      case 'firmware':
        baseDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
        break;
      case 'devices':
        baseDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
        break;
      case 'assets':
        baseDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
        break;
    }
    
    const filePath = path.join(baseDir, filename);
    
    // Verify file exists
    await fs.access(filePath);
    
    // Delete the file
    await fs.unlink(filePath);
    
    logger.info(`File deleted: ${type}/${filename}`, {
      ip: req.ip,
      filePath
    });
    
    res.json({
      success: true,
      message: `File ${filename} deleted successfully`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn(`File not found for deletion: ${req.params.type}/${req.params.filename}`, {
        ip: req.ip
      });
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }
    
    logger.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'File deletion failed',
      message: error.message
    });
  }
});

// Bulk delete files
router.delete('/admin/files/:type', [
  requireAuth,
  param('type').isIn(['firmware', 'devices', 'assets']).withMessage('Invalid file type'),
  body('files').isArray().withMessage('Files must be an array'),
  body('files.*').custom((value) => {
    // Security: Prevent directory traversal
    if (value.includes('..') || value.includes('/') || value.includes('\\')) {
      throw new Error('Invalid filename');
    }
    return true;
  }),
  handleValidationErrors
], async (req, res) => {
  try {
    const { type } = req.params;
    const { files } = req.body;
    
    let baseDir;
    switch (type) {
      case 'firmware':
        baseDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
        break;
      case 'devices':
        baseDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
        break;
      case 'assets':
        baseDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
        break;
    }
    
    const results = [];
    
    for (const filename of files) {
      try {
        const filePath = path.join(baseDir, filename);
        await fs.access(filePath);
        await fs.unlink(filePath);
        results.push({ filename, success: true });
      } catch (error) {
        results.push({ filename, success: false, error: error.message });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;
    
    logger.info(`Bulk file deletion: ${successCount} succeeded, ${failCount} failed`, {
      ip: req.ip,
      type,
      results
    });
    
    res.json({
      success: failCount === 0,
      message: `${successCount} file(s) deleted successfully` + (failCount > 0 ? `, ${failCount} failed` : ''),
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Bulk file deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'Bulk deletion failed',
      message: error.message
    });
  }
});

// ==================== FILE INFORMATION ENDPOINTS ====================

// Get file details
router.get('/admin/files/:type/:filename/info', [
  requireAuth,
  param('type').isIn(['firmware', 'devices', 'assets']).withMessage('Invalid file type'),
  param('filename').custom((value) => {
    if (value.includes('..') || value.includes('/') || value.includes('\\')) {
      throw new Error('Invalid filename');
    }
    return true;
  }),
  handleValidationErrors
], async (req, res) => {
  try {
    const { type, filename } = req.params;
    
    let baseDir;
    switch (type) {
      case 'firmware':
        baseDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
        break;
      case 'devices':
        baseDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
        break;
      case 'assets':
        baseDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
        break;
    }
    
    const filePath = path.join(baseDir, filename);
    const stats = await fs.stat(filePath);
    
    const fileInfo = {
      filename,
      type,
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      extension: path.extname(filename),
      url: `/${type}/${filename}`,
      path: filePath
    };
    
    res.json(fileInfo);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    
    logger.error('Error getting file info:', error);
    res.status(500).json({ error: 'Failed to get file information' });
  }
});

// Enhanced file listing with search and sorting
router.get('/admin/files/:type/search', [
  requireAuth,
  param('type').isIn(['firmware', 'devices', 'assets']).withMessage('Invalid file type'),
  query('q').optional().isString(),
  query('sort').optional().isIn(['name', 'size', 'modified']),
  query('order').optional().isIn(['asc', 'desc']),
  handleValidationErrors
], async (req, res) => {
  try {
    const { type } = req.params;
    const { q: searchQuery, sort = 'modified', order = 'desc' } = req.query;
    
    let baseDir;
    let allowedExtensions;
    
    switch (type) {
      case 'firmware':
        baseDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
        allowedExtensions = ['.bin', '.rom', '.img', '.tar', '.zip', '.gz'];
        break;
      case 'devices':
        baseDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
        allowedExtensions = ['.png'];
        break;
      case 'assets':
        baseDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
        allowedExtensions = ['.jpg', '.jpeg'];
        break;
    }
    
    try {
      await fs.access(baseDir);
    } catch (error) {
      return res.json({ files: [], total: 0, message: `${type} directory not found` });
    }
    
    const files = await fs.readdir(baseDir);
    let filteredFiles = files.filter(file => 
      allowedExtensions.includes(path.extname(file).toLowerCase())
    );
    
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filteredFiles = filteredFiles.filter(file => 
        file.toLowerCase().includes(query)
      );
    }
    
    // Get file stats and create file objects
    const fileList = await Promise.all(filteredFiles.map(async (file) => {
      const filePath = path.join(baseDir, file);
      const stats = await fs.stat(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        created: stats.birthtime,
        url: `/${type}/${file}`,
        type: path.extname(file).toLowerCase()
      };
    }));
    
    // Sort files
    fileList.sort((a, b) => {
      let aVal, bVal;
      
      switch (sort) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'size':
          aVal = a.size;
          bVal = b.size;
          break;
        case 'modified':
        default:
          aVal = new Date(a.modified);
          bVal = new Date(b.modified);
          break;
      }
      
      if (order === 'asc') {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });
    
    res.json({
      files: fileList,
      total: fileList.length,
      query: searchQuery,
      sort,
      order,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Error searching ${req.params.type} files:`, error);
    res.status(500).json({ error: 'Error searching files' });
  }
});

// ==================== ADMIN FILE LISTING ENDPOINTS ====================

// List available firmware files
router.get('/admin/files/firmware', requireAuth, async (req, res) => {
  try {
    const firmwareDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
    
    // Ensure directory exists
    try {
      await fs.access(firmwareDir);
    } catch (error) {
      logger.warn('Firmware directory does not exist', { directory: firmwareDir });
      return res.json({
        directory: 'firmware',
        files: [],
        message: 'Firmware directory not found'
      });
    }
    
    const files = await fs.readdir(firmwareDir);
    const firmwareFiles = files.filter(file => 
      ['.bin', '.rom', '.img', '.tar', '.zip', '.gz'].includes(path.extname(file).toLowerCase())
    );
    
    const fileList = await Promise.all(firmwareFiles.map(async (file) => {
      const filePath = path.join(firmwareDir, file);
      const stats = await fs.stat(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        url: `/fw/${file}`,
        type: path.extname(file).toLowerCase()
      };
    }));
    
    res.json({
      directory: 'firmware',
      path: firmwareDir,
      files: fileList.sort((a, b) => b.modified - a.modified),
      total: fileList.length,
      totalSize: fileList.reduce((sum, file) => sum + file.size, 0)
    });
    
    logger.info('Firmware files listed', {
      ip: req.ip,
      fileCount: fileList.length,
      requestedBy: 'admin'
    });
  } catch (error) {
    logger.error('Error listing firmware files:', error);
    res.status(500).json({ error: 'Error listing files' });
  }
});

// List available device images
router.get('/admin/files/devices', requireAuth, async (req, res) => {
  try {
    const devicesDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
    
    // Ensure directory exists
    try {
      await fs.access(devicesDir);
    } catch (error) {
      logger.warn('Devices directory does not exist', { directory: devicesDir });
      return res.json({
        directory: 'devices',
        files: [],
        message: 'Devices directory not found'
      });
    }
    
    const files = await fs.readdir(devicesDir);
    const deviceFiles = files.filter(file => 
      path.extname(file).toLowerCase() === '.png'
    );
    
    const fileList = await Promise.all(deviceFiles.map(async (file) => {
      const filePath = path.join(devicesDir, file);
      const stats = await fs.stat(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        url: `/devices/${file}`,
        type: '.png'
      };
    }));
    
    res.json({
      directory: 'devices',
      path: devicesDir,
      files: fileList.sort((a, b) => a.name.localeCompare(b.name)),
      total: fileList.length,
      totalSize: fileList.reduce((sum, file) => sum + file.size, 0)
    });
    
    logger.info('Device files listed', {
      ip: req.ip,
      fileCount: fileList.length,
      requestedBy: 'admin'
    });
  } catch (error) {
    logger.error('Error listing device files:', error);
    res.status(500).json({ error: 'Error listing files' });
  }
});

// List available background assets
router.get('/admin/files/assets', requireAuth, async (req, res) => {
  try {
    const assetsDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
    
    // Ensure directory exists
    try {
      await fs.access(assetsDir);
    } catch (error) {
      logger.warn('Assets directory does not exist', { directory: assetsDir });
      return res.json({
        directory: 'assets',
        files: [],
        message: 'Assets directory not found'
      });
    }
    
    const files = await fs.readdir(assetsDir);
    const assetFiles = files.filter(file => 
      ['.jpg', '.jpeg'].includes(path.extname(file).toLowerCase())
    );
    
    const fileList = await Promise.all(assetFiles.map(async (file) => {
      const filePath = path.join(assetsDir, file);
      const stats = await fs.stat(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        url: `/assets/${file}`,
        type: path.extname(file).toLowerCase()
      };
    }));
    
    res.json({
      directory: 'assets',
      path: assetsDir,
      files: fileList.sort((a, b) => a.name.localeCompare(b.name)),
      total: fileList.length,
      totalSize: fileList.reduce((sum, file) => sum + file.size, 0)
    });
    
    logger.info('Asset files listed', {
      ip: req.ip,
      fileCount: fileList.length,
      requestedBy: 'admin'
    });
  } catch (error) {
    logger.error('Error listing asset files:', error);
    res.status(500).json({ error: 'Error listing files' });
  }
});

// Combined file listing endpoint
router.get('/admin/files', requireAuth, async (req, res) => {
  try {
    // Get all file types in parallel
    const [firmwareRes, devicesRes, assetsRes] = await Promise.all([
      // Simulate the individual endpoints
      new Promise(async (resolve) => {
        try {
          const firmwareDir = process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw');
          const files = await fs.readdir(firmwareDir).catch(() => []);
          const firmwareFiles = files.filter(file => 
            ['.bin', '.rom', '.img', '.tar', '.zip', '.gz'].includes(path.extname(file).toLowerCase())
          );
          resolve({ type: 'firmware', count: firmwareFiles.length });
        } catch (error) {
          resolve({ type: 'firmware', count: 0, error: error.message });
        }
      }),
      new Promise(async (resolve) => {
        try {
          const devicesDir = process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices');
          const files = await fs.readdir(devicesDir).catch(() => []);
          const deviceFiles = files.filter(file => path.extname(file).toLowerCase() === '.png');
          resolve({ type: 'devices', count: deviceFiles.length });
        } catch (error) {
          resolve({ type: 'devices', count: 0, error: error.message });
        }
      }),
      new Promise(async (resolve) => {
        try {
          const assetsDir = process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets');
          const files = await fs.readdir(assetsDir).catch(() => []);
          const assetFiles = files.filter(file => ['.jpg', '.jpeg'].includes(path.extname(file).toLowerCase()));
          resolve({ type: 'assets', count: assetFiles.length });
        } catch (error) {
          resolve({ type: 'assets', count: 0, error: error.message });
        }
      })
    ]);
    
    res.json({
      summary: {
        firmware: firmwareRes.count,
        devices: devicesRes.count,
        assets: assetsRes.count,
        total: firmwareRes.count + devicesRes.count + assetsRes.count
      },
      directories: {
        firmware: process.env.FIRMWARE_DIR || path.join(process.cwd(), 'files', 'fw'),
        devices: process.env.DEVICE_IMAGES_DIR || path.join(process.cwd(), 'files', 'devices'),
        assets: process.env.ASSETS_DIR || path.join(process.cwd(), 'files', 'assets')
      },
      endpoints: {
        firmware: '/admin/files/firmware',
        devices: '/admin/files/devices',
        assets: '/admin/files/assets'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error getting file summary:', error);
    res.status(500).json({ error: 'Error getting file summary' });
  }
});

module.exports = router;