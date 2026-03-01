# Changelog

All notable changes to `@krakaw/webhooks` are documented here.

## [0.2.0] - 2026-03-01

### Added

#### Dead Letter Queue (DLQ)

When a webhook delivery fails after all retry attempts (exponential backoff),
the failed delivery is automatically moved to a Dead Letter Queue for
inspection, manual retry, and purging.

**New export: `createDlqService(config?)`**

Standalone DLQ factory. Accepts optional `persistencePath` (path to a
SQLite database file) for persistence across restarts. Falls back to
in-memory if `better-sqlite3` is not installed.

**New methods on `createWebhookService` return value:**

- `listDeadLetters()` — returns all DLQ entries, newest first.
- `retryDeadLetter(id, deliverFn?)` — retry a specific DLQ entry. If
  `deliverFn` is omitted the service re-attempts HTTP delivery automatically.
  On success the entry is removed from the DLQ. On failure the retry count
  and failure reason are updated.
- `purgeDeadLetters(olderThanDays)` — remove DLQ entries older than the
  given number of days. Returns the count of purged entries.
- `dlq` — direct access to the underlying `DlqService` instance.

**New types:**

- `DeadLetterEntry` / `DlqEntry` — shape of a DLQ record
  (`id`, `webhookId`, `payload`, `endpointUrl`, `failureReason`,
  `failedAt`, `retryCount`)
- `DlqConfig` — configuration for `createDlqService`
- `DlqService` — return type of `createDlqService`

**DLQ persistence (optional):**

```typescript
import { createWebhookService } from '@krakaw/webhooks';

const webhookService = createWebhookService(db, {}, {
  persistencePath: './data/dlq.sqlite',  // requires better-sqlite3
});
```

Without `persistencePath` the DLQ is in-memory only (default).

### Changed

- `createWebhookService(db, config?, dlqConfig?)` — accepts an optional
  third argument: either a `DlqConfig` object or a pre-built `DlqService`.

## [0.1.0] - 2026-02-01

### Added

- Initial release
- HMAC-SHA256 signed webhook delivery
- Exponential back-off retry logic (configurable attempts/timeouts/delays)
- Type-safe event system with `WebhookEventBase`
- Drizzle ORM schema for PostgreSQL (`webhooks` table)
- Hono routes for webhook CRUD (list, create, update, delete, test)
- Delivery tracking (`lastDeliveredAt`, `lastFailedAt`, `lastDeliveryStatus`)
