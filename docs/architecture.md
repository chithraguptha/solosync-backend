# SoloSync Backend Architecture

## System overview

```mermaid
flowchart LR
  U[User Browser] -->|Google OAuth / session cookie| API[Express API]
  API --> DB[(MongoDB)]
  API --> R[(Redis)]
  API --> W[WAHA]
  R --> WK[Publisher Worker]
  WK --> W
  W --> WA[Customer WhatsApp]
  W -->|status webhook| API
  RP[Razorpay] -->|payment webhooks| API
  API --> LEDGER[(Billing Ledger / Wallet)]
  OPS[Internal Admin] -->|Basic Auth| API
```

## Authentication

Google authentication uses an OAuth authorization-code flow. The backend stores a short-lived OAuth state in Redis, exchanges the authorization code, verifies the Google ID token, then creates the SoloSync session using HTTP-only cookies. The backend never receives or stores the user's Google password.

## WhatsApp connection

Each user receives a deterministic WAHA session: `user_<mongodb-user-id>`.

```mermaid
sequenceDiagram
  participant B as Dashboard
  participant API as Backend
  participant W as Private WAHA
  participant P as User Phone
  B->>API: POST /api/whatsapp/connect
  API->>W: create/start session
  W-->>API: session status
  B->>API: GET /api/whatsapp/qr
  API->>W: get QR
  W-->>B: QR
  P->>W: Scan Linked Devices QR
  W-->>API: session.status
  B->>API: GET /api/whatsapp/status
  API-->>B: WORKING
```

WAHA must remain private; only the backend should call its API.

## Message lifecycle

```mermaid
flowchart TD
  A[POST /api/whatsapp/publish] --> B[Validate authenticated user]
  B --> C[Validate WAHA session]
  C --> D[Create Publication: queued]
  D --> E[Redis queue]
  E --> F[Publisher worker]
  F --> G[WAHA send]
  G -->|success| H[published]
  G -->|failure| I[retry]
  I -->|attempts < 3| E
  I -->|attempts >= 3| J[failed]
  H --> K[Message usage ledger]
```

Every publication stores recipient, type, content/media reference, status, attempts, provider message ID, error and timestamps.

## Dashboard analytics

Analytics are derived from publication history: total, successful, failed, queued/publishing, success rate, failure rate, and last-24-hour volume.

## Data model

### User
- email
- passwordHash (optional)
- googleId (optional)
- name
- avatarUrl
- authProvider

### WhatsappConnection
- userId
- provider
- sessionName
- status
- phoneNumber
- pushName
- activationRecorded

### Publication
- userId
- connectionId
- chatId
- kind
- text
- mediaUrl
- status
- attempts
- providerMessageId
- error
- publishedAt
- createdAt / updatedAt

### BillingLedger
- userId
- publicationId
- kind
- units
- amountPaise
- status
- note

## Razorpay billing architecture

Razorpay should handle relatively large payment events, not a new payment transaction for every ₹0.10 message. Use Razorpay for the ₹399 activation and prepaid wallet top-ups; use an internal paise ledger for message consumption.

```mermaid
flowchart TD
  U[User] --> FE[Dashboard]
  FE --> API[Backend]
  API --> O[Create Razorpay Order]
  O --> RZ[Razorpay Checkout]
  RZ --> API2[Payment verification]
  RZ --> WH[Razorpay webhook]
  WH --> API2
  API2 --> WALLET[(Wallet / Credit Ledger)]
  WALLET --> MSG[Message reservation]
  MSG --> WAHA[WAHA]
```

### Activation

First WhatsApp activation costs ₹399. The backend creates the Order, the frontend opens Checkout, and the backend verifies the returned signature. The webhook then reconciles the payment idempotently. Only a verified/captured activation should enable the WhatsApp connection.

### Message usage

Do not create a Razorpay transaction for every ₹0.10 message. User tops up prepaid credits, the backend credits the wallet after verified payment, and each successful message consumes ₹0.10 internally. Reserve before sending, commit on successful WAHA delivery, and release the reservation on failure.

Example: ₹100 top-up = 10,000 paise = 1,000 message credits at ₹0.10/message.

