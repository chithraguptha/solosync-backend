# SoloSync Backend

Node.js + Express + TypeScript + MongoDB + Redis backend for SoloSync.

## Included

- Email/password and Google OAuth authentication.
- QR-based WhatsApp account pairing through private WAHA.
- Redis-backed text/image/video publication worker.
- Publication history and dashboard analytics.
- Razorpay activation payment (₹399) and prepaid wallet top-ups.
- ₹0.10/message internal wallet accounting.
- Server-side Razorpay Checkout verification and webhook HMAC validation.
- ActiveAdmin-style internal operations dashboard at `/admin`.
- Developer platform API keys, scoped public API and OpenAPI reference.
- Developer API playground, connection guide and API integration documentation.
- Complete local Docker stack with MongoDB, Redis, WAHA, API and frontend.

## Local: run the whole website

Clone the frontend beside the backend repository:

```bash
git clone -b feat/production-mvp https://github.com/solosynctech/backend.git solosync-backend
git clone -b feat/production-mvp https://github.com/solosynctech/frontend.git solosync-frontend
cd solosync-backend
docker compose -f docker-compose.local.yml up --build
```

Open:
- Website: http://localhost:5173
- API: http://localhost:4000/health
- Admin: http://localhost:4000/admin
- Admin username: `admin@solosync.local`
- Admin password: `admin-local-change-me`

The local stack deliberately runs with `BILLING_ENABLED=false`, so you can create an account, pair WhatsApp, send test messages and inspect the ledger without moving money. Change the local admin password before sharing the environment.

To stop it:
```bash
docker compose -f docker-compose.local.yml down
```

To remove local MongoDB/WAHA state too:
```bash
docker compose -f docker-compose.local.yml down -v
```

### Local WhatsApp test
1. Open the website.
2. Create an email/password account.
3. Click **Link WhatsApp**.
4. Open WhatsApp on your phone → Linked devices → Link a device.
5. Scan the QR shown by SoloSync.
6. Wait for **Connected / WORKING**.
7. Enter a recipient chat ID and send a message.
8. Inspect the publication and billing records in `/admin`.

WAHA remains internal to the Docker network and is not exposed on the host.

## Razorpay setup

Razorpay uses separate Test and Live modes. Keep Test Mode enabled until the full flow is verified. Generate API keys in the Razorpay Dashboard and keep the secret only on the backend. The backend creates Orders; the frontend receives only the public key and order metadata.

Backend environment:
```env
BILLING_ENABLED=true
RAZORPAY_KEY_ID=rzp_test_xxx
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
RAZORPAY_CURRENCY=INR
ACTIVATION_FEE_PAISE=39900
MESSAGE_FEE_PAISE=10
```

Configure the Test Mode webhook endpoint as `https://api.solosync.live/webhooks/razorpay`.

Subscribe at minimum to `payment.captured`, `payment.failed` and `order.paid`. The webhook is validated against the raw request body using HMAC-SHA256. Checkout signatures are also verified server-side.

For local webhook testing, use a public HTTPS staging/tunnel that Razorpay accepts rather than assuming localhost delivery.

## Billing flow
### Activation
```text
Dashboard
  -> POST /api/billing/activation/order
  -> Razorpay Checkout
  -> POST /api/billing/activation/verify
  -> Razorpay payment fetch + signature verification
  -> ACTIVE account
  -> WhatsApp connection allowed
```

The webhook independently reconciles captured payments and is idempotent.

### Wallet
Use Razorpay for wallet top-ups, not for every message.

Example: `₹100 = 10,000 paise = 1,000 messages at ₹0.10/message`

Before a paid message is queued, the backend atomically reserves ₹0.10. On successful WAHA delivery it commits the usage; on a final failure it releases the reservation.

## Developer platform

The frontend now provides a professional developer workspace with Overview, Messages, WhatsApp connection, Wallet, API Keys, API Docs, API Playground and Account screens. Public developer endpoints are versioned under `/v1` and use scoped Bearer API keys.

API key secrets are shown only when created or rotated and are stored server-side as hashes. See `docs/developer-platform.md` for the complete integration flow and examples. The machine-readable OpenAPI document is available at `/openapi.json`.

## Admin dashboard
The internal dashboard provides:
- overview metrics
- users and authentication providers
- WhatsApp connection status
- publication history and failures
- Razorpay payment records
- wallet balances and reservations
- billing ledger

Protect `/admin` with a strong password and do not expose it publicly without an additional access-control layer.

## Production hardening still required
- pin every npm dependency and commit a lockfile
- add automated unit/E2E tests for payment verification and wallet idempotency
- use stronger admin authentication/authorization than shared Basic Auth
- add refresh-token rotation and reuse detection
- add structured logs, metrics and alerting
- persist and back up WAHA session storage
- validate Razorpay webhook IP policy according to current Razorpay guidance
- configure production CORS, secrets and HTTPS
- define messaging/acceptable-use limits and account-disconnection handling

## Troubleshooting: `WAHA 500: No LID for user`

If a publication fails with `No LID for user`, this is a WAHA/WhatsApp Web recipient identity issue, not a MongoDB or Redis failure. SoloSync now resolves direct phone numbers through WAHA `check-exists` immediately before sending and stores the returned `@lid` or `@c.us` chat ID. The local stack pins WAHA `2026.9.1` instead of floating `latest`. If an older deployment is still running, recreate the WAHA container with the pinned image and keep the existing session volume. Then retry the message. WAHA's documentation supports both `@c.us` and `@lid` chat IDs and recommends `check-exists` for resolving phone numbers. citeturn3search0turn3search1

If the existing session remains unhealthy after the WAHA upgrade, reconnect that WhatsApp session once rather than repeatedly retrying the same publication.