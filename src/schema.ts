/**
 * @krakaw/webhooks — Drizzle ORM Schema
 *
 * Provides webhooks table + Dead Letter Queue (DLQ) + delivery log
 * for PostgreSQL.
 *
 * Usage:
 *   import { webhooks, webhookDeadLetterQueue, webhookDeliveryLog } from '@krakaw/webhooks';
 *   export { webhooks, webhookDeadLetterQueue, webhookDeliveryLog };
 *
 * Then run:
 *   npx drizzle-kit generate
 *   npx drizzle-kit migrate
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

// ── webhooks ──────────────────────────────────────────────────────────────────

/**
 * Main webhooks table — user-registered outgoing HTTP callbacks.
 *
 * Each webhook has:
 *   - A target URL
 *   - An HMAC-SHA256 signing secret
 *   - A list of subscribed event types (empty = all events)
 *   - Enabled/disabled flag
 *   - Delivery tracking (last delivered, last failed, status code)
 */
export const webhooks = pgTable('webhooks', {
  /** Primary key — UUID */
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),

  /**
   * Optional FK → users.id (or your auth table).
   * Remove this field if you don't have user-based auth.
   */
  userId: text('user_id').notNull(),

  /** Human-readable label */
  name: text('name').notNull().default(''),

  /** Target URL for HTTP POST */
  url: text('url').notNull(),

  /**
   * HMAC-SHA256 signing secret (hex-encoded, 64 chars).
   * Generated on creation; displayed once to the user.
   */
  secret: text('secret').notNull(),

  /**
   * List of event types to subscribe to (e.g. ["booking.created"]).
   * Empty array = subscribe to all events.
   */
  events: jsonb('events').$type<string[]>().notNull().default([]),

  /** Whether this webhook is active */
  enabled: boolean('enabled').notNull().default(true),

  /** Timestamp of the last successful delivery */
  lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),

  /** HTTP status from the last delivery attempt */
  lastDeliveryStatus: integer('last_delivery_status'),

  /** Timestamp of last failed delivery attempt */
  lastFailedAt: timestamp('last_failed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Webhook = typeof webhooks.$inferSelect;
export type NewWebhook = typeof webhooks.$inferInsert;

// ── webhook_delivery_log ──────────────────────────────────────────────────────

/**
 * Immutable log of every HTTP delivery attempt.
 * Written once per attempt — never updated.
 *
 * Enables:
 *   - Debugging failed deliveries
 *   - Audit trail
 *   - Performance analysis
 */
export const webhookDeliveryLog = pgTable(
  'webhook_delivery_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** FK → webhooks.id */
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),

    /** Shared identifier for all attempts of the same delivery */
    deliveryId: text('delivery_id').notNull(),

    /** The event type that triggered the delivery */
    event: text('event').notNull(),

    /** Target URL at the time of the attempt */
    url: text('url').notNull(),

    /** 1-based attempt number (1 = initial, 2+ = retries from DLQ) */
    attempt: integer('attempt').notNull().default(1),

    /** HTTP response status code; NULL on network error / timeout */
    statusCode: integer('status_code'),

    /** True if the attempt received a 2xx response */
    success: boolean('success').notNull().default(false),

    /** Error message, if the attempt failed */
    error: text('error'),

    /** Round-trip time in milliseconds */
    durationMs: integer('duration_ms'),

    attemptedAt: timestamp('attempted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('wdl_webhook_id_idx').on(t.webhookId),
    index('wdl_delivery_id_idx').on(t.deliveryId),
    index('wdl_attempted_at_idx').on(t.attemptedAt),
  ],
);

export type WebhookDeliveryLog = typeof webhookDeliveryLog.$inferSelect;
export type NewWebhookDeliveryLog = typeof webhookDeliveryLog.$inferInsert;

// ── webhook_dead_letter_queue ─────────────────────────────────────────────────

/**
 * Retry delay in milliseconds for each DLQ attempt (1-based index).
 * Default: 1 min, 5 min, 30 min
 */
export const WEBHOOK_RETRY_DELAYS_MS = [
  60_000, // attempt 1: 1 minute
  300_000, // attempt 2: 5 minutes
  1_800_000, // attempt 3: 30 minutes
] as const;

export const MAX_DLQ_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length;

/**
 * Dead-letter queue for failed webhook deliveries.
 *
 * When an immediate delivery fails, a row is inserted here.
 * The retry job polls for rows where next_retry_at <= NOW()
 * and failed_permanently = false.
 *
 * After MAX_DLQ_ATTEMPTS failed retries, failed_permanently is set to true.
 */
export const webhookDeadLetterQueue = pgTable(
  'webhook_dead_letter_queue',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** FK → webhooks.id */
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),

    /** Original delivery ID (same as the failed fire event) */
    deliveryId: text('delivery_id').notNull(),

    /** Event type */
    event: text('event').notNull(),

    /**
     * Full serialised WebhookPayload JSON to re-deliver.
     * Stored as TEXT (not JSONB) to preserve exact byte ordering.
     * JSONB normalises key order and causes HMAC signature drift on retries.
     */
    payload: text('payload').notNull(),

    /** Number of DLQ retry attempts completed so far (0 = not yet retried) */
    attemptCount: integer('attempt_count').notNull().default(0),

    /** When the next retry should be attempted */
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).notNull(),

    /** True when all retries are exhausted */
    failedPermanently: boolean('failed_permanently').notNull().default(false),

    /** Error message from the most recent retry attempt */
    lastError: text('last_error'),

    /** HTTP status from the most recent retry attempt */
    lastStatusCode: integer('last_status_code'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Partial index for efficient DLQ polling
    index('wdlq_next_retry_idx')
      .on(t.nextRetryAt)
      .where(eq(t.failedPermanently, false)),
    index('wdlq_webhook_id_idx').on(t.webhookId),
  ],
);

export type WebhookDeadLetterEntry = typeof webhookDeadLetterQueue.$inferSelect;
export type NewWebhookDeadLetterEntry = typeof webhookDeadLetterQueue.$inferInsert;
