# UCBarkley project context

This document is the durable, portable context for UCBarkley. It is intended
for both coding agents working in the repository and ChatGPT project chats.
Keep it concise and update it when the product direction, architecture, or
implementation state materially changes.

## Product summary

UCBarkley is a pet-hotel media and reporting platform with three separate
product surfaces:

1. A Staff mobile app for capturing, tagging, selecting, and uploading photos
   while caring for pets.
2. An Administrator portal for correcting assignments, preparing reports and
   videos, approving content, and publishing it.
3. A Pet Owner portal for viewing approved photos, reports, videos, and history.

The central product promise is to reduce repetitive staff work without removing
human control. Staff provide reliable on-site context, administrators own the
final editorial decision, and pet owners see only approved content.

## Product surfaces and workflows

### 1. Staff mobile app — active focus

The Staff app is owned and developed as the current priority. Its required
workflow is:

1. Log in.
2. Select a facility.
3. View the pets currently checked in at that facility.
4. Take photos, record short clips, or add media from the device library.
5. Upload selected photos for asynchronous AI detection and identity suggestions.
6. Double-check the AI-selected pets, correcting or adding pets for group media.
7. Choose which media should be used.
8. See the selected-photo count for every pet.
9. Identify pets that still need more photos.
10. Upload only the selected, assigned photos for administrator review.

An organization may operate multiple physical facilities. Staff accounts have
explicit many-to-many facility assignments, choose an assigned location before
entering the mobile workspace, and may switch locations from More. Active pets,
expected arrivals, new check-ins, capture choices, and coverage are scoped to
that selected location. Owner administrators manage locations and assignments
without changing the organization tenant boundary.

Staff selection is a recommendation to the administrator, not approval or
publication.

Mobile check-in is offline-resilient. The Staff app saves a check-in operation
to a device-local queue before contacting the API, retries when connectivity
returns, on app resume, and during best-effort operating-system background
execution, and shows pending or attention-required work on the Check In page.
Every queued pet has a stable client check-in UUID stored on the session so a
retry after a lost response resolves to the original stay instead of creating a
duplicate. Background timing remains controlled by iOS/Android; a force-quit
iOS app resumes its durable queue when staff next open it.

The SDK 57 mobile build opts into UIKit scene lifecycle support through
`expo-build-properties`. Keep `ios.enableSceneSupport` enabled: Xcode 27/iOS 27
builds fail at launch without the generated scene manifest and Expo scene
delegate.

### 2. Administrator portal

Administrators need to:

- review the photos selected by staff;
- correct pet assignments;
- make the final photo selection for each report;
- identify pets with insufficient photo coverage;
- review report drafts;
- preview generated videos;
- approve and publish the final content.
- maintain a reusable service/product catalog and an auditable charge sheet for
  each stay before handing payment to the shop's connected payment provider.

The repository contains a dedicated React/Vite Administrator portal in
`apps/admin` for this workflow, including check-in, identity enrollment,
multi-file AI review, reporting, publishing, user access management, and a
paginated customer directory. Managers can search owners or pets, inspect the
normalized household and pet relationships, review imported addresses, notes,
flags, identifiers, care providers, service milestones, and unresolved import
warnings, and edit core owner and pet profile information.

### 3. Pet Owner experience — share-link landing page implemented

Pet owners need to:

- view approved photos;
- read reports;
- watch an approximately 30-second video;
- browse previous reports.

The owner experience must expose approved content only. Published reports now
receive persistent, unguessable UUID share links. Managers can email the link
to the pet's owner or copy it for another delivery channel, and family members
with the link can open a responsive public report page. The email contains no
embedded report media. A dedicated authenticated Pet Owner portal and customer
account model are still not implemented.

Staging can set `REPORTS_TEST_RECIPIENT` to route every report-share email to a
single test inbox. While this guardrail is set, saved owner addresses are never
used for report delivery; production owner delivery requires explicitly
removing the override.

