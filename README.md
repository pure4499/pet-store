# UCBarkley

Pet-hotel media and reporting platform with three product surfaces: a Staff
mobile app, an Administrator portal, and a Pet Owner portal. The current
frontend focus is the Staff app: view checked-in pets, capture photos, assign
one or more pets, check coverage, and upload the selected batch for
administrator review.

See `PROJECT_CONTEXT.md` for product boundaries, architecture decisions,
implementation status, and the current roadmap. This README is primarily local
development setup.

For the reviewed POS customer and pet workbook, see
[`docs/pos-customer-migration.md`](docs/pos-customer-migration.md). It records
the source-to-schema mapping, validation findings, unresolved data questions,
and the safe migration sequence. Migrations `0016` through `0018` add normalized
customer-account, contact, address, preference, note, identifier, provider,
service-history, exception, and provenance relations. The idempotent
`npm run import:pos --workspace=apps/api -- ...` command is dry-run by default;
add `--commit` only after reviewing its validation summary.

To browse tables, relationships, and local data directly in VS Code, follow
[`docs/vscode-database-browser.md`](docs/vscode-database-browser.md). The
workspace recommends the PostgreSQL extension and includes tasks for starting
the database and applying migrations.

The Administrator portal also exposes imported records through **Customers**.
Owner administrators and managers can search by owner contact or pet, inspect
the complete normalized customer profile, review unresolved import warnings,
and update core customer, address, and pet fields.

The Customers directory and checksum-verified POS import are deployed to
staging. While signed in as a manager or owner administrator, open
`https://app.ucbarkley.com/?view=customers`. Staging import counts
and reconciliation details are recorded in
[`docs/pos-customer-migration.md`](docs/pos-customer-migration.md).

## Structure

```
apps/
  api/        Node/TypeScript REST API (Express + Postgres)
  worker/     Background photo-processing pipeline (polls for uploaded photos locally;
              production would be triggered by S3 -> SQS instead)
  inference/  Python FastAPI service exposing /detect and /embed (stub models for now —
              see apps/inference/models.py)
  mobile/     Expo (React Native) Staff mobile app — current product focus
  admin/      React/Vite Administrator portal for check-in, AI review, and reports
packages/
  shared-types/  TypeScript types shared by api/worker/mobile
```

## Prerequisites

- Node 22.13+ LTS or Node 24.3+ and npm 10+ (Expo SDK 57 does not support Node 23;
  use the repository `.nvmrc` for the tested Node 22 version)
- Python 3.12+ (3.13 also fine)
- Docker (for local Postgres + MinIO)
- Expo Go app on your phone, or an iOS/Android simulator, for running the mobile app

## Media usage and cost controls

UCBarkley limits media before it reaches object storage so facilities do not
accidentally create an unbounded upload bill:

- Staff-app and Administrator-portal photos are converted to JPEG, resized to a
  maximum 2048-pixel long edge, and saved at 80% quality before upload.
- A photo may be at most 10 MiB after optimization. A video may be at most
  25 MiB. Staff and manager photo batches are limited to 50 items.
- The default source-media allowance is 5 GiB per organization. The API refuses
  a new presigned upload when its declared size would exceed that allowance.
- The manager dashboard shows photo bytes, video bytes, file counts, total
  allowance usage, and warnings at 75%, 90%, and 100%.
- File sizes are recorded when upload authorization is created and reconciled
  when the client confirms completion. Media remains private until the existing
  staff-review, manager-approval, and publication steps are complete.
- The Administrator portal keeps an active batch alive across in-app page
  changes and shows its progress outside the upload page. Browser transfers
  still require the tab to remain open; after a file is confirmed, AI processing
  is server-side and continues independently.

The dashboard currently meters original photo and video uploads. Thumbnails,
detection crops, rendered report videos, request traffic, and owner-download
egress must also be measured from the production object store before this metric
is used for invoicing. Failed or abandoned upload reservations also need a
scheduled cleanup job.

Automatic deletion is intentionally not active yet. Configure object-storage
lifecycle rules only after the business has approved its privacy and retention
policy. The proposed starting policy is: abandoned uploads after 24 hours;
unselected/rejected media after 7–14 days; selected but unpublished media after
30–60 days; published media after 12 months unless the customer purchases an
archive; and identity references while the pet profile remains active. Database
audit records should outlive deleted object bytes where legally appropriate.

For commercial plans, prefer a base facility subscription plus a pet-day tier,
with included processed uploads, retained storage, and owner delivery. Show
75/90/100% warnings and sell predictable allowance blocks instead of exposing
raw cloud-provider line items. Collect at least 30 days of per-tenant usage and
keep infrastructure cost—including storage, egress, AI, and video rendering—at
roughly 15–25% of subscription revenue before finalizing prices.

