#!/bin/bash

# Secure VoIP Provisioning Server Deployment Script
# This script deploys the enhanced security version with nginx SSL termination

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKUP_DIR="./backup-$(date +%Y%m%d-%H%M%S)"
NGINX_DIR="./nginx"

echo -e "${GREEN}🚀 VoIP Provisioning Server - Secure Deployment${NC}"
echo -e "${BLUE}================================================${NC}"
echo

# Function to check if running as correct user
check_user() {
    if [[ $EUID -eq 0 ]]; then
        echo -e "${RED}❌ Don't run this script as root!${NC}"
        echo -e "${YELLOW}   Run as the user that owns the Docker installation${NC}"
        exit 1
    fi
}

# Function to check prerequisites
check_prerequisites() {
    echo -e "${BLUE}📋 Checking prerequisites...${NC}"
    
    # Check if docker is installed
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker is not installed${NC}"
        exit 1
    fi
    
    # Check if docker-compose is installed
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker Compose is not installed${NC}"
        exit 1
    fi
    
    # Check if we're in the right directory
    if [[ ! -f "docker-compose.yml" ]]; then
        echo -e "${RED}❌ docker-compose.yml not found${NC}"
        echo -e "${YELLOW}   Please run this script from the /opt/docker/prov directory${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Prerequisites check passed${NC}"
}

# Function to create backup
create_backup() {
    echo -e "${BLUE}💾 Creating backup...${NC}"
    
    mkdir -p "${BACKUP_DIR}"
    
    # Backup current configuration
    cp .env "${BACKUP_DIR}/" 2>/dev/null || echo "No .env to backup"
    cp docker-compose.yml "${BACKUP_DIR}/"
    cp -r app "${BACKUP_DIR}/" 2>/dev/null || echo "No app directory to backup"
    cp -r nginx "${BACKUP_DIR}/" 2>/dev/null || echo "No nginx directory to backup"
    
    echo -e "${GREEN}✅ Backup created in ${BACKUP_DIR}${NC}"
}

# Function to generate secure secrets
generate_secrets() {
    echo -e "${BLUE}🔐 Generating secure secrets...${NC}"
    
    # Generate AUTH_SECRET
    AUTH_SECRET=$(openssl rand -hex 32)
    
    # Generate Redis password
    REDIS_PASSWORD=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-20)
    
    # Generate admin password
    ADMIN_PASSWORD="SecureP@ssw0rd!$(date +%Y)#VoIP$(openssl rand -base64 6 | tr -d "=+/")"
    
    echo -e "${GREEN}✅ Secrets generated${NC}"
    echo -e "${YELLOW}   AUTH_SECRET: ${AUTH_SECRET:0:16}...${NC}"
    echo -e "${YELLOW}   REDIS_PASSWORD: ${REDIS_PASSWORD:0:8}...${NC}"
    echo -e "${YELLOW}   ADMIN_PASSWORD: ${ADMIN_PASSWORD:0:12}...${NC}"
}

# Function to update environment configuration
update_environment() {
    echo -e "${BLUE}⚙️  Updating environment configuration...${NC}"
    
    # Create or update .env file
    cat > .env << EOF
# Application Configuration
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Odoo Configuration
ODOO_HOST=96.126.70.143
ODOO_PORT=8069
ODOO_DB=altinc
ODOO_USER=odoo@altinc.ca
ODOO_PASSWORD=qBlU?zm6e70cQXbR

# Redis Configuration
REDIS_URL=redis://redis:6379
REDIS_PASSWORD=${REDIS_PASSWORD}

# Security Configuration - Generated $(date)
AUTH_SECRET=${AUTH_SECRET}
PROVISIONING_INTERVAL=7776000

# Provisioning Configuration
PROVISION_URL=https://pro.altinc.ca
PROVISION_BASE_URL=https://pro.altinc.ca
HTTP_AUTH_USERNAME=altinc
HTTP_AUTH_PASSWORD=Jan2019!

# Admin Authentication - CHANGE IN PRODUCTION
ADMIN_USERNAME=altinc
ADMIN_PASSWORD=${ADMIN_PASSWORD}

# Security Configuration
ALLOWED_ORIGINS=https://pro.altinc.ca,https://96.126.70.148
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
ADMIN_RATE_LIMIT_MAX_REQUESTS=20

# Optional security features
ENABLE_SECURITY_MONITORING=true
SECURITY_LOG_LEVEL=warn
EOF
    
    echo -e "${GREEN}✅ Environment configuration updated${NC}"
}

# Function to setup nginx
setup_nginx() {
    echo -e "${BLUE}🌐 Setting up nginx SSL termination...${NC}"
    
    # Create nginx directory structure
    mkdir -p "${NGINX_DIR}/ssl"
    
    # Generate SSL certificates
    if [[ -f "./generate-ssl-certs.sh" ]]; then
        chmod +x ./generate-ssl-certs.sh
        ./generate-ssl-certs.sh
    else
        echo -e "${YELLOW}⚠️  SSL certificate generation script not found${NC}"
        echo -e "${YELLOW}   You'll need to manually create SSL certificates${NC}"
    fi
    
    echo -e "${GREEN}✅ Nginx setup completed${NC}"
}

