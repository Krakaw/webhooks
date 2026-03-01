/**
 * @krakaw/webhooks
 *
 * Unified webhook infrastructure for Krakaw projects.
 *
 * Features:
 * - HMAC-SHA256 signed webhook delivery
 * - Exponential back-off retry logic
 * - Type-safe event system
 * - Drizzle ORM schema for PostgreSQL
 * - Hono routes for webhook CRUD
 * - Delivery status tracking
 *
 * @example
 * ```typescript
 * import { createWebhookService, createWebhookRoutes, webhooks } from '@krakaw/webhooks';
 * import { db } from './db';
 * import { authMiddleware } from './auth/middleware';
 * 
 * // Export schema in your project's schema file
 * export { webhooks };
 * 
 * // Create delivery service
 * const webhookService = createWebhookService(db);
 * 
 * // Mount routes
 * const webhookRoutes = createWebhookRoutes({
 *   db,
 *   webhookService,
 *   authMiddleware,
 *   validEvents: ['booking.created', 'booking.cancelled'],
 * });
 * 
 * app.route('/webhooks', webhookRoutes);
 * 
 * // Fire events from your business logic
 * await webhookService.fireEvent('booking.created', {
 *   bookingId: 'abc123',
 *   slotStart: '2026-02-20T14:00:00Z'
 * }, userId);
 * ```
 */

export { createWebhookService, generateWebhookSecret } from './delivery';
export { createWebhookRoutes } from './routes';
export { webhooks } from './schema';
export { createDlqService } from './dlq';
export type { WebhookInsert, WebhookSelect } from './schema';
export type {
  WebhookEventBase,
  WebhookPayload,
  Webhook,
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookConfig,
  DeliveryResult,
} from './types';
export type { DeadLetterEntry, DlqEntry, DlqConfig, DlqService } from './dlq';