Report email delivery supports SendGrid through `SENDGRID_API_KEY` and Resend
through `RESEND_API_KEY`, with SendGrid taking precedence when both are set.
Provider credentials and the verified sender address are runtime configuration,
never source constants. Staging keeps `REPORTS_TEST_RECIPIENT` enabled so owner
addresses cannot receive beta messages accidentally.

### Supporting operational data

The existing platform also models organizations, staff accounts, owners,
households, pets, boarding/daycare sessions, optional collar assignments, and
daily care logs. These are shared platform capabilities, not a reason to mix
the three frontend responsibilities.

## Architecture

UCBarkley is an npm-workspace monorepo with four applications and one shared
package:

| Area | Technology | Responsibility |
| --- | --- | --- |
| `apps/mobile` | Expo 57, React Native, Expo Router, React Query | Staff mobile app; current product focus |
| `apps/api` | Node 22.13+, TypeScript, Express, Zod | REST API, authentication, tenant-scoped CRUD, uploads, review and publishing |
| `apps/worker` | Node 22.13+, TypeScript, PostgreSQL, Sharp | Asynchronous photo processing, matching, quality scoring, ranking |
| `apps/inference` | Python, FastAPI, NumPy | Stable `/detect` and `/embed` model-service boundary |
| `packages/shared-types` | TypeScript | Domain types shared by API, worker, and mobile |

The dedicated Administrator frontend is implemented in `apps/admin`; the Pet
Owner frontend remains planned. Keep the shared API, worker, inference service,
and domain package in this monorepo rather than moving them into one frontend
project.

The worker runtime includes an explicit DejaVu font package for Sharp-rendered
report title and closing cards. Do not rely on fonts inherited from a developer
machine; missing container fonts render report-video text as empty boxes.
Report videos can also include one of five original, bright major-key
instrumental beds synthesized at render time, or no music. The arrangements
use 136–152 BPM tempos, short melodic phrases with breathing room, chord and
bass pulses, and light handclap/shaker percussion so the default mood is
active, playful, and joyful
rather than calm or sentimental. The choices are intentionally arranged as
different kid-friendly musical identities instead of tempo variants: bouncing
ukulele with handclaps, xylophone with a skipping beat, marimba with shaker,
toy glockenspiel in a dancing 6/8 feel, and toy piano with a lively parade
beat. The selected style is stored with the
draft so previews and published videos remain reproducible; no recorded samples
or third-party music assets are bundled. The Administrator portal synthesizes
the same chord progressions in the browser so managers can listen before making
a selection. Reports also offer an experimental visual treatment stored with
the draft: the standard clean presentation, playful dotted sticker frames, or
cartoon-style title lettering. The clean treatment remains the default.

Local infrastructure is PostgreSQL 16 with pgvector plus MinIO for
S3-compatible object storage. Docker Compose starts both services.

The intended production photo flow is:

```text
mobile -> presigned S3 upload -> S3 event -> SQS -> worker
                                             |
                                             v
                                  inference service
                                             |
                                             v
                              PostgreSQL + derived S3 assets
```

Local development replaces S3-to-SQS delivery with a PostgreSQL poller while
keeping the downstream pipeline independent of the queue implementation.

## Core data model

- An `organization` is the tenant boundary.
- A `facility` is a physical operating location inside an organization. Every
  stay belongs to one facility, while a staff user may be assigned to several.
  Existing organizations are migrated with one default facility so historical
  stays and users remain available.
- A `role` is an organization-owned access definition. Each user has one
  explicit `user_role_assignment`; authorization still uses the stable
  `owner_admin`, `manager`, and `staff` role slugs.
- A `household` can group multiple owner contacts and their pets.
- Imported customer and pet records retain their source-system identifiers and
  audit metadata in tenant-scoped external-ID tables, allowing repeatable,
  idempotent migrations without replacing UCBarkley UUID primary keys.
