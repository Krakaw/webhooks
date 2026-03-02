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
} from './schema';
export type {
  Webhook,
  NewWebhook,
  WebhookDeliveryLog,
  NewWebhookDeliveryLog,
  WebhookDeadLetterEntry,
  NewWebhookDeadLetterEntry,
  WebhookInsert,
  WebhookSelect,
} from './schema';

// ── Delivery Service ──────────────────────────────────────────────────────────
export {
  createWebhookService,
  generateWebhookSecret,
  signPayload,
  attemptDelivery,
} from './delivery';

// ── DLQ ───────────────────────────────────────────────────────────────────────
export { createDlqService } from './dlq';
export type { DeadLetterEntry, DlqConfig, DlqService } from './dlq';

// ── Retry Job ─────────────────────────────────────────────────────────────────
export {
  startWebhookRetryJob,
} from './retryJob';
export type { RetryJobConfig } from './retryJob';

// ── Routes ────────────────────────────────────────────────────────────────────
export { createWebhookRoutes } from './routes';

// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  WebhookEventBase,
  WebhookPayload,
  WebhookConfig,
  DeliveryResult,
} from './types';
