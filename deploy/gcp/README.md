# UCBarkley Google Cloud staging

This is the first coworker-beta deployment. It runs the admin portal, API,
worker, inference service, PostgreSQL, and object storage on one Compute Engine
VM. Caddy exposes only HTTPS endpoints. PostgreSQL and MinIO's administrative
port remain private to Docker.

This intentionally favors a small, understandable staging setup over a final
high-availability architecture. The production path can later move the API and
worker to Cloud Run, PostgreSQL to Cloud SQL, media to Cloud Storage, and job
delivery to Pub/Sub without changing the product boundaries.

The inference container deliberately installs CPU-only PyTorch wheels. This
staging VM has no GPU, so CUDA packages would add several gigabytes without
improving inference.

## Current staging deployment

- Project: `project-cc95ba5e-b3d0-4411-9e3` (`UCBarkley Staging`)
- Region/zone: `us-west2` / `us-west2-a`
- VM: `tail-tells-staging`
- Reserved IP: `34.186.154.148`
- Manager portal: `https://app.ucbarkley.com`
- Legacy manager portal: `https://admin.34.186.154.148.sslip.io`
- API: `https://api.34.186.154.148.sslip.io`
- Media endpoint: `https://media.34.186.154.148.sslip.io`
- Backup: daily Compute Engine disk snapshot, retained for seven days

Only ports 80 and 443 are public. SSH is restricted to Google IAP; use
`--tunnel-through-iap` for every SSH or SCP command.

## 1. Protect billing first

1. Enable multi-factor authentication on the Google account.
2. Create a monthly, alert-only billing budget named `UCBarkley staging`.
3. Scope it to the UCBarkley project and all services.
4. Exclude savings and credits so trial credits do not hide gross usage.
5. Set the amount to `$50` and thresholds to 50%, 80%, and 100%.

A budget is an alert, not a hard spending cap.

## 2. Point the CLI at the exact console project

Copy the project ID from the Google Cloud project selector. Do not use the
display name and do not continue while `gcloud config get-value project` shows
another project.

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud auth login
/Users/kaylin/google-cloud-sdk/bin/gcloud projects list
/Users/kaylin/google-cloud-sdk/bin/gcloud config set project YOUR_PROJECT_ID
/Users/kaylin/google-cloud-sdk/bin/gcloud config set compute/region us-west2
/Users/kaylin/google-cloud-sdk/bin/gcloud config set compute/zone us-west2-a
/Users/kaylin/google-cloud-sdk/bin/gcloud config get-value project
```

Verify that billing is enabled:

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud billing projects describe YOUR_PROJECT_ID
```

## 3. Enable Compute Engine and reserve an address

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud services enable compute.googleapis.com
/Users/kaylin/google-cloud-sdk/bin/gcloud compute addresses create tail-tells-staging-ip --region=us-west2
/Users/kaylin/google-cloud-sdk/bin/gcloud compute addresses describe tail-tells-staging-ip --region=us-west2 --format='value(address)'
```

Save the printed IP as `STAGING_IP`.

## 4. Allow HTTPS and create the staging VM

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud compute firewall-rules create tail-tells-allow-web \
  --network=default \
  --allow=tcp:80,tcp:443 \
  --target-tags=tail-tells-web

/Users/kaylin/google-cloud-sdk/bin/gcloud compute instances create tail-tells-staging \
  --zone=us-west2-a \
  --machine-type=e2-standard-2 \
  --boot-disk-size=50GB \
  --boot-disk-type=pd-balanced \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --address=tail-tells-staging-ip \
  --tags=tail-tells-web
```

Do not create firewall rules for ports 3000, 5432, 8000, 9000, or 9001.

Restrict SSH to Google IAP instead of exposing port 22 directly:

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud services enable iap.googleapis.com
/Users/kaylin/google-cloud-sdk/bin/gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member=user:YOUR_GOOGLE_ACCOUNT \
  --role=roles/iap.tunnelResourceAccessor