- A `session` is one discrete boarding or daycare stay for a pet. Phone
  reservations use that same row with `reserved` status, a scheduled arrival,
  and no actual check-in timestamp; starting the reservation transitions it to
  `active` and records the real arrival instead of creating a second stay.
- A collar belongs to an organization's palette and may be assigned to an
  active session. New collar labels expose an `ucbarkley://collar/<uuid>` QR
  payload so Staff can scan the physical collar during mobile check-in instead
  of identifying its color by eye. The scanner still accepts UUIDs embedded in
  legacy `tailtells://` labels so already-printed collars remain usable. The
  checked-in pet list shows the assigned
  color name and swatch. Each organization starts with Red, Blue, Green,
  Yellow, and Orange collars. Managers register additional physical collars
  and download their generated QR labels from the Administrator portal's
  dedicated Collar management page. A partial unique index prevents the same
  collar color from being assigned to two active sessions in one organization.
- A `photo` is the original uploaded image. A `photo_detection` represents one
  detected animal crop and carries its embedding, quality, and match result.
- A `photo_pet_link` is the curated association between a photo, pet, and
  session. Its review state moves among pending, candidate, rejected, and
  published.
- `pet_reference_embeddings` provide the matching corpus.
- `photo_match_corrections` retain staff corrections as future training data.
- A `video` is a staff-recorded source clip, and `video_pet_links` preserve its
  one-or-many pet assignments and administrator review state.
- A `report_video_draft` is a queued, rendered, approved, or published 10-15
  second highlight assembled from real approved media and daily-log text.

## Durable technical decisions

### Tenant isolation

Tenant isolation is defense in depth:

- Application queries explicitly filter by `organization_id`.
- `withOrgScope` establishes `app.current_org_id` in the transaction.
- PostgreSQL row-level security is enabled and forced on tenant-owned tables.
- Runtime connections use the low-privilege `pethotel_app` role because a
  PostgreSQL superuser would bypass RLS.

Any new tenant-owned table must include `organization_id`, an RLS policy, and
appropriate privileges. Any new tenant-owned query must remain explicitly
organization-scoped.

### Photo automation is asynchronous and reviewable

Image processing does not run inside upload API requests. Selected photos are
stored as unpublished media, processed asynchronously, and returned to the
Staff app with AI identity suggestions selected by default. Staff explicitly
confirm or correct every selected photo before handoff. Low-confidence matches
remain visibly flagged for human review. Background re-ranking must preserve
manual choices, and normal review updates must not mutate published links.
Administrator final media selection is saved atomically: selected unpublished
links are published while unselected links are explicitly rejected. Removing
an uploaded report photo is a separate, strongly confirmed manager operation;
it soft-deletes the upload, immediately hides it from staff/owner galleries,
rejects its links, and deactivates reference embeddings while retaining audit
data and object bytes for recovery. Already-rendered report videos are not
retroactively edited.

The intended responsibility handoff is:

```text
Staff capture + assignment + preselection
                    |
                    v
Administrator correction + final selection + approval
                    |
                    v
Pet Owner approved gallery + report + video
```

Ready, failed, and approved report drafts remain private and may be deleted by
an administrator. Published reports are owner-visible records and are protected
from the ordinary draft-deletion workflow.

### Matching is constrained by stay timing

Candidate matching is limited to pets whose non-cancelled session covers the
photo's capture time. This keeps the search set small and prevents a pet that
was not present from winning a visual match.

Pet appearance embeddings remain the primary identity signal. For
similar-looking pets, the worker may use a clearly visible, brightly colored
leash as a bounded secondary tie-breaker. The color reference is accepted only
from an identity photo tied to the pet's current stay, and only when both that
check-in image and the new image contain a high-confidence narrow color region
near the detected pet. Missing leash evidence is neutral; color can move a
candidate's ranking by only a few points and cannot make a weak appearance
match pass the identity threshold. The detected accessory attributes and score
adjustment are stored on the detection for review and future evaluation.

### Model hosting is replaceable

