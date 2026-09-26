# SoloSync Developer Platform

SoloSync now exposes a developer workspace and a versioned API for building WhatsApp messaging integrations.

## Dashboard

The developer workspace contains:

- **Overview** — message totals, delivery/failure rates, wallet balance and onboarding checklist.
- **Messages** — send messages from the dashboard and inspect publication + delivery state.
- **WhatsApp** — establish the WAHA-backed connection, scan the QR and follow the connection lifecycle.
- **Wallet** — recharge prepaid credit through Razorpay and inspect wallet transactions.
- **API Keys** — create scoped live credentials, rotate and revoke them. The plaintext secret is returned only at creation/rotation.
- **API Docs** — quickstart, authentication, connection and message examples in cURL, JavaScript and Python.
- **API Playground** — make authenticated API requests directly from the dashboard and inspect the HTTP response.
- **Account** — account identity, environment and billing information.

## API authentication

API requests use:

```http
Authorization: Bearer ss_live_...
```

API keys are stored as SHA-256 hashes. SoloSync does not store or recover the plaintext secret. Generate a separate key for each application or service and revoke/rotate it when exposure is suspected.

## Scopes

| Scope | Purpose |
|---|---|
| `account:read` | Account and usage |
| `connection:read` | WhatsApp connection status |
| `connection:manage` | Establish connection and retrieve QR |
| `messages:read` | Message history |
| `messages:send` | Queue messages |

## Connection

1. Create an API key with `connection:manage`.
2. Call `POST /v1/connection`.
3. If the status is `SCAN_QR_CODE`, use the returned QR payload or the dashboard QR screen.
4. In WhatsApp, open **Linked devices → Link a device** and scan.
5. Poll `GET /v1/connection` until `status=WORKING`.

Example:

```bash
curl -X POST https://api.solosync.live/v1/connection \
  -H "Authorization: Bearer $SOLOSYNC_API_KEY"
```

## Send a message

Messages are queued asynchronously. A successful HTTP response means the publication was accepted into SoloSync's queue, not that the message has already been read.

```bash
curl -X POST https://api.solosync.live/v1/messages \
  -H "Authorization: Bearer $SOLOSYNC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"919876543210","text":"Hello from SoloSync"}'
```

Response:

```json
{
  "id": "publication_id",
  "status": "queued",
  "feePaise": 10
}
```

Use `GET /v1/messages` to inspect `status`, `deliveryStatus`, `providerMessageId` and any failure information.

## Wallet

The current billing model is:

- Account activation: **₹399**
- Message usage: **₹0.10/message**
- Wallet top-ups: Razorpay
- Message credit is reserved before queueing and finalized after successful publication; a final failure releases the reservation.

The dashboard's Wallet screen shows available balance, reserved balance and wallet transactions.

## API Playground

The Playground intentionally accepts the API key as an input rather than automatically persisting the secret in browser storage. Responses are rendered in the current page and are not saved as request logs by the dashboard.

## OpenAPI

The backend serves the machine-readable API reference at:

```
GET /openapi.json
```

The dashboard links to this document from **API Docs**.

## Production key security

Use HTTPS for all API requests. Do not put keys in URLs, client-side bundles, source control or logs. Keep the plaintext secret in your application's secret store/environment and rotate it when necessary.
