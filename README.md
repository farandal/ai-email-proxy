# CSIRT Email Worker — Deploy Instructions

## What this does
Receives emails sent to `analyze@cyberseguridadciudadana.cc` via Cloudflare
Email Routing, parses MIME content, and POSTs the relevant fields to the
Laravel backend at `https://api.cyberseguridadciudadana.cc`.

## Prerequisites
- Cloudflare account with `cyberseguridadciudadana.cc` zone
- Email Routing enabled on that zone (Dashboard → Email → Email Routing)
- `wrangler` CLI installed: `npm install -g wrangler`
- Laravel backend running with `CSIRT_WEBHOOK_SECRET` set

## Deploy

```bash
# 1. Authenticate
wrangler login

# 2. Set secrets (never commit these)
wrangler secret put BACKEND_URL
# → enter: https://api.cyberseguridadciudadana.cc

wrangler secret put WEBHOOK_SECRET
# → enter: <same value as CSIRT_WEBHOOK_SECRET in dash-backend/.env>

# 3. Deploy
wrangler deploy
```

## Configure Email Routing rule (Cloudflare Dashboard)

1. Go to **Email** → **Email Routing** → **Rules**
2. Click **Create address**
3. Custom address: `analyze`
4. Action: **Send to a Worker**
5. Worker: `csirt-email-relay`
6. Save

## Test end-to-end

Send a test email to `analyze@cyberseguridadciudadana.cc` from any email
client. Within seconds you should receive a fraud analysis report back.

To tail worker logs:
```bash
wrangler tail csirt-email-relay
```

## Generate a webhook secret

```bash
openssl rand -hex 32
# Copy output → set as CSIRT_WEBHOOK_SECRET in both:
#   dash-backend/.env
#   wrangler secret put WEBHOOK_SECRET
```
