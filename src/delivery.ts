/**
 * @krakaw/webhooks - Delivery Service
 *
 * Sends signed outgoing HTTP POST requests to user-registered webhook URLs
 * when application events occur.
 *
 * Security:
 *   Every payload is signed with HMAC-SHA256 using the webhook's stored secret.
 *   The signature is sent in the `X-Webhook-Signature` header as `sha256=<hex>`.
 *   Consumers should verify the signature before processing events.
 *
 * Retry strategy:
 *   - One immediate delivery attempt is made per webhook.
 *   - On failure, the delivery is placed in the `webhook_dead_letter_queue`.
 *   - The retry job (see retryJob.ts) processes the DLQ periodically.
 *   - Retry schedule: +1 min, +5 min, +30 min (configurable).
 *   - After MAX_DLQ_ATTEMPTS failed retries, the entry is marked permanently failed.
 *   - Every attempt (success or failure) is logged to `webhook_delivery_log`.
 */

import { createHmac, randomBytes } from 'crypto';
import type { DrizzleDb } from './drizzle-types';
import {
  webhooks,
  webhookDeliveryLog,
  webhookDeadLetterQueue,
  WEBHOOK_RETRY_DELAYS_MS,
} from './schema';
import { eq, and } from 'drizzle-orm';
import type {
  WebhookEventBase,
  WebhookPayload,
  WebhookConfig,
  DeliveryResult,
} from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000; // 10-second timeout per attempt

// ── Default logger ────────────────────────────────────────────────────────────

const defaultLogger = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
  error: (obj: unknown, msg: string) => console.error(msg, obj),
};

// ── HMAC signing ─────────────────────────────────────────────────────────────

/**
 * Sign a JSON payload body with HMAC-SHA256.
 * Returns the hex digest prefixed with "sha256=".
 */
export function signPayload(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Generate a cryptographically random webhook secret.
 * 32 bytes = 256 bits of entropy, hex-encoded (64 chars).
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

// ── Delivery ──────────────────────────────────────────────────────────────────

/**
 * Attempt a single HTTP POST to the given URL with the signed payload.
 * Returns { statusCode, durationMs, error? }.
 */
export async function attemptDelivery(
  url: string,
  body: string,
  signature: string,
  deliveryId: string,
  timeoutMs: number,
  signatureHeader: string,
): Promise<{ statusCode: number | null; durationMs: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [signatureHeader]: signature,
        'X-Webhook-Delivery': deliveryId,
        'User-Agent': 'Krakaw-Webhooks/2.0',
      },
      body,
      signal: controller.signal,
    });

    const durationMs = Date.now() - start;
    return { statusCode: res.status, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const error =
      err instanceof Error ? err.message : 'Unknown network error';
    return { statusCode: null, durationMs, error };
  } finally {
    clearTimeout(timer);
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface WebhookServiceConfig {
  /** Timeout per HTTP attempt (default: 10s) */
  timeoutMs?: number;
  /** Optional logger (defaults to console) */
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  /** Custom signature header name (default: 'X-Webhook-Signature') */
  signatureHeader?: string;
}

/**
 * Webhook delivery service.
 *
 * Usage:
 *   const service = createWebhookService(db, config);
 *   await service.fireEvent('booking.created', { bookingId: '123' }, 'user-1');
 */
export function createWebhookService<TEvent extends WebhookEventBase>(
  db: DrizzleDb,
  config: WebhookServiceConfig = {},
) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = defaultLogger,
    signatureHeader = 'X-Webhook-Signature',
  } = config;

  /**
   * Fire a webhook event to all matching webhooks for the given user.
   *
   * @param event - The event type (e.g. 'booking.created')
   * @param data - Event-specific payload data
   * @param userId - The user whose webhooks to trigger
   * @returns Array of delivery results (one per webhook)
   */
  async function fireEvent(
    event: TEvent,
    data: Record<string, unknown>,
    userId: string,
  ): Promise<DeliveryResult[]> {
    // 1. Fetch all enabled webhooks for this user that subscribe to this event
    const userWebhooks = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.userId, userId), eq(webhooks.enabled, true)));

    const matchingWebhooks = userWebhooks.filter((wh) => {
      const subscribedEvents = wh.events as string[];
      return (
        subscribedEvents.length === 0 || subscribedEvents.includes(event)
      );
    });

    if (matchingWebhooks.length === 0) {
      logger.info({ event, userId }, 'No matching webhooks');
      return [];
    }

    // 2. Deliver to each webhook (in parallel)
    const results = await Promise.all(
      matchingWebhooks.map((wh) => deliverToWebhook(wh, event, data)),
    );

    return results;
  }

  /**
   * Deliver a single webhook event.
   * Logs to delivery_log, updates the webhook record, and enqueues to DLQ on failure.
   */
  async function deliverToWebhook(
    webhook: typeof webhooks.$inferSelect,
    event: TEvent,
    data: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const deliveryId = randomBytes(16).toString('hex');
    const payload: WebhookPayload<TEvent> = {
      deliveryId,
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    const body = JSON.stringify(payload);
    const signature = signPayload(body, webhook.secret);

    // Attempt delivery
    const start = Date.now();
    const { statusCode, durationMs, error } = await attemptDelivery(
      webhook.url,
      body,
      signature,
      deliveryId,
      timeoutMs,
      signatureHeader,
    );

    const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

    // Log the attempt
    await db.insert(webhookDeliveryLog).values({
      webhookId: webhook.id,
      deliveryId,
      event,
      url: webhook.url,
      attempt: 1,
      statusCode,
      success,
      error: error ?? null,
      durationMs,
    });

    // Update webhook record
    if (success) {
      await db
        .update(webhooks)
        .set({
          lastDeliveredAt: new Date(),
          lastDeliveryStatus: statusCode,
          updatedAt: new Date(),
        })
        .where(eq(webhooks.id, webhook.id));

      logger.info(
        { webhookId: webhook.id, event, statusCode, durationMs },
        'Webhook delivered successfully',
      );
    } else {
      // Failed — update webhook and enqueue to DLQ
      await db
        .update(webhooks)
        .set({
          lastFailedAt: new Date(),
          lastDeliveryStatus: statusCode,
          updatedAt: new Date(),
        })
        .where(eq(webhooks.id, webhook.id));

      // Enqueue to DLQ for retry
      const nextRetryAt = new Date(Date.now() + WEBHOOK_RETRY_DELAYS_MS[0]);
      await db.insert(webhookDeadLetterQueue).values({
        webhookId: webhook.id,
        deliveryId,
        event,
        payload: body, // Store as TEXT to preserve HMAC signature
        attemptCount: 0,
        nextRetryAt,
        failedPermanently: false,
        lastError: error ?? `HTTP ${statusCode}`,
        lastStatusCode: statusCode,
      });

      logger.warn(
        { webhookId: webhook.id, event, error, statusCode },
        'Webhook delivery failed — enqueued to DLQ',
      );
    }

    return {
      webhookId: webhook.id,
      deliveryId,
      success,
      statusCode,
      error: error ?? undefined,
    };
  }

  return { fireEvent };
}
