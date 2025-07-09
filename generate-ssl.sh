#!/bin/bash

# Generate self-signed SSL certificates for VoIP provisioning server
# This script creates SSL certificates for nginx SSL termination

set -e

# Configuration
CERT_DIR="./nginx/ssl"
DOMAIN="pro.altinc.ca"
DAYS=365
KEY_SIZE=2048

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🔒 Generating SSL certificates for VoIP provisioning server${NC}"
echo -e "${YELLOW}Domain: ${DOMAIN}${NC}"
echo -e "${YELLOW}Validity: ${DAYS} days${NC}"
echo

# Create SSL directory
mkdir -p "${CERT_DIR}"

# Check if certificates already exist
if [[ -f "${CERT_DIR}/cert.pem" && -f "${CERT_DIR}/key.pem" ]]; then
    echo -e "${YELLOW}⚠️  SSL certificates already exist.${NC}"
    read -p "Do you want to regenerate them? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}✅ Using existing certificates.${NC}"
        exit 0
    fi
    echo -e "${YELLOW}🔄 Regenerating certificates...${NC}"
fi

# Generate private key
echo -e "${GREEN}📝 Generating private key...${NC}"
openssl genrsa -out "${CERT_DIR}/key.pem" ${KEY_SIZE}

# Set proper permissions on private key
chmod 600 "${CERT_DIR}/key.pem"

# Create certificate signing request configuration
cat > "${CERT_DIR}/csr.conf" << EOF
[req]
default_bits = ${KEY_SIZE}
prompt = no
distinguished_name = dn
req_extensions = v3_req

[dn]
C = CA
ST = Newfoundland and Labrador
L = Mount Pearl
O = Altinc Communications
OU = VoIP Infrastructure
CN = ${DOMAIN}

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${DOMAIN}
DNS.2 = *.altinc.ca
DNS.3 = localhost
DNS.4 = 96.126.70.148
IP.1 = 96.126.70.148
IP.2 = 127.0.0.1
EOF

# Generate certificate signing request
echo -e "${GREEN}📋 Generating certificate signing request...${NC}"
openssl req -new -key "${CERT_DIR}/key.pem" -out "${CERT_DIR}/csr.pem" -config "${CERT_DIR}/csr.conf"

# Generate self-signed certificate
echo -e "${GREEN}🔐 Generating self-signed certificate...${NC}"
openssl x509 -req -in "${CERT_DIR}/csr.pem" -signkey "${CERT_DIR}/key.pem" -out "${CERT_DIR}/cert.pem" -days ${DAYS} -extensions v3_req -extfile "${CERT_DIR}/csr.conf"

# Set proper permissions
chmod 644 "${CERT_DIR}/cert.pem"

# Clean up CSR files
rm "${CERT_DIR}/csr.pem" "${CERT_DIR}/csr.conf"

# Verify certificate
echo -e "${GREEN}🔍 Verifying certificate...${NC}"
openssl x509 -in "${CERT_DIR}/cert.pem" -text -noout | grep -E "(Subject:|DNS:|IP Address:|Not Before:|Not After:)"

echo
echo -e "${GREEN}✅ SSL certificates generated successfully!${NC}"
echo
echo -e "${YELLOW}📁 Certificate files:${NC}"
echo -e "   Private Key: ${CERT_DIR}/key.pem"
echo -e "   Certificate: ${CERT_DIR}/cert.pem"
echo
echo -e "${YELLOW}🚀 Next steps:${NC}"
echo -e "   1. Start the services: ${GREEN}docker-compose up -d${NC}"
echo -e "   2. Test HTTPS: ${GREEN}curl -k https://${DOMAIN}/health${NC}"
echo -e "   3. Configure Cloudflare to point to this server"
echo
echo -e "${RED}⚠️  Important Security Notes:${NC}"
echo -e "   • These are self-signed certificates for internal use"
echo -e "   • Cloudflare will provide the public-facing SSL certificate"
echo -e "   • Browsers will show warnings for direct access"
echo -e "   • This is expected and secure for this architecture"
echo