The worker depends only on the inference service's HTTP contracts:

- `POST /detect` accepts image bytes and returns normalized bounding boxes,
  confidence, and a species guess.
- `POST /embed` accepts crop bytes and returns a normalized 512-dimensional
  storage vector plus its model version and dimension metadata.

The local development backend uses a pretrained SSDLite dog/cat detector and a
ResNet-18 visual embedding baseline. A selectable DINOv2 ViT-S/14-with-registers
embedder is available for controlled evaluation and rollout. Its normalized
384-dimensional feature is zero-padded to the existing 512-wide storage shape,
which preserves cosine similarity. Every detection and reference records the
model version, and matching filters to that version so incompatible ResNet and
DINOv2 feature spaces are never compared. The detector remains independent;
DINOv2 improves identity representation after a pet crop is found and does not
fix missed pet detections. Neither baseline is fine-tuned individual-pet
recognition yet.

The repository's small labeled identity set currently contains 16 known-pet
queries across three pets and six unknown queries. On that set, DINOv2 ranked
the correct identity first for 16/16 known queries (the ResNet baseline ranked
15/16). DINOv2's independently calibrated 0.50 similarity and 0.10 runner-up
margin gates produced 22/22 correct known/unknown decisions on this limited
set. These numbers validate a controlled rollout, not production accuracy;
confirmed staff corrections must continue expanding the evaluation set.

Identity-reference processing de-duplicates overlapping detector boxes and
ignores weak secondary/background proposals when one strong pet is present.
Distinct, credible second-pet detections still block automatic enrollment so a
true group frame cannot contaminate an individual pet's reference identity.
Inference species labels are normalized to the database vocabulary
(`dog`, `cat`, or `unknown`). When staff explicitly uploads a good-quality,
single-pet check-in photo and the generic detector supplies only its
conservative whole-frame fallback, that direct photo may still enroll for the
assigned pet. Extracted video frames require a real dog/cat detection because a
whole-frame fallback cannot reliably reject partial-body moments; the fallback
also remains review-only for ordinary report media. A single real dog/cat
proposal from explicit check-in media may enroll below the normal detector
confidence gate only when its crop is large and high-quality. This guarded path
retains useful side-profile and freshly groomed pets while excluding tiny
background proposals and the whole-frame fallback.

Identity references and report media remain separate records. A manager may
explicitly promote a strong check-in photo or extracted frame into a new,
private report candidate. The copied report-media row retains lineage to the
identity source, requires the normal final photo-selection step before becoming
owner-visible, and can be managed independently without turning a weak identity
detection into training data.

ResNet similarity is ranking evidence, not an identity probability. The worker
uses a conservative absolute gate when only one pet has references, and requires
both similarity and a first-versus-second margin when multiple identities can be
compared. Ambiguous results remain unknown or explicitly uncertain for human
review instead of inheriting the nearest available pet.

### Staff feedback improves future matching

Confirmed detections can become reference embeddings, and incorrect suggestions
are recorded as corrections. The long-term design should preserve these signals
for evaluation and model improvement.

### Media cost control starts before upload

Staff and manager clients normalize photos to JPEG at an 80% quality setting
and a maximum 2048-pixel long edge. The API enforces 10 MiB photo, 100 MiB video,
30-second source-video, and 50-photo batch limits, records declared bytes before issuing upload URLs,
and applies a configurable per-organization source-media allowance (5 GiB by
default). The Administrator dashboard exposes source photo/video usage and
75/90/100% warning states. This application-level meter is an operational
guardrail, not the billing source of truth: production billing must reconcile
derived assets, rendered reports, egress, AI work, abandoned uploads, and the
object store's own inventory and usage metrics.

The Administrator upload workspace stays mounted across in-app navigation and
surfaces background progress on other pages. The browser must remain open while
source bytes are transferring. Once each upload is confirmed, asynchronous AI
processing is owned by the worker and no longer depends on the upload page.

