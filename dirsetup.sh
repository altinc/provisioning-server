#!/bin/bash

# Create the host directories
sudo mkdir -p /opt/docker/prov/templates
sudo mkdir -p /opt/docker/prov/files/fw
sudo mkdir -p /opt/docker/prov/files/devices
sudo mkdir -p /opt/docker/prov/files/assets

# Copy existing templates from your current setup
if [ -d "./templates" ]; then
    echo "Copying existing templates..."
    sudo cp -r ./templates/* /opt/docker/prov/templates/
fi

# Copy existing files if they exist
if [ -d "./app/files" ]; then
    echo "Copying existing files..."
    sudo cp -r ./app/files/* /opt/docker/prov/files/
fi

# Set proper ownership and permissions
# The container runs as user ID 1001 (provisioning user)
sudo chown -R 1001:1001 /opt/docker/prov/templates
sudo chown -R 1001:1001 /opt/docker/prov/files

# Set permissions: 
# - Templates: read/write for container user, readable by others
# - Files: read/write for container user, readable by others
sudo chmod -R 755 /opt/docker/prov/templates
sudo chmod -R 755 /opt/docker/prov/files

# Make firmware, devices, and assets directories writable for uploads
sudo chmod -R 775 /opt/docker/prov/files/fw
sudo chmod -R 775 /opt/docker/prov/files/devices
sudo chmod -R 775 /opt/docker/prov/files/assets

echo "Host directories prepared:"
echo "- Templates: /opt/docker/prov/templates"
echo "- Files: /opt/docker/prov/files"
echo "  - Firmware: /opt/docker/prov/files/fw"
echo "  - Device Images: /opt/docker/prov/files/devices"
echo "  - Assets: /opt/docker/prov/files/assets"

# List the directories to verify
echo -e "\nDirectory structure:"
sudo find /opt/docker/prov -type d -exec ls -ld {} \;