/Users/kaylin/google-cloud-sdk/bin/gcloud compute firewall-rules create tail-tells-allow-iap-ssh \
  --network=default --direction=INGRESS --priority=1000 --action=ALLOW \
  --rules=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=tail-tells-web
/Users/kaylin/google-cloud-sdk/bin/gcloud compute firewall-rules create tail-tells-deny-public-ssh \
  --network=default --direction=INGRESS --priority=1100 --action=DENY \
  --rules=tcp:22 --source-ranges=0.0.0.0/0 --target-tags=tail-tells-web
```

## 5. Install Docker on the VM

Upload this bootstrap file, connect, and run it:

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud compute scp deploy/gcp/bootstrap-vm.sh tail-tells-staging:/tmp/bootstrap-vm.sh --zone=us-west2-a --tunnel-through-iap
/Users/kaylin/google-cloud-sdk/bin/gcloud compute ssh tail-tells-staging --zone=us-west2-a --tunnel-through-iap
sudo bash /tmp/bootstrap-vm.sh
exit
```

Reconnect after the script finishes so Docker group membership takes effect.

## 6. Place the application on the VM

For the first private beta, push a reviewed Git commit to the repository, then
clone it into `/opt/tail-tells` on the VM. Use a read-only GitHub deploy key if
the repository is private; never paste a personal access token into shell
history.

```bash
cd /opt/tail-tells
git clone YOUR_REPOSITORY_URL .
```

## 7. Configure staging secrets

Copy the template only on the VM:

```bash
cd /opt/tail-tells
cp deploy/gcp/.env.example deploy/gcp/.env
chmod 600 deploy/gcp/.env
```

Set `DOMAIN` to `STAGING_IP.sslip.io`, for example
`34.123.45.67.sslip.io`. Use long random values containing letters and numbers
for all passwords and JWT secrets. The environment file is ignored by Git and
must never be committed.

## 8. Build and start the stack

```bash
cd /opt/tail-tells
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml build
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml up -d
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml ps
```

Check the public endpoints:

```bash
curl https://api.STAGING_IP.sslip.io/health
```

Open `https://app.ucbarkley.com` in a browser. Sign in with a manager or
owner-admin account. Staff credentials are intentionally rejected by the admin
portal. The legacy `https://admin.STAGING_IP.sslip.io` hostname remains
available during the custom-domain transition.

## 9. Create the first organization

If staging has no users yet, run the one-time bootstrap on the VM. It generates
a strong owner password, creates the organization, verifies the authenticated
dashboard, and saves the credentials in an owner-readable file outside Git:

```bash
cd /opt/tail-tells
set -a
. deploy/gcp/.env
set +a
deploy/gcp/create-initial-admin.sh
```

Retrieve the credentials from the Mac without copying them into documentation
or chat:

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud compute ssh tail-tells-staging \
  --zone=us-west2-a --tunnel-through-iap \
  --command='cat /opt/tail-tells/deploy/gcp/initial-admin.txt'
```

That first account is the owner administrator. Then use its access token to
create a separate manager account for the coworker:

```bash
curl -X POST https://api.STAGING_IP.sslip.io/organizations/me/users \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "email": "manager@example.com",
    "password": "replace-with-a-temporary-password",
    "fullName": "Manager Name",
    "role": "manager"
  }'
```

Give each person a separate account. Do not keep shared test passwords for a
coworker beta.

## 10. Day-to-day operations

```bash
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml ps
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml logs --tail=200 api worker inference
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml pull
docker compose --env-file deploy/gcp/.env -f docker-compose.staging.yml up -d --build
```

Stop the VM when a beta is paused to reduce compute charges. Keep the reserved
IP only while it is needed; an unused static address can still incur charges.

From the Mac:

```bash
/Users/kaylin/google-cloud-sdk/bin/gcloud compute instances stop tail-tells-staging --zone=us-west2-a
/Users/kaylin/google-cloud-sdk/bin/gcloud compute instances start tail-tells-staging --zone=us-west2-a
```
