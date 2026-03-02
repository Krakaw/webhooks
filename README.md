# @krakaw/webhooks

Production-ready webhook infrastructure for Krakaw projects — HMAC-signed delivery, Dead Letter Queue, automatic retry, and comprehensive logging.

## ✨ Features

- ✅ **HMAC-SHA256 signed delivery** with `X-Webhook-Signature` header
- ✅ **Dead Letter Queue (DLQ)** for failed deliveries with persistent retry
- ✅ **Automatic retry** with configurable delays (default: 1min, 5min, 30min)
- ✅ **Comprehensive delivery logging** — audit trail for every attempt
- ✅ **Type-safe event system** — define your own event unions
- ✅ **Drizzle ORM schema** for PostgreSQL
- ✅ **Hono routes** for webhook CRUD (list, create, update, delete, test)
- ✅ **Concurrent retry processing** with SELECT FOR UPDATE SKIP LOCKED
- ✅ **Configurable timeouts, polling intervals, batch sizes**
- ✅ **Zero external dependencies** for core delivery (no Redis/BullMQ required)

## 📦 Installation

```bash
npm install @krakaw/webhooks drizzle-orm hono
```

## 🚀 Quick Start

### 1. Add the schema to your database

```typescript
// src/db/schema/index.ts
import {
  webhooks,
  webhookDeliveryLog,
  webhookDeadLetterQueue,
} from '@krakaw/webhooks';

export { webhooks, webhookDeliveryLog, webhookDeadLetterQueue };
```

Then generate and run migrations:

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

### 2. Create the delivery service

```typescript
// src/services/webhooks.ts
import { createWebhookService } from '@krakaw/webhooks';
import { db } from '../db';

export const webhookService = createWebhookService(db, {
  timeoutMs: 10_000,
  signatureHeader: 'X-MyApp-Signature', // optional, defaults to 'X-Webhook-Signature'
});
```

### 3. Start the retry job

```typescript
// src/index.ts or src/server.ts
import { startWebhookRetryJob } from '@krakaw/webhooks';
import { db } from './db';

// Start the DLQ retry job (polls every 30 seconds by default)
const stopRetryJob = startWebhookRetryJob(db, {
  pollIntervalMs: 30_000, // optional, defaults to 30s
  batchSize: 15, // optional, defaults to 15
});

// Optionally, gracefully stop the job on shutdown
process.on('SIGTERM', () => {
  stopRetryJob();
  process.exit(0);
});
```

### 4. Mount the routes (optional)

```typescript
// src/index.ts or src/routes/index.ts
import { Hono } from 'hono';
import { createWebhookRoutes } from '@krakaw/webhooks';
import { authMiddleware } from './auth/middleware';
import { db } from './db';
import { webhookService } from './services/webhooks';

const app = new Hono();

// Define your project's webhook events
type MyProjectEvents =
  | 'booking.created'
  | 'booking.cancelled'
  | 'transcript.ready';

const webhookRoutes = createWebhookRoutes<MyProjectEvents>({
  db,
  webhookService,
  authMiddleware, // Must set c.get('userId')
  validEvents: ['booking.created', 'booking.cancelled', 'transcript.ready'],
});

app.route('/webhooks', webhookRoutes);
```

### 5. Fire events from your business logic

```typescript
import { webhookService } from './services/webhooks';

// When a booking is created:
await webhookService.fireEvent(
  'booking.created',
  {
    bookingId: '123',
    userId: 'user-456',
    startTime: '2026-03-01T10:00:00Z',
  },
  'user-456', // user whose webhooks to trigger
);
```

## 🔄 How It Works

### Immediate Delivery

1. `webhookService.fireEvent()` is called
2. System fetches all enabled webhooks for the user that subscribe to this event
3. For each webhook:
   - Payload is signed with HMAC-SHA256 using the webhook's secret
   - HTTP POST is sent to the webhook URL
   - Attempt is logged to `webhook_delivery_log`
   - If successful (2xx response):
     - Webhook record is updated (`last_delivered_at`, `last_delivery_status`)
   - If failed (non-2xx, timeout, or network error):
     - Entry is added to `webhook_dead_letter_queue`
     - Next retry scheduled (default: +1 minute)
     - Webhook record is updated (`last_failed_at`, `last_delivery_status`)

### DLQ Retry Processing

The retry job runs on startup and polls every 30 seconds (configurable):