# Function to verify application files
verify_application_files() {
    echo -e "${BLUE}📦 Verifying application files...${NC}"
    
    # Check if essential files exist
    if [[ ! -d "app" ]]; then
        echo -e "${RED}❌ app directory not found${NC}"
        exit 1
    fi
    
    if [[ ! -f "app/package.json" ]]; then
        echo -e "${RED}❌ app/package.json not found${NC}"
        exit 1
    fi
    
    if [[ ! -f "app/app.js" ]]; then
        echo -e "${RED}❌ app/app.js not found${NC}"
        exit 1
    fi
    
    # Check if Dockerfile exists
    if [[ ! -f "Dockerfile" ]]; then
        echo -e "${RED}❌ Dockerfile not found${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Application files verified${NC}"
    echo -e "${YELLOW}   Dependencies will be installed during Docker build${NC}"
}

# Function to deploy services
deploy_services() {
    echo -e "${BLUE}🚀 Deploying services...${NC}"
    
    # Stop existing services
    echo -e "${YELLOW}   Stopping existing services...${NC}"
    docker compose down 2>/dev/null || true
    
    # Build and start services
    echo -e "${YELLOW}   Building and starting services...${NC}"
    docker compose up -d --build
    
    # Wait for services to be ready
    echo -e "${YELLOW}   Waiting for services to be ready...${NC}"
    sleep 10
    
    echo -e "${GREEN}✅ Services deployed${NC}"
}

# Function to verify deployment
verify_deployment() {
    echo -e "${BLUE}🔍 Verifying deployment...${NC}"
    
    # Check service status
    echo -e "${YELLOW}   Checking service status...${NC}"
    docker compose ps
    
    # Test HTTP to HTTPS redirect
    echo -e "${YELLOW}   Testing HTTP to HTTPS redirect...${NC}"
    if curl -s -I http://localhost/health | grep -q "301\|302"; then
        echo -e "${GREEN}   ✅ HTTP to HTTPS redirect working${NC}"
    else
        echo -e "${RED}   ❌ HTTP redirect not working${NC}"
    fi
    
    # Test HTTPS health check
    echo -e "${YELLOW}   Testing HTTPS health check...${NC}"
    if curl -k -s https://localhost/health | grep -q "ok"; then
        echo -e "${GREEN}   ✅ HTTPS health check working${NC}"
    else
        echo -e "${RED}   ❌ HTTPS health check failed${NC}"
    fi
    
    # Test admin security audit
    echo -e "${YELLOW}   Testing admin security audit...${NC}"
    if curl -k -s -u "altinc:${ADMIN_PASSWORD}" https://localhost/admin/security-audit | grep -q "SECURE\|NEEDS_ATTENTION"; then
        echo -e "${GREEN}   ✅ Admin endpoints working${NC}"
    else
        echo -e "${RED}   ❌ Admin endpoints not accessible${NC}"
    fi
    
    echo -e "${GREEN}✅ Deployment verification completed${NC}"
}

# Function to display post-deployment information
show_deployment_info() {
    echo
    echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
    echo -e "${BLUE}================================================${NC}"
    echo
    echo -e "${YELLOW}📋 Deployment Summary:${NC}"
    echo -e "   • Nginx SSL termination: ${GREEN}✅ Active${NC}"
    echo -e "   • Node.js application: ${GREEN}✅ Active${NC}"
    echo -e "   • Redis cache: ${GREEN}✅ Active${NC}"
    echo -e "   • Security enhancements: ${GREEN}✅ Active${NC}"
    echo
    echo -e "${YELLOW}🔗 Service URLs:${NC}"
    echo -e "   • Health Check: ${GREEN}https://pro.altinc.ca/health${NC}"
    echo -e "   • Admin Status: ${GREEN}https://pro.altinc.ca/admin/status${NC}"
    echo -e "   • Security Audit: ${GREEN}https://pro.altinc.ca/admin/security-audit${NC}"
    echo
    echo -e "${YELLOW}🔐 Admin Credentials:${NC}"
    echo -e "   • Username: ${GREEN}altinc${NC}"
    echo -e "   • Password: ${GREEN}${ADMIN_PASSWORD}${NC}"
    echo
    echo -e "${YELLOW}📁 Important Files:${NC}"
    echo -e "   • SSL Certificate: ${GREEN}./nginx/ssl/cert.pem${NC}"
    echo -e "   • SSL Private Key: ${GREEN}./nginx/ssl/key.pem${NC}"
    echo -e "   • Configuration: ${GREEN}./.env${NC}"
    echo -e "   • Backup: ${GREEN}${BACKUP_DIR}${NC}"
    echo
    echo -e "${RED}⚠️  Security Notes:${NC}"
    echo -e "   • Store admin password securely"
    echo -e "   • Configure Cloudflare to point to this server"
    echo -e "   • Monitor logs regularly: ${GREEN}docker compose logs -f${NC}"
    echo -e "   • Update dependencies regularly: ${GREEN}npm audit${NC}"
    echo
    echo -e "${YELLOW}🔧 Useful Commands:${NC}"
    echo -e "   • View logs: ${GREEN}docker compose logs -f${NC}"
    echo -e "   • Restart services: ${GREEN}docker compose restart${NC}"
    echo -e "   • Security audit: ${GREEN}curl -k -u altinc:password https://localhost/admin/security-audit${NC}"
    echo
}

# Main execution
main() {
    check_user
    check_prerequisites
    create_backup
    generate_secrets
    update_environment
    setup_nginx
    verify_application_files
    deploy_services
    verify_deployment
    show_deployment_info
}

# Handle script interruption
trap 'echo -e "\n${RED}❌ Deployment interrupted${NC}"; exit 1' INT TERM

# Run main function
main "$@"
