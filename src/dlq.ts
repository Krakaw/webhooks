/**
 * @krakaw/webhooks - Dead Letter Queue (DLQ)
 *
 * When a webhook delivery fails after all retries, the failed delivery is
 * recorded in the DLQ for inspection, manual retry, and purging.
 *
 * The DLQ is in-memory by default. Pass `persistencePath` to enable SQLite
 * persistence so entries survive process restarts.
 */

import { randomBytes } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeadLetterEntry {
  /** Unique DLQ entry ID */
  id: string;
  /** Original webhook registration ID */
  webhookId: string;
  /** Serialised JSON payload that was being delivered */
  payload: string;
  /** Target endpoint URL */
  endpointUrl: string;
  /** Human-readable reason for final failure */
  failureReason: string;
  /** When the entry was added to the DLQ */
  failedAt: Date;
  /** Total number of delivery attempts that were made */
  retryCount: number;
}

export interface DlqConfig {
  /**
   * Optional path to a SQLite database file for persistent storage.
   * If omitted the DLQ is held in memory only.
   */
  persistencePath?: string;

  /**
   * Custom logger. Defaults to console.
   */
  logger?: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

// ── Internal store ────────────────────────────────────────────────────────────

const defaultLogger = {
  info: (obj: unknown, msg: string) => console.log(msg, obj),
  warn: (obj: unknown, msg: string) => console.warn(msg, obj),
  error: (obj: unknown, msg: string) => console.error(msg, obj),
};

// ── SQLite persistence layer (optional) ───────────────────────────────────────

interface SqliteDb {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => void;
  };
}

