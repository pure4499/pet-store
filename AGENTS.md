# UCBarkley repository guidance

## Start here

- Read `PROJECT_CONTEXT.md` for the product goals, architecture, current state,
  and durable decisions.
- Read `README.md` for local setup and run commands.
- Before editing a subtree, check for a closer `AGENTS.md`. Nested instructions
  override this file for that subtree. In particular, `apps/mobile/AGENTS.md`
  contains the required Expo-version documentation rule.

## Product priorities

- UCBarkley has three distinct product surfaces: the Staff mobile app, the
  Administrator portal, and the Pet Owner portal. Do not move responsibilities
  between them merely because an API already exposes the operation.
- The active product focus is the Staff mobile app in `apps/mobile`. Optimize
  it for busy staff using a phone: login, facility selection, viewing currently
  checked-in pets, rapid photo capture, explicit multi-pet assignment, photo
  selection, coverage checks, and uploading the selected batch.
- Staff selection is not publication. Administrators review assignments, make
  the final report selection, approve content, and publish it. Pet owners only
  receive approved photos, reports, videos, and history.
- Human review is part of the photo workflow. Low-confidence matches must remain
  visible for administrator confirmation; do not silently publish them.
- Preserve tenant isolation. Every tenant-owned query must be scoped by
  `organization_id`, and API/worker database work must continue using
  `withOrgScope` so PostgreSQL row-level security remains effective.
- Keep photo processing off the API request path. The local PostgreSQL poller is
  an adapter for development; the production direction is S3 events through SQS.
- Preserve the `/detect` and `/embed` inference contracts when replacing the
  current stub models.
- Treat staff corrections and confirmed photos as useful future training and
  reference data. Do not discard that feedback loop.

## Repository boundaries

- `apps/api`: Express/TypeScript REST API, authentication, tenant-scoped data,
  presigned object-storage access, and PostgreSQL migrations.
- `apps/worker`: asynchronous photo processing, matching, scoring, and candidate
  ranking.
- `apps/inference`: Python/FastAPI model boundary. Its models are intentionally
  stubs at present.
- `apps/mobile`: Expo/React Native Staff mobile application (active focus).
- Administrator and Pet Owner web portals are planned product surfaces but do
  not yet have dedicated frontend applications in this repository.
- `packages/shared-types`: shared TypeScript domain and API types. Update these
  when a contract change affects more than one TypeScript workspace.

## Engineering conventions

- Keep changes scoped and preserve existing API behavior unless the task
  explicitly requires a contract change.
- Use Zod at API boundaries and parameterized SQL for database access.
- Add schema changes as a new numbered migration; do not rewrite an applied
  migration merely to change an existing environment.
- Preserve staff choices: background ranking must not overwrite rows marked
  `is_manually_adjusted`, and published selections are immutable through the
  ordinary review endpoint.
- Never commit credentials or values from `.env` files. Use `.env.example` for
  documented configuration.
- Prefer shared domain language: organization, household, owner, pet, session,
  daily log, photo batch, detection, photo link, candidate, and published.
- Update `PROJECT_CONTEXT.md` when a change materially alters architecture,
  product scope, a durable decision, the implementation status, or the next
  major milestone. Do not turn it into a task-by-task changelog.

## Verification

- Run `npm run build` after TypeScript changes that span the repository.
- For a single workspace, the relevant build is:
  `npm run build --workspace=apps/api` or
  `npm run build --workspace=apps/worker`.
- The mobile workspace currently has no dedicated test or build script. At
  minimum, type-check mobile changes with
  `npx tsc --noEmit -p apps/mobile/tsconfig.json`.
- Validate inference-service Python syntax with
  `python3 -m compileall apps/inference`.
- Database behavior requires PostgreSQL with pgvector and the migrations from
  `apps/api/db/migrations`. Do not point normal API or worker traffic at the
  `pethotel` superuser; migrations use that role, while runtime uses
  `pethotel_app`.
