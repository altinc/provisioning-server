# Use official Node.js runtime as base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Create directories for volume mounts (these will be mounted from host)
RUN mkdir -p logs templates files/fw files/devices files/assets

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S provisioning -u 1001

# Copy package files from app directory
COPY app/package*.json ./

# Install dependencies
RUN npm install --omit=dev && npm cache clean --force

# Copy application code from app directory (excluding templates and files)
COPY app/ .

# Remove any copied templates and files directories since they'll be mounted
RUN rm -rf templates/* files/*

# Set proper permissions for mount points
RUN chown -R provisioning:nodejs /app && \
    chmod -R 755 /app && \
    chmod -R 775 /app/templates /app/files

# Switch to non-root user
USER provisioning

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]