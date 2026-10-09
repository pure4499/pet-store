# UCBarkley Staff — iOS release guide

The SDK 57 app must keep `expo-build-properties` configured with
`ios.enableSceneSupport: true`. Xcode 27 builds require the UIKit scene
lifecycle and terminate immediately on iOS 27 when this opt-in is absent.

The Staff mobile application lives in `apps/mobile`. Run all Expo Application
Services commands from that directory so EAS reads the authoritative SDK 57
configuration and project ID.

## Release identity

- App name: `UCBarkley Staff`
- Expo project: `@kaylins-team/tail-tells`
- EAS project ID: `70cb1421-458e-45b2-b7e9-cd94bb5ee9cb`
- Apple Developer account: `pure4499@gmail.com`
- Apple development team: `Jeonghwa Jeon` (`Z9SJQ82J9J`)
- App Store Connect app ID: pending creation under the Kaylin-owned team
- iOS bundle identifier: `com.ucbarkley.staff`
- First marketing version: `1.0.0`
- Build-number source: EAS remote versioning for EAS builds; local Xcode
  archives must also increment `ios.buildNumber` before each upload.

Use the Apple Developer account `pure4499@gmail.com` and team ID
`Z9SJQ82J9J` for signing. The earlier `com.ucbarkley.tailtells` beta and App
Store Connect record remain under the Michelle Song team and must not be used
for new submissions. Create the Kaylin-owned App Store Connect record with
`com.ucbarkley.staff`, then add its numeric App Store Connect ID to
`submit.production.ios.ascAppId` in `apps/mobile/eas.json` before using the
non-interactive submit script.

## Toolchain

Use a Node version supported by Expo SDK 57 and React Native 0.86. The repository
baseline is Node 22.13 or newer. Node 23 is not supported by Metro; use Node 22
LTS or a supported Node 24 release for builds.

```bash
cd apps/mobile
npm run doctor
npm run typecheck
```

The iOS icon is a 1024×1024 opaque PNG. The app is configured for iPhone-only
submission, portrait orientation, automatic signing, camera/photo-library
purpose strings, and the standard exemption declaration for non-exempt
encryption.

## Installable beta

The `preview` build is an internally distributed, production-like build. It is
configured against the current HTTPS UCBarkley API endpoint.

```bash
cd apps/mobile
npx eas login
npm run build:ios:preview
```

On the first iOS build, EAS will ask for Apple Developer access and can create
or reuse the distribution certificate and provisioning profile. Internal iOS
distribution may require registering test devices. TestFlight is the preferred
path once the App Store Connect record exists.

## Production and TestFlight

Prerequisites:

1. Active paid Apple Developer Program membership.
2. App Store Connect app record owned by the Kaylin team and using
   `com.ucbarkley.staff`.
3. Agreements, tax, and banking requirements accepted in App Store Connect.
4. App Store Connect API key configured through `eas credentials --platform ios`
   or an interactive Apple login during submission.
5. A working manager-created staff review account and a facility with safe demo
   pets/data for App Review.

Build and upload:

```bash
cd apps/mobile
npm run doctor
npm run typecheck
npm run build:ios:production
npm run submit:ios
```

After Apple processes the binary, enable it for internal TestFlight testers.
Do not submit for public App Review until the staging API has production-grade
availability, the reviewer account works without developer assistance, and all
required store metadata is complete.

## App Store Connect content still requiring business input

- App subtitle, description, keywords, category, copyright, and support contact.
- Support URL and publicly accessible privacy-policy URL.
- iPhone screenshots for every display size requested by App Store Connect.
- App Review notes explaining that this is a staff-only pet-facility app and
  providing the demo organization, email, password, and exact review steps.
- Age rating questionnaire and content-rights answers.
- App privacy answers. Confirm them against production behavior before filing.
  The current app uses staff account identifiers, authentication tokens, pet
  care records, and staff-selected pet photos/videos. Media is uploaded for the
  facility workflow and AI-assisted matching; it is not advertising data.
- Final decision on whether the current staging API hostname is acceptable for
  TestFlight only or should be replaced by a permanent production API hostname
  before App Review.

Never commit Apple passwords, App Store Connect private keys, EAS access tokens,
review-account passwords, or production API secrets. Store submission secrets
in EAS Credentials or the approved CI secret store.