No automatic object deletion is enabled until retention and privacy policy are
approved. Lifecycle expiry belongs in object-storage policy and a scheduled
cleanup/reconciliation process rather than synchronous API requests.

## Current implementation state

Implemented foundations include:

- Organization creation and staff authentication.
- Tenant-scoped normalized roles and user-role assignments. Owner administrators
  can create individual accounts, assign roles, and disable or reactivate users
  from the Administrator portal; the final active owner administrator cannot be
  disabled or demoted. Every manager-portal user has a profile and can change
  their own password after confirming the current password. Owner administrators
  can reset another user's password. Password changes increment an authentication
  version so existing refresh sessions must sign in again.
- Owners, households, pets, sessions, collar assignment, and daily logs.
- A tenant-scoped commerce foundation with reusable service/product catalog
  items, one charge sheet per stay, immutable line-item name and price
  snapshots, integer-cent totals, and an append-only event trail. The
  Administrator portal includes a shop operations workspace where managers can
  maintain active and inactive catalog items, see current stays with their
  running totals, and open the relevant stay workspace. Managers can add,
  adjust, and remove charges in that stay workspace. Card processing is
  deliberately not connected yet: UCBarkley retains pet and stay context,
  while each shop's eventual payment provider remains the merchant-facing
  system of record for payments, refunds, and payouts.
- Daily reports retain every care-timeline event recorded for the selected
  report date. Timeline events do not consume the 10–15 second highlight-video
  duration because the renderer uses only photo and video items for timing.
- A normalized migration foundation that keeps customer accounts, contacts,
  addresses, communication preferences, household classifications, pets,
  identifiers, care providers, provider relationships, and historical service
  milestones in separate tenant-scoped relations. Import batches and external
  IDs preserve provenance and support audited, idempotent POS migrations. The
  reviewed workbook mapping, repeatable CLI importer, validation gates, and
  local and staging reconciliation are documented in
  `docs/pos-customer-migration.md`. A checksum-verified local import into the
  `Test Pet Hotel` organization completed on September 25, 2026, followed by a
  staging import into `UCBarkley Test Facility` on September 27, 2026.
  Production customer data has not been imported.
- Shared structured care-log presets for feeding, fresh water, potty, walks,
  playtime, rest, medication, grooming, and social behavior. Staff and managers
  can record these consistently from the mobile app or Administrator portal,
  add optional context, and retain the author and timestamp for report use.
- Household report-email auditing.
- Direct-to-object-storage photo uploads using presigned URLs.
- A local asynchronous worker and the end-to-end processing pipeline.
- Thumbnail and crop creation, quality scoring, matching, candidate ranking,
  manual assignment, review states, and publishing endpoints.
- Detection uses a two-tier threshold: strong dog/cat proposals can participate
  in automatic matching, while weak proposals and a conservative whole-frame
  fallback remain review-only. This keeps close-up, overhead, and unusually
  groomed pets visible for manager confirmation instead of silently skipping
  the upload. The only exception is explicit, good-quality, single-pet check-in
  enrollment from a directly selected photo, where the staff assignment can
  authorize the fallback as a private identity reference. Extracted video
  frames require a real dog/cat detection; a lower-confidence detection is
  accepted only when it is the sole large, high-quality proposal. The fallback
  can never auto-publish report media.
