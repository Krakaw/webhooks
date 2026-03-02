/**
 * Tests for the DLQ retry job — covers the 4 processing branches:
 *
 * 1. Successful retry delivery
 * 2. Retry again (still failing, under max attempts)
 * 3. Permanently failed (exceeded max attempts)
 * 4. Webhook disabled during retry
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processDLQEntry } from './retryJob';
import type { RetryJobConfig } from './retryJob';
import { MAX_DLQ_ATTEMPTS } from './schema';

// ── Mock delivery ─────────────────────────────────────────────────────────────

vi.mock('./delivery', () => ({
  signPayload: (_body: string, _secret: string) => 'sha256=mocksig',
  attemptDelivery: vi.fn(),
}));

import { attemptDelivery } from './delivery';
const mockAttemptDelivery = vi.mocked(attemptDelivery);

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date('2026-03-01T00:00:00Z');

function makeConfig(): Required<RetryJobConfig> {
  return {
    pollIntervalMs: 30_000,
    timeoutMs: 10_000,
    batchSize: 15,
    signatureHeader: 'X-Webhook-Signature',
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

function makeDLQEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq-1',
    webhookId: 'wh-1',
    deliveryId: 'delivery-1',
    event: 'booking.created',
    payload: '{"event":"booking.created"}',
    attemptCount: 0,
    nextRetryAt: NOW,
    failedPermanently: false,
    lastError: null,
    lastStatusCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeWebhook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    userId: 'user-1',
    name: 'Test Webhook',
    url: 'https://example.com/hook',
    secret: 'secret',
    events: [],
    enabled: true,
    lastDeliveredAt: null,
    lastDeliveryStatus: null,
    lastFailedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Build a minimal mock DrizzleDb that simulates DB operations.
 * Each call returns the provided data.
 */
function makeDb({
  dlqRows = [makeDLQEntry()],
  webhookRows = [makeWebhook()],
}: {
  dlqRows?: ReturnType<typeof makeDLQEntry>[];
  webhookRows?: ReturnType<typeof makeWebhook>[];
} = {}) {
  const ops = {
    updated: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
    inserted: [] as Array<{ table: string; values: Record<string, unknown> }>,
    deleted: [] as Array<{ table: string; where: unknown }>,
  };

  // Track how many times each table is queried
  let dlqSelectCount = 0;

  const makeChain = (result: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.for = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
    return chain;
  };

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      // Inside transaction: first select returns dlqRows, update is a no-op
      const tx: Record<string, unknown> = {
        select: () => {
          dlqSelectCount++;
          return makeChain(dlqRows);
        },
        update: (_table: unknown) => ({
          set: (_vals: unknown) => ({
            where: (_cond: unknown) => Promise.resolve(),
          }),
        }),
      };
      await fn(tx);
    },
    select: () => {
      // Second select in processDLQEntry is for webhooks table
      return makeChain(webhookRows);
    },
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        ops.inserted.push({ table: 'delivery_log', values: vals });
        return Promise.resolve();
      },
    }),
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          ops.updated.push({ table: String(_table), set: vals, where: cond });
          return Promise.resolve();
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: (cond: unknown) => {
        ops.deleted.push({ table: String(_table), where: cond });
        return Promise.resolve();
      },
    }),
  };

  return { db: db as any, ops };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('processDLQEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('branch 1: successful retry — deletes DLQ entry and updates webhook lastDeliveredAt', async () => {
    mockAttemptDelivery.mockResolvedValue({ statusCode: 200, durationMs: 50, error: null });

    const { db, ops } = makeDb();
    const config = makeConfig();

    await processDLQEntry(db, 'dlq-1', config);

    // DLQ entry should be deleted
    expect(ops.deleted).toHaveLength(1);

    // Webhook should be updated with lastDeliveredAt
    const webhookUpdate = ops.updated.find((u) =>
      Object.keys(u.set).includes('lastDeliveredAt'),
    );
    expect(webhookUpdate).toBeDefined();
    expect(webhookUpdate!.set.lastDeliveryStatus).toBe(200);

    // Delivery log should be inserted
    expect(ops.inserted).toHaveLength(1);
    expect(ops.inserted[0].values.success).toBe(true);

    expect((config.logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200 }),
      'DLQ retry succeeded',
    );
  });

  it('branch 2: retry again — still failing, under max attempts, schedules next retry', async () => {
    mockAttemptDelivery.mockResolvedValue({ statusCode: 503, durationMs: 100, error: null });

    // attemptCount=0, so newAttemptCount=1, which is < MAX_DLQ_ATTEMPTS(3)
    const { db, ops } = makeDb({ dlqRows: [makeDLQEntry({ attemptCount: 0 })] });
    const config = makeConfig();

    await processDLQEntry(db, 'dlq-1', config);

    // DLQ should NOT be deleted
    expect(ops.deleted).toHaveLength(0);

    // DLQ should be updated with incremented attemptCount and nextRetryAt
    const dlqUpdate = ops.updated.find((u) =>
      Object.keys(u.set).includes('nextRetryAt'),
    );
    expect(dlqUpdate).toBeDefined();
    expect(dlqUpdate!.set.attemptCount).toBe(1);
    expect(dlqUpdate!.set.failedPermanently).toBeFalsy();
    expect(dlqUpdate!.set.nextRetryAt).toBeInstanceOf(Date);

    // Webhook lastFailedAt should be updated
    const webhookUpdate = ops.updated.find((u) =>
      Object.keys(u.set).includes('lastFailedAt'),
    );
    expect(webhookUpdate).toBeDefined();

    expect((config.logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 503 }),
      'DLQ retry failed — scheduled next attempt',
    );
  });

  it('branch 3: permanently failed — exceeded max attempts, sets failedPermanently=true', async () => {
    mockAttemptDelivery.mockResolvedValue({ statusCode: 500, durationMs: 80, error: 'Server Error' });

    // attemptCount = MAX_DLQ_ATTEMPTS - 1, so newAttemptCount = MAX_DLQ_ATTEMPTS → exhausted
    const { db, ops } = makeDb({
      dlqRows: [makeDLQEntry({ attemptCount: MAX_DLQ_ATTEMPTS - 1 })],
    });
    const config = makeConfig();

    await processDLQEntry(db, 'dlq-1', config);

    // DLQ should NOT be deleted
    expect(ops.deleted).toHaveLength(0);

    // DLQ should be marked permanently failed
    const dlqUpdate = ops.updated.find((u) =>
      u.set.failedPermanently === true,
    );
    expect(dlqUpdate).toBeDefined();
    expect(dlqUpdate!.set.attemptCount).toBe(MAX_DLQ_ATTEMPTS);

    expect((config.logger.error as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
      'DLQ retry permanently failed after max attempts',
    );
  });

  it('branch 4: webhook disabled during retry — marks DLQ entry as permanently failed', async () => {
    // Simulate webhook not found / disabled: webhookRows empty
    const { db, ops } = makeDb({ webhookRows: [] });
    const config = makeConfig();

    await processDLQEntry(db, 'dlq-1', config);

    // attemptDelivery should never be called
    expect(mockAttemptDelivery).not.toHaveBeenCalled();

    // DLQ entry should be updated with failedPermanently=true
    const dlqUpdate = ops.updated.find((u) =>
      u.set.failedPermanently === true,
    );
    expect(dlqUpdate).toBeDefined();
    expect(dlqUpdate!.set.lastError).toBe('Webhook not found or disabled');

    expect((config.logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 'wh-1' }),
      'DLQ entry abandoned — webhook not found or disabled',
    );
  });
});
