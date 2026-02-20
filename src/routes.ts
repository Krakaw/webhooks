/**
 * @krakaw/webhooks - Hono Routes
 *
 * REST API for managing webhook subscriptions.
 * All routes require authentication middleware to populate c.get('userId').
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { createWebhookRoutes } from '@krakaw/webhooks/routes';
 * import { authMiddleware } from './auth/middleware';
 * import { db } from './db';
 * import { webhookService } from './services/webhooks';
 * 
 * const app = new Hono();
 * 
 * const webhookRoutes = createWebhookRoutes({
 *   db,
 *   webhookService,
 *   authMiddleware,
 *   validEvents: ['booking.created', 'booking.cancelled'],
 * });
 * 
 * app.route('/webhooks', webhookRoutes);
 * ```
 */

import { Hono } from 'hono';
import type { DrizzleDb } from './drizzle-types';
import { webhooks } from './schema';
import { eq, and } from 'drizzle-orm';
import { generateWebhookSecret } from './delivery';
import type { WebhookEventBase } from './types';

export interface WebhookRoutesConfig<TEvent extends WebhookEventBase = string> {
  /** Drizzle database instance */
  db: DrizzleDb;
  /** Webhook delivery service instance */
  webhookService: {
    fireEvent: (event: TEvent, data: Record<string, unknown>, userId: string) => Promise<void>;
  };
  /** Auth middleware that sets c.get('userId') */
  authMiddleware: (c: any, next: () => Promise<void>) => Promise<void | Response>;
  /** Valid event types for this project */
  validEvents: readonly TEvent[];
  /** Optional custom logger */
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

const defaultLogger = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
  error: (obj: unknown, msg: string) => console.error(msg, obj),
};

/**
 * Create Hono routes for webhook management.
 * 
 * Routes:
 * - GET    /          — List all webhooks for the current user
 * - POST   /          — Register a new webhook
 * - GET    /:id       — Get a single webhook
 * - PATCH  /:id       — Update a webhook
 * - DELETE /:id       — Delete a webhook
 * - POST   /:id/test  — Send a test ping
 */
