/**
 * @krakaw/webhooks - Delivery Service
 *
 * Sends signed outgoing HTTP POST requests to user-registered webhook URLs
 * when application events occur.
 *
 * Security:
 *   Every payload is signed with HMAC-SHA256 using the webhook's stored secret.
 *   The signature is sent in a configurable header (default: `X-Webhook-Signature`) as `sha256=<hex>`.
 *   Override via `WebhookConfig.signatureHeader`.
 *   Consumers should verify the signature before processing events.
 *
 * Retry strategy:
 *   Up to MAX_RETRIES attempts with exponential back-off (1s, 2s, 4s by default).
 *   A delivery is considered successful if the target responds with 2xx.
 *   Failures are logged and the webhook's last_failed_at / last_delivery_status
 *   fields are updated so the user can diagnose issues.
 */

import { createHmac, randomBytes } from 'crypto';
import type { DrizzleDb } from './drizzle-types';
import { webhooks } from './schema';
import { eq, and } from 'drizzle-orm';
import type {
  WebhookEventBase,
  WebhookPayload,
  WebhookConfig,
  DeliveryResult,
} from './types';
import { createDlqService, type DlqService, type DlqConfig } from './dlq';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 10_000; // 10-second timeout per attempt
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000; // 1s, 2s, 4s

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
 * Returns the HTTP status code, or throws on network error / timeout.
 */
async function deliverOnce(
  url: string,
  body: string,
  signature: string,
  deliveryId: string,
  timeoutMs: number,
  signatureHeader: string,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt a single HTTP POST and return a structured result.
 * Used by the retry job for DLQ re-delivery attempts.
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
  const start = Date.now();
  try {
    const statusCode = await deliverOnce(
      url,
      body,
      signature,
      deliveryId,
      timeoutMs,
      signatureHeader,
    );
    return { statusCode, durationMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      statusCode: null,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown network error',
    };
  }
}

/**
 * Deliver a webhook with exponential-back-off retry.
 * Returns { status, ok } where ok is true if a 2xx was received.
 */
async function deliverWithRetry(
  webhookId: string,
  url: string,
  body: string,
  signature: string,
  deliveryId: string,
  config: Required<WebhookConfig>,
): Promise<DeliveryResult> {
  let lastStatus = 0;

  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = config.retryBaseDelayMs * 2 ** (attempt - 1);
      await new Promise((res) => setTimeout(res, delay));
    }

    try {
      lastStatus = await deliverOnce(
        url,
        body,
        signature,
        deliveryId,
        config.timeoutMs,
        config.signatureHeader,
      );
      if (lastStatus >= 200 && lastStatus < 300) {
        config.logger.info(
          { webhookId, url, status: lastStatus, attempt: attempt + 1 },
          '[Webhooks] Delivered successfully',
        );
        return { status: lastStatus, ok: true };
      }
      config.logger.warn(
        { webhookId, url, status: lastStatus, attempt: attempt + 1 },
        '[Webhooks] Non-2xx response, will retry',
      );
    } catch (err) {
      config.logger.warn(
        { webhookId, url, err, attempt: attempt + 1 },
        '[Webhooks] Delivery failed (network/timeout), will retry',
      );
    }
  }

  return { status: lastStatus, ok: false };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a webhook delivery service instance.
 *
 * @param db - Drizzle database instance
 * @param config - Optional configuration overrides
 * @param dlqConfig - Optional DLQ configuration or pre-built DlqService
 *
 * @example
 * ```typescript
 * import { createWebhookService } from '@krakaw/webhooks';
 * import { db } from './db';
 *
 * const webhookService = createWebhookService(db);
 *
 * // Fire an event
 * await webhookService.fireEvent('booking.created', {
 *   bookingId: 'abc123',
 *   slotStart: '2026-02-20T14:00:00Z'
 * }, userId);
 * ```
 */
// Re-export DlqConfig so consumers don't need to import from dlq directly
export type { DlqConfig, DlqService };

