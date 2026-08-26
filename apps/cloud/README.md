# Zimlo Cloud

Cloudflare is Zimlo's only application-operated online service. It has two jobs:

1. Relay end-to-end encrypted Bridge WebSocket frames between a paired phone and
   its Mac when they are not on the same LAN.
2. Send privacy-preserving visible APNs alerts.

Cloudflare never receives task titles, prompts, code, results, approval details,
or decrypted Bridge messages. D1 stores installation public keys, per-device
access-token hashes, APNs tokens, route public keys, and delivery audit metadata.

First-time device pairing also uses a short-lived Durable Object rendezvous room.
It exists for at most two minutes, is protected by a separate one-time token, and
only exchanges ephemeral device registration material plus the Mac-signed pairing
response. The room is deleted after successful retrieval or expiry, and never
contains a task title, prompt, code, or result.

The Mac remains the source of truth. This is an encrypted live relay, not a cloud
task database: if the Mac is offline, the phone reads its last locally cached snapshot
and keeps new commands in the device outbox until the Mac reconnects.

## Resources

- One Worker: `zimlo-cloud`
- One D1 database: `zimlo-cloud`
- One hibernating Durable Object per Mac installation
- One disposable Durable Object per in-progress pairing
- Worker secrets for the Apple APNs provider key
- Worker Rate Limiting bindings for installation creation and relay authentication
- One `zimlo-materials` R2 bucket for encrypted, short-lived material relay objects

Task materials are encrypted on iOS/Web before upload. The Worker never receives
the material key, original name, MIME type, task id, or plaintext. The Mac verifies
and stores the plaintext locally, then deletes the relay object. Configure an R2
lifecycle rule that deletes anything older than 24 hours as a crash/offline safety
net; successful transfers are deleted immediately. Do not reuse `zimlo-releases`,
because public releases and private ciphertext require different retention rules.

Limits are enforced before upload and again by the Bridge: images 8MB; videos 50MB
and 3 minutes; PDF 20MB and 200 pages on iOS; other supported documents 15MB; at
most 10 materials and 80MB total per task.

The design fits Cloudflare's free tier for an early public beta because idle
WebSockets use Durable Object hibernation and do not continuously consume Worker
CPU. D1 rows contain only small routing records. Add billing limits, rate limiting,
and account onboarding before opening anonymous registration at meaningful scale.

## First deployment

```bash
cd apps/cloud
pnpm exec wrangler login
pnpm exec wrangler d1 create zimlo-cloud
pnpm exec wrangler r2 bucket create zimlo-materials
```

Copy the returned `database_id` into `wrangler.jsonc`, then:

```bash
pnpm exec wrangler d1 migrations apply zimlo-cloud --remote
pnpm exec wrangler secret put APNS_SANDBOX_PRIVATE_KEY_P8
pnpm exec wrangler secret put APNS_SANDBOX_KEY_ID
pnpm exec wrangler secret put APNS_PRODUCTION_PRIVATE_KEY_P8
pnpm exec wrangler secret put APNS_PRODUCTION_KEY_ID
pnpm exec wrangler secret put APNS_TEAM_ID
pnpm exec wrangler secret put APNS_TOPIC
pnpm run deploy
```

Debug builds register their token for the APNs sandbox and TestFlight/App Store
builds register for production APNs. The environment is stored per device, so
both can use the same Worker without reconfiguration. The official beta is
deployed at:

```bash
https://zimlo-cloud.zimlo.workers.dev
```

The CLI uses this endpoint by default. A self-hosted deployment can override it
with `ZIMLO_CLOUD_URL`; `ZIMLO_CLOUD_DISABLED=1` disables all cloud access.

The Mac creates its own P-256 installation key on first start. The private key
never leaves the Mac. Pairing provisions a separate random cloud access token
for each phone; Cloudflare stores only its SHA-256 hash. Because the phone joins
the temporary pairing room over HTTPS, first pairing no longer requires the phone
and Mac to share a LAN.

After the first pairing, daily startup can omit `--lan`:

```bash
pnpm start
```

The Mac only makes outbound HTTPS/WebSocket connections, so no router port
forwarding, public Mac address, VPN, or Cloudflare Tunnel is required.

## macOS installer and automatic updates

The signed DMG and Sparkle appcast use a separate R2 bucket. Enable R2 once in
the Cloudflare dashboard, then run:

```bash
pnpm --filter @zimlo/cloud exec wrangler r2 bucket create zimlo-releases
```

Add the binding below to `wrangler.jsonc` and redeploy the Worker:

```jsonc
"r2_buckets": [
  {
    "binding": "RELEASES",
    "bucket_name": "zimlo-releases"
  }
]
```

`GET /releases/macos/appcast.xml` uses a short cache while versioned DMGs are
immutable. If R2 has not been bound, the release endpoint returns
`503 release_storage_unavailable` without affecting pairing, relay, or push.

## Runtime flow

```text
iPhone/PWA -- encrypted Bridge frame --> Worker --> Durable Object
                                                    |
                                                    v
Mac outbound WebSocket <-- opaque relay frame ------+
        |
        +--> loopback /ws --> SecureSocket --> Runtime/SQLite
```

The Worker authenticates a hashed per-device cloud token before routing, then
the inner Bridge protocol independently authenticates the paired device and
encrypts every application message. Compromising only the cloud token therefore
does not reveal task data or grant Bridge permissions.

## Secrets and operational data

- `APNS_SANDBOX_PRIVATE_KEY_P8` / `APNS_SANDBOX_KEY_ID`: the environment-scoped key used by Xcode development builds.
- `APNS_PRODUCTION_PRIVATE_KEY_P8` / `APNS_PRODUCTION_KEY_ID`: the environment-scoped key used by TestFlight and App Store builds.
- `APNS_TEAM_ID`: Apple Developer Team ID.
- `APNS_TOPIC`: the production App bundle identifier, currently `com.zimlo.ios`.

Legacy `APNS_PRIVATE_KEY_P8` / `APNS_KEY_ID` secrets remain supported for older
Apple keys that are valid in both environments. If either scoped value is set
for an environment, both scoped values are required so rotations fail closed.

Never put these values in the iOS app, CLI package, Git, or D1. APNs token
rotation is handled by upserting the device record; APNs `410` marks it inactive.
Push audit metadata is automatically removed after 45 days.

## What is not finished for a broad public launch

The cryptographic installation model provides tenant isolation without a Zimlo
account, which is appropriate for a controlled beta. Per-IP Cloudflare rate
limits already bound installation creation and relay authentication. Before
unrestricted public signup, add an account/invite bootstrap and account-level
quotas as a stronger defense against distributed abuse. This cost-control layer
does not need access to decrypted task content.