## Planned Razorpay data model

### Payment
- userId
- type: activation | wallet_topup
- amountPaise
- currency
- razorpayOrderId
- razorpayPaymentId
- razorpaySignature
- status
- webhookEventsProcessed
- createdAt / updatedAt

### Wallet
- userId
- balancePaise
- reservedPaise
- updatedAt

### WalletTransaction
- userId
- type: topup | message_reservation | message_usage | reservation_release | refund | adjustment
- amountPaise
- balanceBeforePaise
- balanceAfterPaise
- referenceType
- referenceId
- createdAt

Payment and webhook processing must be idempotent.

## Razorpay security boundaries

- Frontend receives only `key_id`, order ID and safe payment metadata.
- Backend owns `key_id` and `key_secret`.
- Backend verifies Checkout signatures.
- Backend verifies webhook HMAC using the raw request body.
- Backend reconciles payment status before crediting the wallet.
- Never credit a wallet from a frontend-only success response.
- Use unique constraints/idempotency keys for payment and webhook processing.
- Store money as integer paise, never floating point.

Razorpay explicitly recommends server-side signature validation and webhook HMAC validation.

## Internal operations dashboard

The backend exposes an ActiveAdmin-style operations console at `/admin`. It provides overview metrics plus searchable-style resource tables for users, WhatsApp connections, publications, Razorpay payments, wallets and billing ledger records. The current implementation uses the existing Express backend rather than introducing a second Rails service, so the local stack stays small.

## Local development architecture

```mermaid
flowchart LR
  B[Browser] --> FE[Frontend :5173]
  FE --> API[Express :4000]
  API --> M[(MongoDB)]
  API --> R[(Redis)]
  API --> W[WAHA :3000 internal]
  OPS[Admin Browser] --> API
```

Run `docker compose -f docker-compose.local.yml up --build` from the backend repository after cloning the frontend beside it. Local billing is disabled by default, so WhatsApp and message flows can be tested without Razorpay.

## Production flow

```mermaid
flowchart TD
  A[Google Login] --> B[Dashboard]
  B --> C{Activated?}
  C -->|No| D[₹399 Razorpay Checkout]
  D --> E[Verify + Webhook]
  E --> F[ACTIVE]
  C -->|Yes| F
  F --> G[Link WhatsApp]
  G --> H[WAHA QR]
  H --> I[WORKING]
  I --> J[Top up wallet]
  J --> K[Razorpay Checkout]
  K --> L[Wallet credited]
  L --> M[Reserve ₹0.10]
  M --> N[Send through WAHA]
  N -->|success| O[Commit usage]
  N -->|failure| P[Release reservation]
  O --> Q[Dashboard analytics]
  P --> Q
```


## WhatsApp recipient resolution

Before sending to a direct phone number, the publisher resolves the number through WAHA `GET /api/contacts/check-exists`. WAHA can return either a regular `@c.us` chat ID or a migrated `@lid` chat ID; SoloSync persists the resolved ID on the publication before calling `sendText`, `sendImage`, or `sendVideo`. This avoids assuming that every WhatsApp user can still be addressed only by `@c.us`. The WAHA image is pinned rather than floating on `latest`.


## Developer platform architecture

The developer workspace sits on the existing authenticated dashboard and exposes a separate versioned public API.

```text
Developer
   |
   +--> Dashboard session (HTTP-only cookie)
   |      +--> Overview / Messages / Wallet / Account
   |      +--> API Keys
   |      +--> API Docs
   |      +--> API Playground
   |
   +--> Public API (/v1)
          |
          +--> Authorization: Bearer ss_live_...
          +--> Scoped API key lookup (SHA-256 hash)
          +--> Account / Usage
          +--> Connection / QR
          +--> Messages
          +--> Existing Redis -> WAHA publication worker
```

API key plaintext is returned only when a key is created or rotated. The database stores only the key hash plus display metadata such as prefix, last four characters, scopes, creation time and last-use time.

The developer API intentionally uses the same message publication pipeline as the dashboard so queueing, wallet reservation, WAHA recipient resolution, delivery reconciliation and webhook-driven delivery status remain consistent across both interfaces.
