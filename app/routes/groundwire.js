javascriptconst express = require('express');
const { param, validationResult } = require('express-validator');
const router = express.Router();

const groundwireController = require('../controllers/groundwire');
const logger = require('../utils/logger');

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    logger.warn('Groundwire validation failed', {
      ip: req.ip,
      url: req.url,
      errors: errors.array()
    });
    return res.status(400).json({ 
      error: 'Invalid input parameters',
      details: errors.array()
    });
  }
  next();
};

// Routes
router.get('/success', groundwireController.renderGroundwireSuccess);

router.get('/:id?', [
  param('id').optional().isNumeric().withMessage('ID must be numeric'),
  handleValidationErrors
], groundwireController.renderGroundwire);

module.exports = router;