## First-time setup

```bash
# 1. Install JS dependencies (api, worker, mobile, shared-types)
npm install

# 2. Start local Postgres (with pgvector) and MinIO (S3-compatible storage)
npm run dev:db

# 3. Copy env files
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env

# 4. Run database migrations (creates schema, RLS policies, and the
#    low-privilege pethotel_app role the API/worker actually connect as)
npm run migrate

# 5. Create the local MinIO bucket (one-time; via the console or mc CLI)
#    Console: http://localhost:9001  (user: pethotel / pass: pethotel_dev_secret)
#    Create a bucket named `pet-hotel-photos-dev`.

# 6. Set up the inference service's Python environment
cd apps/inference
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ../..
```

## Running everything

### One-command mobile workflow (recommended)

The root `Makefile` wraps the local database, object storage, migrations, API,
inference service, worker, LAN address, and Expo development server.

For the first iPhone install—or after changing native dependencies or Expo app
configuration—connect and trust the iPhone, then run:

```bash
make mobile-build
```

This command regenerates the iOS project with Xcode-managed automatic signing,
then lets Expo select the Apple development team available on the Mac. Keep the
Apple Account signed in under Xcode Settings > Accounts.

For normal day-to-day development after the development app is installed:

```bash
make mobile
```

The command discovers the Mac's current LAN IP, so moving to another Wi-Fi
network does not require editing a command. If macOS selects the wrong network
interface, override it explicitly with
`make mobile LOCAL_IP=192.168.1.25`. Press Ctrl-C to stop the API, worker,
inference service, and Metro processes started by the command. Postgres and
MinIO remain available for the next run; stop them with `make mobile-down`.

Other useful commands:

```bash
make mobile-setup  # install/update npm and Python dependencies
make mobile-ip     # print the detected LAN IP and mobile API URL
make help          # list all shortcuts
```

For installable iPhone beta builds, TestFlight, and App Store submission, follow
[`docs/ios-app-store-release.md`](docs/ios-app-store-release.md). Release builds
must be run from `apps/mobile` so EAS reads the Staff app configuration rather
than the repository-level development metadata.

Docker Desktop must be running. The iPhone and Mac must be on the same Wi-Fi
for the development client to reach Metro and the API.

### Manual workflow

Four processes, each in its own terminal:

```bash
npm run dev:api                                    # http://localhost:3000
npm run dev:worker                                  # polls for uploaded photos every few seconds
cd apps/inference && .venv/bin/uvicorn main:app --reload --port 8000
cd apps/mobile && npm run start                     # opens Expo dev tools
```

Then, in the Expo dev tools, press `i` for iOS simulator, `a` for Android emulator,
or scan the QR code with Expo Go on a physical device.

- **iOS simulator**: the default `EXPO_PUBLIC_API_URL` (`http://localhost:3000`) works as-is.
- **Android emulator**: set `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000` before starting Expo.
- **Physical device**: set `EXPO_PUBLIC_API_URL=http://<your-machine's-LAN-IP>:3000`.

EXPO_PUBLIC_API_URL=http://10.1.16.108:3000 npm run dev:api

cd apps/mobile
EXPO_PUBLIC_API_URL=http://10.1.16.108:3000 npx expo start --dev-client --lan

## Testing the project step by step

There's no seed data and no automated test suite yet, so testing means walking
the real flow end to end. All four processes from "Running everything" above
must be up first. Steps 1-6 use `curl` so you can verify the API/worker/inference
pipeline on its own; step 7 repeats the same flow through the actual mobile app.

### 1. Create an organization and admin user

```bash
curl -X POST http://localhost:3000/organizations \
  -H 'content-type: application/json' \
  -d '{
    "orgName": "Test Pet Hotel",
    "orgSlug": "test-pet-hotel",
    "adminEmail": "staff@example.com",
    "adminPassword": "password123",
    "adminFullName": "Staff Admin"
  }'
```

Save the `accessToken` from the response — every request below needs it as
`Authorization: Bearer <accessToken>`.

### 2. Register a pet

```bash
curl -X POST http://localhost:3000/pets \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' \
  -d '{"name": "Fido", "species": "dog"}'
```

Save the returned pet `id`.

### 3. Check the pet in (create a session)

```bash
curl -X POST http://localhost:3000/sessions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' \
  -d '{"petId": "<petId>", "sessionType": "boarding"}'
```

Save the returned session `id`. `GET /sessions?status=active` should now list it.

### 4. Add a daily log entry

```bash
curl -X POST http://localhost:3000/sessions/<sessionId>/logs \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' \
  -d '{"entryType": "note", "title": "Settled in", "body": "Ate a full breakfast."}'
```

