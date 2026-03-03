/**
 * @krakaw/webhooks - Retry Job
 *
 * Runs on server startup and periodically polls the `webhook_dead_letter_queue`
 * for entries that are due for retry.
 *
 * Retry schedule (from WEBHOOK_RETRY_DELAYS_MS):
 *   - DLQ attempt 1 (attemptCount 0→1): 1 minute after initial failure
 *   - DLQ attempt 2 (attemptCount 1→2): 5 minutes after the 1st retry failure
 *   - DLQ attempt 3 (attemptCount 2→3): 30 minutes after the 2nd retry failure
 *
 * After MAX_DLQ_ATTEMPTS failed retries, the entry is marked
 * `failed_permanently = true` and left in the table for inspection.
 *
 * The job uses `setInterval` for polling (no Redis/BullMQ dependency).
 * On startup it immediately processes any overdue DLQ entries (entries that
 * were scheduled while the server was down).
 */

import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleDb } from './drizzle-types';
import {
  webhooks,
  webhookDeadLetterQueue,
  webhookDeliveryLog,
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_DLQ_ATTEMPTS,
  type WebhookDeadLetterEntry,
  type Webhook,
} from './schema';
import { eq, and, lte } from 'drizzle-orm';
import { attemptDelivery, signPayload } from './delivery';

// ── Constants ─────────────────────────────────────────────────────────────────

/** How often the retry job polls for due DLQ entries (ms) */
const POLL_INTERVAL_MS = 30_000; // every 30 seconds

/** Maximum number of DLQ entries processed concurrently per poll cycle */
const BATCH_SIZE = 15;

/**
 * Maximum number of due DLQ rows fetched per poll cycle.
 * Caps the SELECT result set to prevent OOM after extended outages.
 * Internal constant — not part of the public API.
 */
const DLQ_QUERY_LIMIT = 100;

// ── Type helpers ──────────────────────────────────────────────────────────────

/**
 * Drizzle 0.36 restricts `PgUpdateSetSource<T>` to columns in `$inferInsert`
 * (i.e. only non-default columns). This means columns that have `.default()`
 * cannot be set via `.set({})` without a cast, even though Drizzle fully
 * supports it at runtime.
 *
 * `TableUpdate<T>` derives the update type from `$inferSelect` (the full column
 * set) instead, allowing all columns to be set while preserving correct value
 * types. Every object passed to `.set()` is first verified with `satisfies
 * Partial<T['$inferSelect']>` before the cast, so field names and types are
 * still checked at compile time.
 */
type TableUpdate<T extends PgTable> = {
  [K in keyof T['$inferSelect']]?: T['$inferSelect'][K] | SQL | null;
};

/**
 * Type-safe helper for building Drizzle update set objects.
 * The `satisfies` check enforces that all keys/values match the table's
 * column types; the cast to `TableUpdate<T>` bridges the gap in Drizzle's
 * 0.36 `PgUpdateSetSource` definition.
 */
function updateSet<T extends PgTable>(
  _table: T,
  values: Partial<T['$inferSelect']> & Record<string, unknown>,
): TableUpdate<T> {
  return values as TableUpdate<T>;
}



// ── Default logger ────────────────────────────────────────────────────────────

const defaultLogger = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
  error: (obj: unknown, msg: string) => console.error(msg, obj),
};

// ── Config ────────────────────────────────────────────────────────────────────