function openSqlite(path: string): SqliteDb | null {
  try {
    // Dynamically require better-sqlite3 so it remains optional
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db: SqliteDb = new Database(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_dead_letter_queue (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        failure_reason TEXT NOT NULL,
        failed_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    return db;
  } catch (err) {
    console.error('[Webhooks/DLQ] Failed to open SQLite:', err);
    return null;
  }
}

function rowToEntry(row: unknown): DeadLetterEntry {
  const r = row as Record<string, unknown>;
  return {
    id: r['id'] as string,
    webhookId: r['webhook_id'] as string,
    payload: r['payload'] as string,
    endpointUrl: r['endpoint_url'] as string,
    failureReason: r['failure_reason'] as string,
    failedAt: new Date(r['failed_at'] as string),
    retryCount: r['retry_count'] as number,
  };
}

// ── DLQ Service factory ───────────────────────────────────────────────────────

/**
 * Create a Dead Letter Queue service.
 *
 * @example
 * ```typescript
 * import { createDlqService } from '@krakaw/webhooks';
 *
 * const dlq = createDlqService({ persistencePath: './data/dlq.sqlite' });
 *
 * // Enqueue a failed delivery
 * await dlq.enqueue({ webhookId, payload, endpointUrl, failureReason, retryCount });
 *
 * // List all entries
 * const entries = await dlq.listDeadLetters();
 *
 * // Retry one entry (fires the deliverFn you supply)
 * await dlq.retryDeadLetter(id, async (entry) => { ... });
 *
 * // Purge entries older than 30 days
 * await dlq.purgeDeadLetters(30);
 * ```
 */
export function createDlqService(config: DlqConfig = {}) {
  const logger = config.logger ?? defaultLogger;
  const inMemory = new Map<string, DeadLetterEntry>();
  const sqlite = config.persistencePath ? openSqlite(config.persistencePath) : null;

  if (config.persistencePath && !sqlite) {
    logger.warn(
      { path: config.persistencePath },
      '[Webhooks/DLQ] better-sqlite3 not available — falling back to in-memory DLQ',
    );
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  function persist(entry: DeadLetterEntry): void {
    inMemory.set(entry.id, entry);
    if (sqlite) {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO webhook_dead_letter_queue
           (id, webhook_id, payload, endpoint_url, failure_reason, failed_at, retry_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.webhookId,
          entry.payload,
          entry.endpointUrl,
          entry.failureReason,
          entry.failedAt.toISOString(),
          entry.retryCount,
        );
    }
  }

  function remove(id: string): void {
    inMemory.delete(id);
    if (sqlite) {
      sqlite.prepare('DELETE FROM webhook_dead_letter_queue WHERE id = ?').run(id);
    }
  }

  function getAll(): DeadLetterEntry[] {
    if (sqlite) {
      return sqlite
        .prepare('SELECT * FROM webhook_dead_letter_queue ORDER BY failed_at DESC')
        .all()
        .map(rowToEntry);
    }
    return Array.from(inMemory.values()).sort(
      (a, b) => b.failedAt.getTime() - a.failedAt.getTime(),
    );
  }

  function getById(id: string): DeadLetterEntry | undefined {
    if (sqlite) {
      const row = sqlite
        .prepare('SELECT * FROM webhook_dead_letter_queue WHERE id = ?')
        .all(id)[0];
      return row ? rowToEntry(row) : undefined;
    }
    return inMemory.get(id);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Add a failed delivery to the DLQ.
   */
  function enqueue(params: {
    webhookId: string;
    payload: string;
    endpointUrl: string;
    failureReason: string;
    retryCount: number;
  }): DeadLetterEntry {
    const entry: DeadLetterEntry = {
      id: randomBytes(16).toString('hex'),
      webhookId: params.webhookId,
      payload: params.payload,
      endpointUrl: params.endpointUrl,
      failureReason: params.failureReason,
      failedAt: new Date(),
      retryCount: params.retryCount,
    };
    persist(entry);
    logger.info(
      { id: entry.id, webhookId: entry.webhookId },
      '[Webhooks/DLQ] Entry enqueued',
    );
    return entry;
  }

  /**
   * Return all entries currently in the DLQ, newest first.
   */
  function listDeadLetters(): DeadLetterEntry[] {
    return getAll();
  }

  /**
   * Retry a specific DLQ entry.
   *
   * @param id - DLQ entry ID
   * @param deliverFn - async function that attempts re-delivery; resolves to
   *   `true` on success (2xx) or `false`/throws on failure
   * @returns `true` if delivery succeeded and entry was removed from DLQ,
   *   `false` otherwise (entry remains for future inspection)
   */
  async function retryDeadLetter(
    id: string,
    deliverFn: (entry: DeadLetterEntry) => Promise<boolean>,
  ): Promise<boolean> {
    const entry = getById(id);
    if (!entry) {
      logger.warn({ id }, '[Webhooks/DLQ] retryDeadLetter: entry not found');
      return false;
    }

    logger.info({ id, webhookId: entry.webhookId }, '[Webhooks/DLQ] Retrying entry');

    try {
      const ok = await deliverFn(entry);
      if (ok) {
        remove(id);
        logger.info({ id }, '[Webhooks/DLQ] Retry succeeded — entry removed');
        return true;
      } else {
        // Update retry count
        const updated: DeadLetterEntry = {
          ...entry,
          retryCount: entry.retryCount + 1,
          failedAt: new Date(),
          failureReason: 'Retry failed',
        };
        persist(updated);
        logger.warn({ id }, '[Webhooks/DLQ] Retry failed — entry updated');
        return false;
      }
    } catch (err) {
      const updated: DeadLetterEntry = {
        ...entry,
        retryCount: entry.retryCount + 1,
        failedAt: new Date(),
        failureReason: err instanceof Error ? err.message : String(err),
      };
      persist(updated);
      logger.error({ id, err }, '[Webhooks/DLQ] Retry threw — entry updated');
      return false;
    }
  }

  /**
   * Purge DLQ entries older than `olderThanDays` days.
   *
   * @param olderThanDays - Entries with `failedAt` older than this many days
   *   will be removed.
   * @returns Number of entries purged.
   */
  function purgeDeadLetters(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const all = getAll();
    let count = 0;

    for (const entry of all) {
      if (entry.failedAt < cutoff) {
        remove(entry.id);
        count++;
      }
    }

    logger.info({ count, olderThanDays }, '[Webhooks/DLQ] Purged old entries');
    return count;
  }

  return {
    enqueue,
    listDeadLetters,
    retryDeadLetter,
    purgeDeadLetters,
  };
}

export type DlqService = ReturnType<typeof createDlqService>;