- An Expo Staff app with login, an assigned-facility selection step, active-pet
  board, persisted assigned-facility selection and switching, local photo
  drafts, camera/library intake, one-or-many pet assignment,
  staff selection, per-pet coverage, and selected-batch upload. Mobile library
  intake converts HEIC/HEIF images to JPEG before preview and upload. Staff can
  also add a pet under an existing owner found during check-in and record both
  the date and time of an earlier care update. Check-in is a primary mobile tab:
  staff can start expected arrivals, find existing pets by owner/contact data,
  register new pets, check in same-household pets together, assign stay details,
  and continue directly into private identity enrollment. The primary mobile
  navigation is Pets, Capture, Check In, and More; photo coverage remains a
  workflow screen rather than duplicating the pet list as a permanent tab. The active-pet board uses
  tenant-scoped server photo counts and latest-photo thumbnails rather than
  device-local draft counts, so multiple staff devices see the same confirmed
  media state; it refreshes after confirmation and polls for coworker changes.
  Pet avatars in both the Staff mobile app and Administrator portal prefer the
  highest-quality pet-specific detection crop from check-in identity media,
  then fall back to a confirmed report crop, a regular photo, and finally the
  pet's initial. Mobile coverage uses
  the same confirmed server count across staff devices and adds this device's
  clearly labeled, unsent selected drafts only until they are confirmed. Daily
  log history and its care-update composer share one keyboard-aware scroll
  surface so note, date, time, and save controls remain reachable while typing.
- Mobile and Administrator uploads optimize photos before transfer, reject
  oversized files (videos are capped at 100 MB), cap batch size, reserve tenant usage before issuing upload
  URLs, and display source-media allowance usage on the manager dashboard.
- Shared TypeScript domain types.
- Tenant-scoped PostgreSQL schema and RLS policies.
- Five owner-report template directions—storybook, care card, timeline diary,
  photo journal, and warm postcard—are implemented as complete Administrator
  portal previews based on the approved report samples. Each layout combines
  at least three approved photos, care-log content, a closing message, and the
  rendered 10-15 second highlight as one playable media block inside the report.
  Published reports can be delivered through a shareable owner link.
- Staff can capture/import short video clips, explicitly assign every pet shown,
  and upload those clips for administrator review.
- Managers can also upload MP4 or MOV clips from the Administrator import page,
  assign them directly to an active stay, and approve candidate clips in the
  pet report workspace. The page accepts mixed photo/video selections and can
  assign multiple videos from one selection; a generated report currently uses
  at most one approved clip.
- Uploads started from an individual pet's report desk include that pet and
  active stay in the upload request. The API validates the tenant-scoped pair
  and creates the candidate photo/video link in the same transaction as the
  media record, so processing cannot leave the upload unassigned.
- Managers can request a vertical 10-15 second report-video draft through the
  API. The asynchronous worker uses FFmpeg to assemble approved photos, at most
  one approved clip, and daily-log text into a reviewable MP4. Approval and
  publication remain explicit, separate transitions. Each report requires at
  least three reviewed photos and offers storybook, timeline diary, care card,
  photo journal, and postcard themes that affect the rendered video styling.
  Managers can opt in (enabled by default) to let report creation copy up to
  two high-quality, single-pet check-in frames into the private draft. Those
  copies remain private report candidates and do not become owner-visible
  gallery photos without the normal manager publication step.
- Report publication frequency is independent from stay length. When creating a
  report, managers choose whether AI ranks approved photos, clips, and care
  moments from the report day, the last two days, the last three days, or the
  entire stay. The chosen window is stored with the draft so later previews and
  owner-visible reports preserve the same source scope.
- The Administrator portal initializes report dates from the manager's local
  calendar, not UTC. If approved photos exist but fall outside the chosen date
  window, the main-image picker explains the mismatch and offers to switch to
  the latest approved photo date instead of incorrectly saying no photos exist.
- New report drafts include a warm, reviewable story generated from grounded
  report facts. Named companion pets come only from confirmed, published
  assignments on the photos and video selected for that report, while activity
  phrases come only from staff-recorded care moments. The narrative and its
  supporting facts are stored on the draft for manager review; the system does
  not guess friendship, mood, or activities from pixels alone.
- Published reports have persistent UUID bearer links to a responsive public
  owner view containing only published report media and care entries. Managers
  can email or copy the link; email deliveries are audited, while SMS delivery
  remains planned. Anyone holding a link can view it, so links are excluded
  from search indexing and must be treated as private.
