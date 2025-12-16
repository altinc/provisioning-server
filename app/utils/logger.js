const winston = require('winston');

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue'
};

winston.addColors(colors);

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      metaStr = ` ${JSON.stringify(meta)}`;
    }
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Custom format for file output
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Create transports array
const transports = [
  // Console transport
  new winston.transports.Console({
    level: process.env.LOG_LEVEL || 'info',
    format: consoleFormat
  })
];

// Add file transport with rotation in all environments (adjust sizes for dev vs prod)
const isDevelopment = process.env.NODE_ENV !== 'production';
const maxLogSize = isDevelopment ? 2097152 : 10485760; // 2MB dev, 10MB prod
const maxLogFiles = isDevelopment ? 3 : 10; // Keep fewer files in dev

transports.push(
  new winston.transports.File({
    filename: 'logs/error.log',
    level: 'error',
    format: fileFormat,
    maxsize: maxLogSize,
    maxFiles: maxLogFiles
  }),
  new winston.transports.File({
    filename: 'logs/combined.log',
    format: fileFormat,
    maxsize: maxLogSize,
    maxFiles: maxLogFiles
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels,
  format: fileFormat,
  transports,
  exitOnError: false
});

// Handle uncaught exceptions and unhandled rejections
logger.exceptions.handle(
  new winston.transports.File({ 
    filename: 'logs/exceptions.log',
    format: fileFormat
  })
);

logger.rejections.handle(
  new winston.transports.File({ 
    filename: 'logs/rejections.log',
    format: fileFormat
  })
);

// Add stream method for Morgan HTTP logger integration
logger.stream = {
  write: (message) => {
    logger.info(message.trim());
  }
};

module.exports = logger;