export function createWebhookRoutes<TEvent extends WebhookEventBase = string>(
  config: WebhookRoutesConfig<TEvent>,
) {
  const { db, webhookService, authMiddleware, validEvents } = config;
  const logger = config.logger ?? defaultLogger;
  const app = new Hono();

  // All webhook routes require authentication
  app.use('*', authMiddleware);

  // ─── GET / ────────────────────────────────────────────────────────────────
  app.get('/', async (c) => {
    const userId = c.get('userId');

    const rows = await db
      .select({
        id: webhooks.id,
        name: webhooks.name,
        url: webhooks.url,
        events: webhooks.events,
        enabled: webhooks.enabled,
        lastDeliveredAt: webhooks.lastDeliveredAt,
        lastDeliveryStatus: webhooks.lastDeliveryStatus,
        lastFailedAt: webhooks.lastFailedAt,
        createdAt: webhooks.createdAt,
        updatedAt: webhooks.updatedAt,
      })
      .from(webhooks)
      .where(eq(webhooks.userId, userId));

    return c.json({ webhooks: rows });
  });

  // ─── POST / ───────────────────────────────────────────────────────────────
  app.post('/', async (c) => {
    const userId = c.get('userId');

    let body: { url?: string; name?: string; events?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { url, name = '', events = [] } = body;

    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }

    // Basic URL validation
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return c.json({ error: 'url must use http or https' }, 400);
      }
    } catch {
      return c.json({ error: 'url is not a valid URL' }, 400);
    }

    // Validate events list
    if (!Array.isArray(events)) {
      return c.json({ error: 'events must be an array' }, 400);
    }
    const invalidEvents = events.filter((e) => !validEvents.includes(e as TEvent));
    if (invalidEvents.length > 0) {
      return c.json(
        {
          error: `Invalid event types: ${invalidEvents.join(', ')}. Valid events: ${validEvents.join(', ')}`,
        },
        400,
      );
    }

    const secret = generateWebhookSecret();

    const [created] = await db
      .insert(webhooks)
      .values({
        userId,
        name: typeof name === 'string' ? name : '',
        url,
        secret,
        events: events as string[],
        enabled: true,
      })
      .returning();

    logger.info({ webhookId: created.id, userId, url }, '[Webhooks] New webhook registered');

    // Return the secret in the creation response (only time it's shown)
    return c.json({ webhook: { ...created, secret } }, 201);
  });

  // ─── GET /:id ─────────────────────────────────────────────────────────────
  app.get('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [wh] = await db
      .select({
        id: webhooks.id,
        name: webhooks.name,
        url: webhooks.url,
        events: webhooks.events,
        enabled: webhooks.enabled,
        lastDeliveredAt: webhooks.lastDeliveredAt,
        lastDeliveryStatus: webhooks.lastDeliveryStatus,
        lastFailedAt: webhooks.lastFailedAt,
        createdAt: webhooks.createdAt,
        updatedAt: webhooks.updatedAt,
      })
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));

    if (!wh) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    return c.json({ webhook: wh });
  });

  // ─── PATCH /:id ───────────────────────────────────────────────────────────
  app.patch('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    // Verify ownership
    const [existing] = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));

    if (!existing) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    let body: {
      name?: string;
      url?: string;
      events?: unknown;
      enabled?: boolean;
      rotateSecret?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const updates: Partial<typeof webhooks.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (typeof body.name === 'string') updates.name = body.name;
    if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;

    if (typeof body.url === 'string') {
      try {
        const parsed = new URL(body.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return c.json({ error: 'url must use http or https' }, 400);
        }
      } catch {
        return c.json({ error: 'url is not a valid URL' }, 400);
      }
      updates.url = body.url;
    }

    if (Array.isArray(body.events)) {
      const invalid = body.events.filter((e) => !validEvents.includes(e as TEvent));
      if (invalid.length > 0) {
        return c.json({ error: `Invalid event types: ${invalid.join(', ')}` }, 400);
      }
      updates.events = body.events as string[];
    }

    let newSecret: string | undefined;
    if (body.rotateSecret === true) {
      newSecret = generateWebhookSecret();
      updates.secret = newSecret;
    }

    const [updated] = await db
      .update(webhooks)
      .set(updates)
      .where(eq(webhooks.id, id))
      .returning({
        id: webhooks.id,
        name: webhooks.name,
        url: webhooks.url,
        events: webhooks.events,
        enabled: webhooks.enabled,
        lastDeliveredAt: webhooks.lastDeliveredAt,
        lastDeliveryStatus: webhooks.lastDeliveryStatus,
        lastFailedAt: webhooks.lastFailedAt,
        updatedAt: webhooks.updatedAt,
      });

    logger.info({ webhookId: id, userId }, '[Webhooks] Webhook updated');

    return c.json({
      webhook: updated,
      // Only include secret if it was just rotated
      ...(newSecret ? { secret: newSecret } : {}),
    });
  });

  // ─── DELETE /:id ──────────────────────────────────────────────────────────
  app.delete('/:id', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [deleted] = await db
      .delete(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)))
      .returning({ id: webhooks.id });

    if (!deleted) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    logger.info({ webhookId: id, userId }, '[Webhooks] Webhook deleted');

    return c.json({ success: true });
  });

  // ─── POST /:id/test ───────────────────────────────────────────────────────
  app.post('/:id/test', async (c) => {
    const userId = c.get('userId');
    const id = c.req.param('id');

    const [wh] = await db
      .select({ id: webhooks.id, url: webhooks.url })
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.userId, userId)));

    if (!wh) {
      return c.json({ error: 'Webhook not found' }, 404);
    }

    // Fire a synthetic test event with the first valid event type
    const testData = {
      test: true,
      timestamp: new Date().toISOString(),
      message: 'This is a test webhook delivery',
    };

    // Fire asynchronously — don't block the response waiting for delivery
    void webhookService.fireEvent(validEvents[0], testData, userId);

    logger.info({ webhookId: id, userId, url: wh.url }, '[Webhooks] Test ping queued');

    return c.json({ success: true, message: 'Test ping queued for delivery' });
  });

  return app;
}