- A dedicated React/Vite Administrator portal provides a tenant-scoped care
  dashboard, customer-first lookup by owner name/phone/email or pet at check-in,
  owner contact plus pet registration, manager-entered phone reservations,
  reservation-to-check-in conversion, active-stay check-out,
  multi-file photo import into the asynchronous AI pipeline, batch-specific
  match-rate results, an AI review queue, multi-pet correction, quick approval,
  and a guided final-selection-to-publication flow that explicitly warns when
  media becomes owner-visible. It also provides a per-stay diary/media workspace
  and a gated themed-report flow: render, private full-report preview, approval,
  and publication. Managers must play the embedded highlight video before approval or
  publication becomes available. Administrative routes require a manager or
  owner-administrator role. A pet cannot have two active sessions in one
  organization.
- Each pet's stay workspace includes a pet-scoped report-media uploader for
  photos and short MP4/MOV clips. Uploads are assigned directly to that stay as
  private candidates and still require the normal administrator approval and
  publication steps.
- Check-in includes a separate current-appearance identity enrollment step in
  both the Staff app and Administrator portal. Staff can upload several photos
  or either record or choose a saved short video; the worker extracts up to six
  representative frames. A household with multiple arriving pets can be checked
  in through one atomic batch action while retaining a separate stay, report,
  media selection, and identity-enrollment step for every pet.
  Clear single-pet frames become reference embeddings for the current pet and
  stay, while crowded or low-quality frames are skipped. Enrollment media is
  isolated from report media and cannot accidentally enter an owner report.
  Each checked-in pet's report workspace also shows the current reference
  images and their enrollment status in a clearly non-publishable section.
  Managers can re-check only the skipped references with the current detector
  and enrollment rules; existing AI-ready embeddings are left untouched. They
  can also explicitly copy any processed check-in frame into private report
  candidates, where it follows the normal selection and publication workflow.
  Managers can deactivate an incorrect or stale reference without deleting its
  audit record, then re-run AI from the review list while published media and
  manual corrections remain protected.
- The first coworker beta is deployable as a single Google Compute Engine
  staging VM behind Caddy HTTPS. Its database and object-storage services are
  private to Docker. This is a staging bridge, not the final highly available
  cloud architecture.
- That staging stack is live in the `UCBarkley Staging` Google Cloud project
  on a reserved address, with automatic HTTPS, CPU-only inference, a private
  PostgreSQL/MinIO network, billing alerts, and SSH restricted through Google
  IAP. The Administrator portal's canonical beta hostname is
  `https://app.ucbarkley.com`; the IP-based `sslip.io` hostname remains as a
  transition fallback. The VM disk has a daily seven-day snapshot policy.
  Deployment operations are documented in `deploy/gcp/README.md`.

Development-stage limitations include:

- The current vision models are general-purpose pretrained baselines rather
  than a pet re-identification model fine-tuned on UCBarkley corrections.
- A pet needs reference embeddings before identity suggestions are possible.
  Confirming an unambiguous single-pet photo bootstraps that reference corpus.
- The local worker polls PostgreSQL instead of consuming SQS.
- The repository currently has build/type-check validation but no automated
  test suite or seed data.
- The root Makefile provides a one-command local Staff-app workflow. It detects
  the Mac's current LAN address, starts Postgres and MinIO, applies migrations,
  creates the development bucket, starts API/inference/worker services, and
  launches Expo; a separate target rebuilds and installs the iOS development
  client when native code changes.
- The Staff app has EAS preview and App Store production build profiles under
  `apps/mobile`, with remote build-number management and its Expo project
  identity. New iOS builds are owned and signed by the Apple Developer account
  `pure4499@gmail.com`, team `Jeonghwa Jeon` (`Z9SJQ82J9J`), using bundle
  identifier `com.ucbarkley.staff`. The earlier `com.ucbarkley.tailtells`
  version 1.0.0 build 14 was approved for TestFlight on the Michelle Song team
  but is retained only as beta history; it has not been submitted for public
  App Store release and is not the target for future builds. A new App Store
  Connect record must be created under the Kaylin-owned team before the next
  production submission. App Store metadata, privacy/support URLs, review
  credentials, screenshots, and the permanent production API hostname remain
  public-release prerequisites.