export interface RetryJobConfig {
  /** Poll interval in milliseconds (default: 30s) */
  pollIntervalMs?: number;
  /** Timeout per HTTP attempt (default: 10s) */
  timeoutMs?: number;
  /** Batch size for concurrent DLQ processing (default: 15) */
  batchSize?: number;
  /** Custom signature header name (default: 'X-Webhook-Signature') */
  signatureHeader?: string;
  /** Optional logger */
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

// ── Core retry processor ──────────────────────────────────────────────────────

/**
 * Process a single DLQ entry: re-attempt delivery, update the entry,
 * and schedule the next retry or mark as permanently failed.
 */
export async function processDLQEntry(
  db: DrizzleDb,
  entryId: string,
  config: Required<RetryJobConfig>,
): Promise<void> {
  const { timeoutMs, signatureHeader, logger } = config;

  // ── 1. Atomically claim the entry (SELECT FOR UPDATE SKIP LOCKED) ──────────
  let entry: WebhookDeadLetterEntry | undefined;

  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(webhookDeadLetterQueue)
      .where(
        and(
          eq(webhookDeadLetterQueue.id, entryId),
          eq(webhookDeadLetterQueue.failedPermanently, false),
        ),
      )
      .for('update', { skipLocked: true });

    if (rows.length === 0) return;

    entry = rows[0] as WebhookDeadLetterEntry;

    // Claim with a 1-hour processing lease
    await tx
      .update(webhookDeadLetterQueue)
      .set(updateSet(webhookDeadLetterQueue, { nextRetryAt: new Date(Date.now() + 3_600_000) }))
      .where(eq(webhookDeadLetterQueue.id, entryId));
  });

  if (!entry) return; // row was locked by another worker

  // ── 2. Fetch the webhook ────────────────────────────────────────────────────
  const webhookRows = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, entry.webhookId), eq(webhooks.enabled, true)));

  if (webhookRows.length === 0) {
    // Webhook was deleted or disabled — mark entry abandoned
    await db
      .update(webhookDeadLetterQueue)
      .set(updateSet(webhookDeadLetterQueue, {
        failedPermanently: true,
        lastError: 'Webhook not found or disabled',
        updatedAt: new Date(),
      }))
      .where(eq(webhookDeadLetterQueue.id, entryId));

    logger.warn(
      { entryId, webhookId: entry.webhookId },
      'DLQ entry abandoned — webhook not found or disabled',
    );
    return;
  }

  const webhook = webhookRows[0] as Webhook;

  // ── 3. Re-attempt delivery ──────────────────────────────────────────────────
  const signature = signPayload(entry.payload, webhook.secret);
  const attemptNumber = entry.attemptCount + 1;

  const { statusCode, durationMs, error } = await attemptDelivery(
    webhook.url,
    entry.payload,
    signature,
    entry.deliveryId,
    timeoutMs,
    signatureHeader,
  );

  const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

  // ── 4. Log the retry attempt ────────────────────────────────────────────────
  //
  // Drizzle 0.36 `$inferInsert` only captures non-default columns (url,
  // webhookId, deliveryId, event). Columns with defaults (attempt, statusCode,
  // success, error, durationMs) are valid at runtime but excluded from the
  // inferred insert type. We use `satisfies` to verify value types against the
  // full SELECT type, then cast to `$inferInsert` to satisfy `.values()`.
  const logRow = {
    webhookId: webhook.id,
    deliveryId: entry.deliveryId,
    event: entry.event,
    url: webhook.url,
    attempt: attemptNumber,
    statusCode,
    success,
    error: error ?? null,
    durationMs: durationMs ?? null,
  } satisfies Partial<typeof webhookDeliveryLog.$inferSelect>;
  await db.insert(webhookDeliveryLog).values(logRow as typeof webhookDeliveryLog.$inferInsert);

  // ── 5. Update DLQ entry or mark permanently failed ──────────────────────────
  if (success) {
    // Success — remove from DLQ and update webhook
    await db
      .delete(webhookDeadLetterQueue)
      .where(eq(webhookDeadLetterQueue.id, entryId));

    await db
      .update(webhooks)
      .set(updateSet(webhooks, {
        lastDeliveredAt: new Date(),
        lastDeliveryStatus: statusCode,
        updatedAt: new Date(),
      }))
      .where(eq(webhooks.id, webhook.id));

    logger.info(
      { entryId, webhookId: webhook.id, attemptNumber, statusCode },
      'DLQ retry succeeded',
    );
  } else {
    // Failed — increment attempt count and schedule next retry
    const newAttemptCount = entry.attemptCount + 1;

    if (newAttemptCount >= MAX_DLQ_ATTEMPTS) {
      // Exhausted all retries — mark permanently failed
      await db
        .update(webhookDeadLetterQueue)
        .set(updateSet(webhookDeadLetterQueue, {
          attemptCount: newAttemptCount,
          failedPermanently: true,
          lastError: error ?? `HTTP ${statusCode}`,
          lastStatusCode: statusCode,
          updatedAt: new Date(),
        }))
        .where(eq(webhookDeadLetterQueue.id, entryId));

      await db
        .update(webhooks)
        .set(updateSet(webhooks, {
          lastFailedAt: new Date(),
          lastDeliveryStatus: statusCode,
          updatedAt: new Date(),
        }))
        .where(eq(webhooks.id, webhook.id));

      logger.error(
        { entryId, webhookId: webhook.id, attemptNumber, statusCode, error },
        'DLQ retry permanently failed after max attempts',
      );
    } else {
      // Schedule next retry
      const nextDelay = WEBHOOK_RETRY_DELAYS_MS[newAttemptCount];
      const nextRetryAt = new Date(Date.now() + nextDelay);

      await db
        .update(webhookDeadLetterQueue)
        .set(updateSet(webhookDeadLetterQueue, {
          attemptCount: newAttemptCount,
          nextRetryAt,
          lastError: error ?? `HTTP ${statusCode}`,
          lastStatusCode: statusCode,
          updatedAt: new Date(),
        }))
        .where(eq(webhookDeadLetterQueue.id, entryId));

      await db
        .update(webhooks)
        .set(updateSet(webhooks, {
          lastFailedAt: new Date(),
          lastDeliveryStatus: statusCode,
          updatedAt: new Date(),
        }))
        .where(eq(webhooks.id, webhook.id));

      logger.warn(
        {
          entryId,
          webhookId: webhook.id,
          attemptNumber,
          statusCode,
          error,
          nextRetryAt,
        },
        'DLQ retry failed — scheduled next attempt',
      );
    }
  }
}

