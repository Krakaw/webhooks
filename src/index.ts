/**
 * @krakaw/webhooks - Unified Webhook Infrastructure
 *
 * Production-ready webhook delivery system with:
 *   - HMAC-SHA256 signed delivery
 *   - Dead Letter Queue (DLQ) for failed deliveries
 *   - Automatic retry with exponential delays
 *   - Comprehensive delivery logging
 *   - Type-safe event system
 *
 * @example
 * ```typescript
 * import { createWebhookService, startWebhookRetryJob } from '@krakaw/webhooks';
 *
 * // 1. Create delivery service
 * const webhookService = createWebhookService(db, {
 *   timeoutMs: 10_000,
 *   signatureHeader: 'X-MyApp-Signature',
 * });
 *
 * // 2. Start retry job (polls DLQ every 30s)
 * const stopRetryJob = startWebhookRetryJob(db, {
 *   pollIntervalMs: 30_000,
 * });
 *
 * // 3. Fire events from your business logic
 * await webhookService.fireEvent('booking.created', { bookingId: '123' }, 'user-1');
 * ```
 */

// ── Schema ────────────────────────────────────────────────────────────────────
export {
  webhooks,
  webhookDeliveryLog,
  webhookDeadLetterQueue,
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_DLQ_ATTEMPTS,
  type Webhook,
  type NewWebhook,
  type WebhookDeliveryLog,
  type NewWebhookDeliveryLog,
  type WebhookDeadLetterEntry,
  type NewWebhookDeadLetterEntry,
} from './schema';

// ── Delivery Service ──────────────────────────────────────────────────────────
export {
  createWebhookService,
  generateWebhookSecret,
  signPayload,
  attemptDelivery,
  type WebhookServiceConfig,
} from './delivery';

// ── Retry Job ─────────────────────────────────────────────────────────────────
export {
  startWebhookRetryJob,
  DLQ_QUERY_LIMIT,
  type RetryJobConfig,
} from './retryJob';

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  WebhookEventBase,
  WebhookPayload,
  WebhookConfig,
  DeliveryResult,
} from './types';

// ── Hono Routes (optional) ────────────────────────────────────────────────────
export { createWebhookRoutes } from './routes';
