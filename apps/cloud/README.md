# Zimlo Cloud

Cloudflare is Zimlo's only application-operated online service. It has two jobs:

1. Relay end-to-end encrypted Bridge WebSocket frames between a paired phone and
   its Mac when they are not on the same LAN.
2. Send privacy-preserving visible APNs alerts.

Cloudflare never receives task titles, prompts, code, results, approval details,
or decrypted Bridge messages. D1 stores installation public keys, per-device
access-token hashes, APNs tokens, route public keys, and delivery audit metadata.

The Mac remains the source of truth. This is an encrypted live relay, not a cloud
task database: if the Mac is offline, the phone reads its last locally cached snapshot
and keeps new commands in the device outbox until the Mac reconnects.

## Resources

- One Worker: `zimlo-cloud`
- One D1 database: `zimlo-cloud`
- One hibernating Durable Object per Mac installation
- Worker secrets for the Apple APNs provider key
- Worker Rate Limiting bindings for installation creation and relay authentication

The design fits Cloudflare's free tier for an early public beta because idle
WebSockets use Durable Object hibernation and do not continuously consume Worker
CPU. D1 rows contain only small routing records. Add billing limits, rate limiting,
and account onboarding before opening anonymous registration at meaningful scale.

## First deployment

```bash
cd apps/cloud
pnpm exec wrangler login
pnpm exec wrangler d1 create zimlo-cloud
```

Copy the returned `database_id` into `wrangler.jsonc`, then:

```bash
pnpm exec wrangler d1 migrations apply zimlo-cloud --remote
pnpm exec wrangler secret put APNS_PRIVATE_KEY_P8
pnpm exec wrangler secret put APNS_KEY_ID
pnpm exec wrangler secret put APNS_TEAM_ID
pnpm exec wrangler secret put APNS_TOPIC
pnpm exec wrangler secret put APNS_ENVIRONMENT
pnpm deploy
```

Use `production` for TestFlight/App Store and `development` for locally signed
debug builds. The official beta is deployed at:

```bash
https://zimlo-cloud.zimlo.workers.dev
```

The CLI uses this endpoint by default. A self-hosted deployment can override it
with `ZIMLO_CLOUD_URL`; `ZIMLO_CLOUD_DISABLED=1` disables all cloud access.

The Mac creates its own P-256 installation key on first start. The private key
never leaves the Mac. Pairing provisions a separate random cloud access token
for each phone; Cloudflare stores only its SHA-256 hash.

After the first pairing, daily startup can omit `--lan`:

```bash
pnpm start
```

The Mac only makes outbound HTTPS/WebSocket connections, so no router port
forwarding, public Mac address, VPN, or Cloudflare Tunnel is required.

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

- `APNS_PRIVATE_KEY_P8`: Apple APNs provider signing key.
- `APNS_KEY_ID`: the key ID from Apple Developer.
- `APNS_TEAM_ID`: Apple Developer Team ID.
- `APNS_TOPIC`: the production App bundle identifier, currently `com.zimlo.ios`.
- `APNS_ENVIRONMENT`: `development` for a locally signed debug build,
  `production` for TestFlight/App Store.

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