### 5. Upload a photo

```bash
# 5a. Open a batch
curl -X POST http://localhost:3000/photo-batches \
  -H 'authorization: Bearer <accessToken>'
# -> save batchId

# 5b. Request a presigned upload URL
curl -X POST http://localhost:3000/photos/upload-urls \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' \
  -d '{"batchId": "<batchId>", "files": [{"fileName": "fido.jpg", "contentType": "image/jpeg", "fileSizeBytes": 425000, "width": 1600, "height": 1200}]}'
# -> save photoId and uploadUrl

# 5c. PUT the actual file bytes straight to MinIO
curl -X PUT "<uploadUrl>" -H 'content-type: image/jpeg' --data-binary @/path/to/fido.jpg

# 5d. Tell the API the upload finished (optional client-side signal only)
curl -X POST http://localhost:3000/photos/<photoId>/confirm-upload \
  -H 'authorization: Bearer <accessToken>'
```

### 6. Watch the pipeline pick it up

The local worker polls Postgres every few seconds, so within moments of step 5c
it should detect, crop, embed, and score the photo. Confirm it worked:

```bash
# processing_status should move from "pending" toward "done"
curl -H 'authorization: Bearer <accessToken>' http://localhost:3000/photo-batches/<batchId>

# candidate photo_pet_links for the pet's stay
curl -H 'authorization: Bearer <accessToken>' http://localhost:3000/sessions/<sessionId>/photos
```

You can also watch it happen live in the `npm run dev:worker` terminal.

### 7. Repeat through the mobile app

Sign in with the `staff@example.com` / `password123` credentials from step 1
in the Expo app, then walk the real Staff workflow: pick the facility, see
Fido on the active-pet board, capture or import a photo from the Photos tab,
assign it to Fido (and any other pets in the shot), select it for upload, and
send the batch. The same worker/inference pipeline from step 6 runs underneath,
and the results become visible in the session's Photos tab a few seconds later.

During check-in, the app now offers a separate identity-enrollment step. Add
3–6 current photos or record a video up to 30 seconds. The worker extracts up to six
frames from the video and enrolls only clear frames containing exactly one
detected animal. These check-in references improve later AI suggestions but do
not appear in the administrator's report-media queue or owner reports. The same
workflow is available in the Administrator portal, and can be reopened for any
active stay with **AI photos** / **Update AI photos**.


curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{
    "email": "staff@example.com",
    "password": "password123"
  }'


export ACCESS_TOKEN='paste-the-access-token-here'

Since detection/embedding are currently stubs (see below), treat "does a
candidate link appear and become reviewable" as the thing you're testing, not
"did it recognize the right pet" — real pet recognition isn't implemented yet.

## Notes on what's stubbed vs real

- **Detection/embedding models** (`apps/inference/models.py`) are placeholders —
  they exercise the full pipeline (crop, embed, match, score) without any real
  computer vision yet. Real models come in a later phase; the `/detect` and
  `/embed` HTTP contract they sit behind is what the rest of the system depends
  on, so swapping them in later shouldn't require touching the worker.
- **The worker's queue** (`apps/worker/src/queue/photoQueue.ts`) polls Postgres
  directly instead of a real queue, so the whole pipeline is runnable with no
  AWS account. Production would trigger off an S3 upload event via SQS instead —
  everything downstream of that (the pipeline itself) is unchanged either way.
- **RLS matters here**: the API and worker connect as `pethotel_app`, a
  non-superuser Postgres role created by the migration — this is intentional,
  since Postgres row-level security is silently bypassed for superusers
  regardless of `FORCE ROW LEVEL SECURITY`. Don't point `DATABASE_URL` at the
  `pethotel` superuser role for anything other than running migrations.





Username: pethotel
Password: pethotel_dev_secret
Create bucket: pet-hotel-photos-dev

######################################################################
** Start all services

* Get IP address
ipconfig getifaddr en0

* cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells
npm run dev:db
npm run migrate

* cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells
EXPO_PUBLIC_API_URL=http://192.168.1.138:3000 npm run dev:api

* cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells
npm run dev:worker

* Start Metro with the correct API address
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile
EXPO_PUBLIC_API_URL=http://192.168.1.138:3000 \
npx expo start --dev-client --lan --clear

* test the photo detection inference service
cd apps/inference
.venv/bin/uvicorn main:app --reload --host 0.0.0.0 --port 8000

* clean the preivious Xcode build
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile/ios

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -workspace UCBarkleyStaff.xcworkspace \
  -scheme UCBarkleyStaff \
  -configuration Debug \
  clean