1. Fetches up to 100 entries where `next_retry_at <= NOW()` and `failed_permanently = false`
2. Processes entries in batches of 15 (configurable)
3. For each entry:
   - Atomically claims the entry with `SELECT FOR UPDATE SKIP LOCKED` (prevents duplicate processing)
   - Re-attempts HTTP POST with original payload + signature
   - Logs attempt to `webhook_delivery_log` (with incremented attempt number)
   - If successful:
     - Deletes entry from DLQ
     - Updates webhook record (`last_delivered_at`, `last_delivery_status`)
   - If failed:
     - Increments `attempt_count`
     - If `attempt_count >= MAX_DLQ_ATTEMPTS` (default: 3):
       - Marks entry as `failed_permanently = true`
     - Else:
       - Schedules next retry with delay from `WEBHOOK_RETRY_DELAYS_MS`
     - Updates webhook record (`last_failed_at`, `last_delivery_status`)

### Retry Schedule

Default delays (from `WEBHOOK_RETRY_DELAYS_MS`):

| Attempt | Delay from previous failure | Total time from initial failure |
| ------- | --------------------------- | ------------------------------- |
| 1       | +1 minute                   | 1 minute                        |
| 2       | +5 minutes                  | 6 minutes                       |
| 3       | +30 minutes                 | 36 minutes                      |

After 3 failed DLQ retries (+ 1 initial attempt = 4 total), the entry is marked `failed_permanently = true`.

## 📊 Database Schema

### `webhooks`

Stores user-registered webhook URLs with HMAC secrets and event subscriptions.

| Column                 | Type      | Description                                         |
| ---------------------- | --------- | --------------------------------------------------- |
| `id`                   | text      | Primary key (UUID)                                  |
| `user_id`              | text      | FK → users.id (webhook owner)                       |
| `name`                 | text      | Human-readable label                                |
| `url`                  | text      | Target URL for HTTP POST                            |
| `secret`               | text      | HMAC-SHA256 signing secret (hex, 64 chars)          |
| `events`               | jsonb     | List of subscribed events (empty = all)             |
| `enabled`              | boolean   | Whether webhook is active                           |
| `last_delivered_at`    | timestamp | Last successful delivery                            |
| `last_delivery_status` | integer   | HTTP status from last attempt                       |
| `last_failed_at`       | timestamp | Last failed delivery                                |
| `created_at`           | timestamp | Creation timestamp                                  |
| `updated_at`           | timestamp | Last update timestamp                               |

### `webhook_delivery_log`

Immutable log of every HTTP delivery attempt.

| Column         | Type      | Description                              |
| -------------- | --------- | ---------------------------------------- |
| `id`           | text      | Primary key (UUID)                       |
| `webhook_id`   | text      | FK → webhooks.id                         |
| `delivery_id`  | text      | Shared ID for all attempts of same event |
| `event`        | text      | Event type                               |
| `url`          | text      | Target URL at time of attempt            |
| `attempt`      | integer   | 1-based attempt number                   |
| `status_code`  | integer   | HTTP status (null on network error)      |
| `success`      | boolean   | True if 2xx response                     |
| `error`        | text      | Error message if failed                  |
| `duration_ms`  | integer   | Round-trip time in milliseconds          |
| `attempted_at` | timestamp | Attempt timestamp                        |

Indexes: `webhook_id`, `delivery_id`, `attempted_at`

### `webhook_dead_letter_queue`

Failed deliveries awaiting retry.

| Column                | Type      | Description                                        |
| --------------------- | --------- | -------------------------------------------------- |
| `id`                  | text      | Primary key (UUID)                                 |
| `webhook_id`          | text      | FK → webhooks.id                                   |
| `delivery_id`         | text      | Original delivery ID                               |
| `event`               | text      | Event type                                         |
| `payload`             | text      | Full JSON payload (stored as TEXT for HMAC safety) |
| `attempt_count`       | integer   | Number of DLQ retries completed (0 = not retried)  |
| `next_retry_at`       | timestamp | When next retry should be attempted                |
| `failed_permanently`  | boolean   | True when all retries exhausted                    |
| `last_error`          | text      | Error from most recent retry                       |
| `last_status_code`    | integer   | HTTP status from most recent retry                 |
| `created_at`          | timestamp | Creation timestamp                                 |
| `updated_at`          | timestamp | Last update timestamp                              |

Indexes:

- `next_retry_at` (partial: where `failed_permanently = false`) — for efficient DLQ polling
- `webhook_id`