// ── Polling logic ─────────────────────────────────────────────────────────────

/**
 * Poll for due DLQ entries and process them in batches.
 */
export async function pollDLQ(
  db: DrizzleDb,
  config: Required<RetryJobConfig>,
  inFlight: Set<Promise<void>>,
): Promise<void> {
  const { batchSize, logger } = config;

  try {
    // Fetch up to DLQ_QUERY_LIMIT due entries
    const dueEntries = await db
      .select()
      .from(webhookDeadLetterQueue)
      .where(
        and(
          lte(webhookDeadLetterQueue.nextRetryAt, new Date()),
          eq(webhookDeadLetterQueue.failedPermanently, false),
        ),
      )
      .limit(DLQ_QUERY_LIMIT);

    if (dueEntries.length === 0) return;

    logger.info(
      { count: dueEntries.length },
      'Processing due DLQ entries',
    );

    // Process in batches to avoid overwhelming the system
    for (let i = 0; i < dueEntries.length; i += batchSize) {
      const batch = dueEntries.slice(i, i + batchSize);
      const batchPromises = batch.map((entry) => {
        const p: Promise<void> = processDLQEntry(db, entry.id, config).finally(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
        return p;
      });
      await Promise.all(batchPromises);
    }
  } catch (err) {
    logger.error({ err }, 'DLQ polling error');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the webhook retry job.
 *
 * @returns An async function to gracefully stop the job. Awaiting it ensures
 *          all in-flight `processDLQEntry` coroutines have settled before the
 *          process exits, preventing stuck DLQ leases on SIGTERM.
 *
 * @example
 * ```typescript
 * const stop = startWebhookRetryJob(db, { pollIntervalMs: 60_000 });
 *
 * // Graceful shutdown (e.g. in SIGTERM handler):
 * await stop();
 * ```
 */
export function startWebhookRetryJob(
  db: DrizzleDb,
  config: RetryJobConfig = {},
): () => Promise<void> {
  const fullConfig: Required<RetryJobConfig> = {
    pollIntervalMs: config.pollIntervalMs ?? POLL_INTERVAL_MS,
    timeoutMs: config.timeoutMs ?? 10_000,
    batchSize: config.batchSize ?? BATCH_SIZE,
    signatureHeader: config.signatureHeader ?? 'X-Webhook-Signature',
    logger: config.logger ?? defaultLogger,
  };

  const { pollIntervalMs, logger } = fullConfig;

  /**
   * Tracks all in-flight processDLQEntry promises.
   * stopRetryJob awaits these to ensure graceful shutdown.
   */
  const inFlight = new Set<Promise<void>>();

  logger.info(
    { pollIntervalMs },
    'Starting webhook DLQ retry job',
  );

  /** Wraps a poll promise so it self-removes from inFlight when settled. */
  function trackPoll(p: Promise<void>): void {
    const tracked: Promise<void> = p.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  }

  // Process any overdue entries immediately (backlog from downtime)
  trackPoll(
    pollDLQ(db, fullConfig, inFlight).catch((err) => {
      logger.error({ err }, 'Initial DLQ poll failed');
    }),
  );

  // Start polling on interval
  const intervalId = setInterval(() => {
    trackPoll(
      pollDLQ(db, fullConfig, inFlight).catch((err) => {
        logger.error({ err }, 'DLQ poll failed');
      }),
    );
  }, pollIntervalMs);

  /**
   * Stops the retry job and awaits all in-flight coroutines.
   * Call this in your SIGTERM / graceful-shutdown handler.
   */
  return async () => {
    clearInterval(intervalId);
    logger.info({}, 'Webhook DLQ retry job stopping — awaiting in-flight tasks');
    await Promise.allSettled(inFlight);
    logger.info({}, 'Webhook DLQ retry job stopped');
  };
}
