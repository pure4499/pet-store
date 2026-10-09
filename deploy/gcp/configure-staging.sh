#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <reserved-ip> <certificate-email>"
  exit 1
fi

staging_ip="$1"
certificate_email="$2"
config_path="deploy/gcp/.env"

if [[ -e "${config_path}" ]]; then
  echo "${config_path} already exists; refusing to overwrite staging secrets."
  exit 1
fi

cp deploy/gcp/.env.example "${config_path}"
chmod 600 "${config_path}"

postgres_password="$(openssl rand -hex 32)"
app_database_password="$(openssl rand -hex 32)"
minio_password="$(openssl rand -hex 32)"
jwt_access_secret="$(openssl rand -hex 48)"
jwt_refresh_secret="$(openssl rand -hex 48)"

sed -i \
  -e "s|^DOMAIN=.*|DOMAIN=${staging_ip}.sslip.io|" \
  -e "s|^CADDY_EMAIL=.*|CADDY_EMAIL=${certificate_email}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${postgres_password}|" \
  -e "s|^APP_DATABASE_PASSWORD=.*|APP_DATABASE_PASSWORD=${app_database_password}|" \
  -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=${minio_password}|" \
  -e "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=${jwt_access_secret}|" \
  -e "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=${jwt_refresh_secret}|" \
  "${config_path}"

echo "Created ${config_path} with restricted permissions for ${staging_ip}.sslip.io."