## 🔧 Configuration

### Delivery Service

```typescript
createWebhookService(db, {
  /** Timeout per HTTP attempt (default: 10s) */
  timeoutMs?: number;

  /** Custom signature header name (default: 'X-Webhook-Signature') */
  signatureHeader?: string;

  /** Optional logger (defaults to console) */
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
});
```

### Retry Job

```typescript
startWebhookRetryJob(db, {
  /** Poll interval in milliseconds (default: 30s) */
  pollIntervalMs?: number;

  /** Timeout per HTTP attempt (default: 10s) */
  timeoutMs?: number;

  /** Batch size for concurrent DLQ processing (default: 15) */
  batchSize?: number;

  /** Custom signature header name (default: 'X-Webhook-Signature') */
  signatureHeader?: string;

  /** Optional logger */
  logger?: typeof console;
});
```

## 🔐 Security

### HMAC Signature Verification

Consumers of your webhooks should verify the signature before processing events:

```typescript
import { createHmac } from 'crypto';

function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  const expected = `sha256=${hmac.digest('hex')}`;
  return signature === expected;
}

// In your webhook consumer:
app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const body = await req.text();

  if (!verifyWebhookSignature(body, signature, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process the webhook...
});
```

## Publishing

Releases are published to [GitHub Packages](https://github.com/Krakaw/webhooks/pkgs/npm/webhooks) automatically when a semver tag is pushed:

```bash
# Bump version in package.json first, then:
git tag v1.2.3
git push --tags
```

The CI pipeline (`.github/workflows/npm-publish.yml`) uses the shared
[`Krakaw/.github` reusable workflow](https://github.com/Krakaw/.github) and will:
1. Run `npm ci` + `npm run build`
2. Publish with npm provenance attestation (SLSA Level 2)
3. Create a GitHub Release with auto-generated notes

---

## Projects Using This Package

---

## 🎯 Migration Guide

### From Calendr's webhookDelivery.ts

If you're migrating from Calendr's built-in webhook system:

1. Install `@krakaw/webhooks`
2. Run migrations (schema is compatible)
3. Replace:
   ```typescript
   import { fireWebhookEvent } from '../services/webhookDelivery';
   ```
   with:
   ```typescript
   import { webhookService } from '../services/webhooks';
   await webhookService.fireEvent('booking.created', payload, userId);
   ```
4. Replace:
   ```typescript
   // In src/index.ts
   import { startWebhookRetryJob } from '../services/webhookRetryJob';
   startWebhookRetryJob();
   ```
   with:
   ```typescript
   import { startWebhookRetryJob } from '@krakaw/webhooks';
   startWebhookRetryJob(db);
   ```
5. Delete:
   - `src/services/webhookDelivery.ts`
   - `src/services/webhookRetryJob.ts`
   - `src/db/schema/webhooks.ts` (now imported from `@krakaw/webhooks`)

## 📈 Observability

### Delivery Tracking

Query recent deliveries:

```sql
SELECT
  wdl.delivery_id,
  wdl.event,
  wdl.attempt,
  wdl.success,
  wdl.status_code,
  wdl.duration_ms,
  wdl.attempted_at
FROM webhook_delivery_log wdl
WHERE wdl.webhook_id = '<webhook-id>'
ORDER BY wdl.attempted_at DESC
LIMIT 50;
```

### DLQ Monitoring

Check failed deliveries awaiting retry:

```sql
SELECT
  dlq.id,
  dlq.event,
  dlq.attempt_count,
  dlq.next_retry_at,
  dlq.failed_permanently,
  dlq.last_error,
  w.name AS webhook_name,
  w.url
FROM webhook_dead_letter_queue dlq
JOIN webhooks w ON w.id = dlq.webhook_id
WHERE dlq.failed_permanently = false
ORDER BY dlq.next_retry_at ASC;
```

### Permanently Failed Deliveries

```sql
SELECT
  dlq.id,
  dlq.event,
  dlq.attempt_count,
  dlq.last_error,
  w.name AS webhook_name,
  w.url
FROM webhook_dead_letter_queue dlq
JOIN webhooks w ON w.id = dlq.webhook_id
WHERE dlq.failed_permanently = true
ORDER BY dlq.updated_at DESC;
```

## 🤝 Contributing

This package is maintained by the Krakaw organization. If you encounter issues or have feature requests, open an issue on GitHub.

## 📝 License

MIT
