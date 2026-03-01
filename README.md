# @krakaw/webhooks

Unified webhook infrastructure for Krakaw projects - HMAC-signed delivery, retry logic, management API.

## Features

- ✅ **HMAC-SHA256 signed delivery** with `X-Webhook-Signature` header
- ✅ **Exponential back-off retry** (configurable attempts, timeouts, delays)
- ✅ **Type-safe event system** — define your own event unions
- ✅ **Drizzle ORM schema** for PostgreSQL
- ✅ **Hono routes** for webhook CRUD (list, create, update, delete, test)
- ✅ **Delivery tracking** — last delivered/failed timestamps and HTTP status
- ✅ **Zero dependencies** (peerDependencies: drizzle-orm, hono)

## Installation

```bash
npm install @krakaw/webhooks drizzle-orm hono
```

## Usage

### 1. Add the schema to your database

```typescript
// src/db/schema/index.ts
import { webhooks } from '@krakaw/webhooks';

export { webhooks };
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
  maxRetries: 3,
  timeoutMs: 10_000,
  retryBaseDelayMs: 1_000,
  logger: myCustomLogger, // optional
});
```

### 3. Mount the routes

```typescript
// src/index.ts or src/routes/index.ts
import { Hono } from 'hono';
import { createWebhookRoutes } from '@krakaw/webhooks';
import { authMiddleware } from './auth/middleware';
import { db } from './db';
import { webhookService } from './services/webhooks';

const app = new Hono();

// Define your project's webhook events
type MyProjectEvents = 'booking.created' | 'booking.cancelled' | 'transcript.ready';

const webhookRoutes = createWebhookRoutes<MyProjectEvents>({
  db,
  webhookService,
  authMiddleware, // Must set c.get('userId')
  validEvents: ['booking.created', 'booking.cancelled', 'transcript.ready'],
});

app.route('/webhooks', webhookRoutes);
```

### 4. Fire events from your business logic

```typescript
import { webhookService } from './services/webhooks';

// When a booking is created
await webhookService.fireEvent('booking.created', {
  bookingId: 'abc123',
  linkSlug: 'keith-30min',
  slotStart: '2026-02-20T14:00:00Z',
  slotEnd: '2026-02-20T14:30:00Z',
  attendees: [{ name: 'Keith', email: 'keith@example.com' }],
}, userId);
```

## API Routes

All routes require authentication middleware that sets `c.get('userId')`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhooks` | List all webhooks for the current user |
| `POST` | `/webhooks` | Register a new webhook (returns secret once) |
| `GET` | `/webhooks/:id` | Get a single webhook |
| `PATCH` | `/webhooks/:id` | Update webhook (url, name, events, enabled, rotate secret) |
| `DELETE` | `/webhooks/:id` | Delete a webhook |
| `POST` | `/webhooks/:id/test` | Send a test ping to the webhook URL |

## Webhook Payload Format

All webhook deliveries follow this structure:

```json
{
  "deliveryId": "abc123...",
  "event": "booking.created",
  "timestamp": "2026-02-20T14:00:00Z",
  "data": {
    "bookingId": "abc123",
    "slotStart": "2026-02-20T14:00:00Z",
    ...
  }
}
```

### Signature Verification

The `X-Webhook-Signature` header contains `sha256=<hex-digest>` computed over the raw JSON body:

```typescript
import { createHmac } from 'crypto';

function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return signature === `sha256=${expected}`;
}
```

## Configuration

```typescript
const webhookService = createWebhookService(db, {
  maxRetries: 3,              // Max delivery attempts (default: 3)
  timeoutMs: 10_000,          // Timeout per attempt (default: 10s)
  retryBaseDelayMs: 1_000,    // Base delay for exponential back-off (default: 1s → 1s, 2s, 4s)
  logger: {                   // Optional custom logger
    info: (obj, msg) => {},
    warn: (obj, msg) => {},
    error: (obj, msg) => {},
  },
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

- **Calendr** — Booking lifecycle events (created, confirmed, cancelled, rescheduled)
- **Psych-transcribe** — Transcript ready notifications
- **Roundup** — Group roundup published events
- **Second Brain** — Document updates, kanban card changes

## License

MIT © 2026 Krakaw