export function createWebhookService(
  db: DrizzleDb,
  config: WebhookConfig = {},
  dlqConfig?: DlqConfig | DlqService,
) {
  // Accept either a pre-built DlqService or config to build one
  const dlq: DlqService =
    dlqConfig && typeof (dlqConfig as DlqService).enqueue === 'function'
      ? (dlqConfig as DlqService)
      : createDlqService((dlqConfig as DlqConfig | undefined) ?? {});
  const fullConfig: Required<WebhookConfig> = {
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryBaseDelayMs: config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    logger: config.logger ?? defaultLogger,
    signatureHeader: config.signatureHeader ?? 'X-Webhook-Signature',
  };

  /**
   * Fire a webhook event for the given user.
   *
   * Fetches all enabled webhooks for the user that subscribe to this event
   * (or have an empty events list = "all events"), and delivers the payload
   * to each concurrently.
   *
   * This function never throws — failures are logged and persisted to the DB.
   * Call it with fire-and-forget from route handlers:
   *
   *   webhookService.fireEvent('event.name', data, userId).catch(() => {});
   */
  async function fireEvent<TEvent extends WebhookEventBase>(
    event: TEvent,
    data: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    // Fetch all enabled webhooks for this user
    let userWebhooks;
    try {
      userWebhooks = await db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.userId, userId), eq(webhooks.enabled, true)));
    } catch (err) {
      fullConfig.logger.error(
        { err, userId, event },
        '[Webhooks] Failed to fetch webhooks from DB',
      );
      return;
    }

    if (userWebhooks.length === 0) return;

    // Filter to webhooks that subscribe to this event
    const targets = userWebhooks.filter((wh) => {
      const events = wh.events as string[];
      return events.length === 0 || events.includes(event);
    });

    if (targets.length === 0) return;

    const deliveryId = randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();

    const payload: WebhookPayload<TEvent> = {
      deliveryId,
      event,
      timestamp,
      data,
    };

    const body = JSON.stringify(payload);

    // Deliver to all matching webhooks concurrently
    await Promise.allSettled(
      targets.map(async (wh) => {
        const signature = signPayload(body, wh.secret);

        const { status, ok } = await deliverWithRetry(
          wh.id,
          wh.url,
          body,
          signature,
          deliveryId,
          fullConfig,
        );

        // Update delivery metadata in DB (best-effort)
        try {
          const now = new Date();
          if (ok) {
            await db
              .update(webhooks)
              .set({
                lastDeliveredAt: now,
                lastDeliveryStatus: status,
                updatedAt: now,
              } as any)
              .where(eq(webhooks.id, wh.id));
          } else {
            await db
              .update(webhooks)
              .set({
                lastFailedAt: now,
                lastDeliveryStatus: status,
                updatedAt: now,
              } as any)
              .where(eq(webhooks.id, wh.id));

            // Move to Dead Letter Queue after all retries exhausted
            dlq.enqueue({
              webhookId: wh.id,
              payload: body,
              endpointUrl: wh.url,
              failureReason:
                status === 0
                  ? 'Network error or timeout after all retries'
                  : `HTTP ${status} after all retries`,
              retryCount: fullConfig.maxRetries,
            });
          }
        } catch (err) {
          fullConfig.logger.error(
            { err, webhookId: wh.id },
            '[Webhooks] Failed to update delivery metadata',
          );
        }
      }),
    );
  }

  return {
    fireEvent,
    /** Return all entries currently in the Dead Letter Queue */
    listDeadLetters: dlq.listDeadLetters.bind(dlq),
    /**
     * Retry a specific DLQ entry.
     * @param id - DLQ entry ID
     * @param deliverFn - async function that receives the entry and returns
     *   true on success. If omitted, the service will attempt re-delivery
     *   automatically using the original payload.
     */
    retryDeadLetter: async (
      id: string,
      deliverFn?: (entry: import('./dlq').DeadLetterEntry) => Promise<boolean>,
    ): Promise<boolean> => {
      const fn =
        deliverFn ??
        (async (entry) => {
          // Look up the webhook record to get the real signing secret
          const [wh] = await db
            .select()
            .from(webhooks)
            .where(eq(webhooks.id, entry.webhookId))
            .limit(1);
          if (!wh) {
            fullConfig.logger.warn(
              { webhookId: entry.webhookId },
              '[Webhooks] Webhook not found for DLQ retry — cannot sign payload',
            );
            return false;
          }
          const sig = signPayload(entry.payload, wh.secret);
          const signatureHeader = fullConfig.signatureHeader;
          try {
            const retryDeliveryId = randomBytes(16).toString('hex');
            const status = await deliverOnce(
              entry.endpointUrl,
              entry.payload,
              sig,
              retryDeliveryId,
              fullConfig.timeoutMs,
              signatureHeader,
            );
            return status >= 200 && status < 300;
          } catch {
            return false;
          }
        });
      return dlq.retryDeadLetter(id, fn);
    },
    /**
     * Purge DLQ entries older than `olderThanDays` days.
     * @returns Number of entries removed.
     */
    purgeDeadLetters: dlq.purgeDeadLetters.bind(dlq),
    /** Direct access to the underlying DLQ service */
    dlq,
  };
}
