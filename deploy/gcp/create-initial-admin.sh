#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-https://api.${DOMAIN:?DOMAIN is required}}"
ADMIN_URL="${ADMIN_URL:-https://admin.${DOMAIN}}"
ADMIN_EMAIL="${ADMIN_EMAIL:-ucbarkley.ai@gmail.com}"
ADMIN_NAME="${ADMIN_NAME:-UCBarkley Admin}"
ORG_NAME="${ORG_NAME:-UCBarkley Test Facility}"
ORG_SLUG="${ORG_SLUG:-ucbarkley-test-facility}"
CREDENTIALS_FILE="${CREDENTIALS_FILE:-/opt/tail-tells/deploy/gcp/initial-admin.txt}"

if [[ -e "$CREDENTIALS_FILE" ]]; then
  echo "Initial admin credentials already exist at $CREDENTIALS_FILE; refusing to overwrite them."
  exit 0
fi

admin_password="$(openssl rand -hex 24)"
request_file="$(mktemp)"
response_file="$(mktemp)"
trap 'rm -f "$request_file" "$response_file"' EXIT

ORG_NAME="$ORG_NAME" ORG_SLUG="$ORG_SLUG" ADMIN_EMAIL="$ADMIN_EMAIL" \
  ADMIN_NAME="$ADMIN_NAME" ADMIN_PASSWORD="$admin_password" \
  python3 - "$request_file" <<'PY'
import json
import os
import sys

with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(
        {
            "orgName": os.environ["ORG_NAME"],
            "orgSlug": os.environ["ORG_SLUG"],
            "adminEmail": os.environ["ADMIN_EMAIL"],
            "adminPassword": os.environ["ADMIN_PASSWORD"],
            "adminFullName": os.environ["ADMIN_NAME"],
        },
        output,
    )
PY

status="$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --request POST "$API_URL/organizations" \
  --header 'content-type: application/json' \
  --data-binary "@$request_file")"

if [[ "$status" != "201" ]]; then
  echo "Initial organization creation failed with HTTP $status:"
  python3 - "$response_file" <<'PY'
import json
import sys

try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
    print(body.get("error", "Unknown API error"))
except Exception:
    print("The API returned a non-JSON error response.")
PY
  exit 1
fi

access_token="$(python3 - "$response_file" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["accessToken"])
PY
)"

dashboard_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  "$API_URL/admin/dashboard" --header "authorization: Bearer $access_token")"
if [[ "$dashboard_status" != "200" ]]; then
  echo "Admin was created, but dashboard verification failed with HTTP $dashboard_status."
  exit 1
fi

umask 077
{
  printf 'Portal: %s\n' "$ADMIN_URL"
  printf 'Email: %s\n' "$ADMIN_EMAIL"
  printf 'Password: %s\n' "$admin_password"
} > "$CREDENTIALS_FILE"

echo "Initial organization and owner admin created."
echo "Authenticated dashboard check passed."
echo "Credentials saved with owner-only permissions at $CREDENTIALS_FILE."