* rebuld with Xcode
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
EXPO_PUBLIC_API_URL=http://192.168.1.138:3000 \
npx expo run:ios --device

######################################################################
* env:
S3_ENDPOINT=http://192.168.1.138:9000

* Start Metro
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile
CURRENT_IP=$(ipconfig getifaddr en0)

EXPO_PUBLIC_API_URL=http://$CURRENT_IP:3000 \
npx expo start --dev-client --lan -c

* rebuld with Xcode
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile
CURRENT_IP=$(ipconfig getifaddr en0)

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
EXPO_PUBLIC_API_URL=http://$CURRENT_IP:3000 \
npx expo run:ios --device

Open UCBarkley Staff on your iPhone.

* npm run
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells
npm run dev:api

# Terminal 1
npm run dev:api

# Terminal 2
npm run dev:worker

# Terminal 3
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/inference

.venv/bin/uvicorn main:app \
  --reload \
  --host 0.0.0.0 \
  --port 8000


* clean the preivious Xcode build
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/mobile/ios

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild \
  -workspace UCBarkleyStaff.xcworkspace \
  -scheme UCBarkleyStaff \
  -configuration Debug \
  clean

* reset the failed photos from latest batch
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells

docker compose exec -T postgres \
  psql -U pethotel -d pethotel \
  -c "
    UPDATE photos
    SET processing_status = 'uploaded',
        processing_error = NULL
    WHERE batch_id = (
      SELECT id
      FROM photo_batches
      WHERE organization_id = 'e9312919-00c1-4aa0-a341-8a85ecafe819'
      ORDER BY started_at DESC
      LIMIT 1
    )
    AND processing_status = 'failed';
  "




Confirm it exists without printing it:
echo ${#ACCESS_TOKEN}
Then immediately create the session:
export PET_ID='f39f6ce8-d3d6-49d8-b14a-bce174a79a26'

curl -X POST http://localhost:3000/sessions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"petId\":\"$PET_ID\",\"sessionType\":\"boarding\"}"
Please avoid pasting the token directly into commands or screenshots. For future curl testing, rerun the login/export command whenever you receive Invalid or expired token. The mobile app should handle refresh tokens separately.


* Run the test
cd /Users/kaylin/Documents/Projects/Kaylin/tail-tells/apps/inference
.venv-ai-test/bin/python ai-test/evaluate.py

* Run the test with stricker setting
.venv-ai-test/bin/python ai-test/evaluate.py \
  --unknown-score-threshold 0.80 \
  --unknown-margin-threshold 0.05

* Generate new refresh accessToken
export ACCESS_TOKEN="$(
  curl -s -X POST http://localhost:3000/auth/login \
    -H 'content-type: application/json' \
    -d '{"email":"staff@example.com","password":"password123"}' |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])'
)"

* Add more pet
curl -X POST http://localhost:3000/pets \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "name":"Bella",
    "species":"dog",
    "breed":"Unknown",
    "colorMarkings":"Add a short visual description here"
  }'

  * Check pet in
export SESSION_ID='ab1b05de-54ee-4622-bbb5-df83b1e5792c'

curl -X POST http://localhost:3000/sessions \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"petId\":\"$SESSION_ID\",\"sessionType\":\"boarding\"}"

* Confirm active pet
  curl \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  "http://localhost:3000/sessions?status=active"

* List candidate videos:
curl -s "http://localhost:3000/sessions/$SESSION_ID/videos?state=candidate" \
  -H "authorization: Bearer $ACCESS_TOKEN"

- Copy the video-link id, not video_id:
export VIDEO_LINK_ID='paste-video-link-id-here'

- Publish it:

curl -X POST "http://localhost:3000/sessions/$SESSION_ID/videos/publish" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"videoLinkIds\":[\"$VIDEO_LINK_ID\"]}"

* Generate the 15-second video
curl -s -X POST \
  "http://localhost:3000/sessions/$SESSION_ID/report-videos" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "targetSeconds": 15,
    "title": "Fido'\''s Happy Day",
    "closingCaption": "Played with friends and had a wonderful afternoon."
  }'

  - Copy the returned draft id:
  export DRAFT_ID='paste-draft-id-here'

  - Get and watch the preview
  curl -s "http://localhost:3000/report-videos/$DRAFT_ID" \
  -H "authorization: Bearer $ACCESS_TOKEN"






/Users/kaylin/google-cloud-sdk/bin/gcloud compute ssh tail-tells-staging \
  --zone=us-west2-a \
  --tunnel-through-iap \
  --command='cat /opt/tail-tells/deploy/gcp/initial-admin.txt'



Portal: https://admin.34.186.154.148.sslip.io

Retrieve the initial staging credentials from the VM using the command above.
