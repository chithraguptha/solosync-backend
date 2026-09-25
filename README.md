# SoloSync Backend

Node.js + Express + TypeScript + MongoDB + Redis backend for SoloSync.

## MVP features

- Email/password authentication with HTTP-only cookies.
- One WhatsApp account session per SoloSync user through self-hosted WAHA.
- QR-based WhatsApp session connection.
- WhatsApp session status and channel discovery.
- Text, image and video publication jobs through a Redis-backed worker.
- Publication history and provider message IDs.
- Billing ledger prepared for:
  - **₹399 activation fee** per first WhatsApp account activation.
  - **₹0.10 per successfully published message**.
- Payments are intentionally disabled for the current test phase. Set `BILLING_ENABLED=false`.
- /health and /ready endpoints.

WAHA sessions represent the connected WhatsApp account. SoloSync never asks the user for their WhatsApp password; the user pairs the account through WAHA's QR flow. WAHA supports persistent sessions and multiple sessions in one deployment, so production storage must survive restarts.

## Local

    cp .env.example .env
    npm install
    npm run dev

Start MongoDB, Redis and WAHA separately. The default WAHA URL is `http://localhost:3000`.

## WAHA

Run a protected WAHA instance and configure:

    WAHA_URL=http://localhost:3000
    WAHA_API_KEY=...
    WAHA_WEBHOOK_URL=https://api.example.com/webhooks/waha
    WAHA_WEBHOOK_HMAC_KEY=...

Do not expose the WAHA API directly to the public internet. Keep it on a private network and let only the backend reach it.

## WhatsApp flow

1. User creates a SoloSync account.
2. User selects **Connect WhatsApp**.
3. Backend creates a deterministic WAHA session for that user.
4. Frontend polls status and fetches the QR while the session is in `SCAN_QR_CODE`.
5. User scans the QR from WhatsApp.
6. WAHA reports `WORKING`.
7. SoloSync can list channels and queue publications.
8. A Redis worker sends the message through WAHA.
9. Only successful sends create a message usage ledger entry.

## API

Authentication:

- POST /api/auth/register
- POST /api/auth/login
- POST /api/auth/refresh
- POST /api/auth/logout
- GET /api/auth/me

WhatsApp:

- POST /api/whatsapp/connect
- GET /api/whatsapp/status
- GET /api/whatsapp/qr
- GET /api/whatsapp/channels
- POST /api/whatsapp/publish

Billing:

- GET /api/billing/summary

Webhook:

- POST /webhooks/waha

## Billing model

All amounts are stored as paise to avoid floating-point money calculations.

`39900 paise = ₹399`

`10 paise = ₹0.10`

The ledger is already populated in test mode, but no payment gateway is called. A payment provider can later consume activation and message ledger entries without changing the WhatsApp publishing API.

## Production hardening before charging users

- Integrate a payment provider and verify webhooks server-side.
- Make activation payment idempotent.
- Add prepaid wallet/credit balance or an explicit postpaid policy.
- Add invoice/tax records as required.
- Add refresh-token rotation and reuse detection.
- Add structured logs, metrics and alerting.
- Persist WAHA session storage and backups.
- Keep WAHA private and protected by API key/firewall.
- Define messaging/acceptable-use limits and account-disconnection handling.
