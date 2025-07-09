# VoIP Provisioning Server

A Node.js/Express-based provisioning server for VoIP phones with support for multiple vendors including Grandstream, Yealink, Polycom, Snom, and Cisco.

## Features

- Multi-vendor phone provisioning (Grandstream, Yealink, Polycom, Snom, Cisco)
- XML-based phone apps for call forwarding, voicemail, conference management
- Redis caching for improved performance
- Rotating token-based authentication
- Integration with Odoo ERP and Kazoo telephony platform
- Admin dashboard with device management
- Prometheus metrics and Grafana Cloud integration
- Docker containerization with nginx reverse proxy

## Supported Devices

- Grandstream GXP series, HT series, DP715
- Yealink T series
- Polycom VVX series
- Snom M300, D735, D785
- Cisco SPA series
- Algo 8301 pager

## Prerequisites

- Docker and Docker Compose
- Odoo instance with kazoo_mgmt module
- Kazoo telephony platform (optional)
- Redis (included in docker-compose)

## Quick Start

1. Clone the repository
2. Copy `.env.example` to `.env` and configure your settings
3. Generate SSL certificates or provide your own in `nginx/ssl/`
4. Run with Docker Compose:

```bash
docker-compose up -d