- Photo drafts currently live in memory and are lost if the Staff app process
  is terminated before upload.
- Multi-facility accounts are not modeled yet; organization equals facility in
  the current Staff app.
- The authenticated Pet Owner portal, owner accounts, and SMS delivery are not
  implemented; the current owner experience is a shareable report-link page.
- The Administrator portal is an initial operational workflow and still needs
  report-template editing and automated browser tests.
- The payment/POS provider is not selected. Before implementing checkout,
  confirm each pilot shop's existing POS, terminals, processor agreement,
  catalog/inventory needs, and accounting workflow. Multi-shop distribution
  must use provider-supported delegated authorization (for example OAuth), not
  shared credentials or a UCBarkley merchant account.

## Near-term direction

The next meaningful milestones are:

1. Stabilize the Staff app's capture, multi-pet assignment, selection, coverage,
   and upload workflow on physical iOS and Android devices.
2. Persist local photo drafts and make upload/assignment retryable without
   creating duplicate assets.
3. Define and implement the multi-facility account, data, and authorization
   model.
4. Add automated tests around tenant isolation, staff assignments, group photos,
   coverage counts, review state transitions, and pipeline failure handling.
5. Stabilize and user-test the Administrator portal's correction, final
   selection, report draft, video preview, approval, and publishing workflow.
6. Create the Pet Owner portal for approved galleries, reports, videos, and
   history.
7. Introduce real detection and pet re-identification models behind the existing
   inference contracts, with an evaluation set and measurable thresholds.
8. Replace the development poller with an S3 event and SQS queue in production.
9. Add object-store inventory reconciliation, abandoned-upload cleanup, approved
   lifecycle retention rules, and delivery/AI/render metering before billing on
   media usage.

These are directions rather than a committed delivery schedule. Keep this list
aligned with actual priorities as they are decided.

## Product and design principles

- Favor fast, low-friction mobile interactions for staff who may be handling
  animals while using the app.
- Let one photo belong to multiple pets without making staff duplicate uploads.
- Show coverage before upload so staff can take more photos while the pets are
  still present.
- Make uncertain automation explicit and correctable.
- Keep Staff preselection, Administrator approval, and Pet Owner visibility as
  separate states and permissions.
- Never trade tenant isolation for implementation convenience.
- Preserve an audit trail for consequential staff actions such as corrections,
  publishing, and report delivery.
- Keep local development runnable without requiring an AWS account.
- Introduce production infrastructure behind stable boundaries so business
  workflows do not need to be rewritten.

## Open decisions

The repository does not yet establish final choices for:

- The real detection and pet re-identification model stack and hosting platform.
- Whether a facility is a child of an organization and how staff gain access to
  one or several facilities.
- The final managed Google Cloud topology after the initial single-VM beta.
- Pet Owner web technology and deployment boundaries.
- Report template, generation, approval, and delivery rules.
- Video generation inputs, approximately 30-second composition rules, and
  rendering infrastructure.
- Pet Owner authentication and household-level access rules.
- Exact retention, privacy, consent, and model-training policies for pet photos
  and staff-generated data.
- Offline capture, durable local drafts, and background-upload behavior for the
  Staff mobile app.

Treat these as unresolved. Do not silently encode a permanent choice without
confirming the product requirement and recording the decision here.

## Keeping this context useful

When a material decision is made, update the relevant section rather than
appending a conversational transcript. Prefer facts that will still help a new
collaborator months later:

- what the product is trying to accomplish;
- why an architectural boundary exists;
- what is implemented versus provisional;
- which constraints must not regress;
- which important questions remain open.

Secrets, personal credentials, ephemeral debugging notes, and speculative ideas
that have not been accepted do not belong in this file.
