import { describe, it, expect } from 'vitest';
import { createDlqService } from './dlq';

function makeEntry(overrides: Partial<Parameters<ReturnType<typeof createDlqService>['enqueue']>[0]> = {}) {
  return {
    webhookId: 'wh-1',
    payload: '{"event":"test"}',
    endpointUrl: 'https://example.com/hook',
    failureReason: 'HTTP 500 after all retries',
    retryCount: 3,
    ...overrides,
  };
}

describe('DLQ Service', () => {
  it('enqueue adds entry and listDeadLetters returns it', () => {
    const dlq = createDlqService();
    const entry = dlq.enqueue(makeEntry());

    const list = dlq.listDeadLetters();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(entry.id);
    expect(list[0].webhookId).toBe('wh-1');
    expect(list[0].payload).toBe('{"event":"test"}');
    expect(list[0].endpointUrl).toBe('https://example.com/hook');
  });

  it('retryDeadLetter with succeeding deliverFn removes entry and returns true', async () => {
    const dlq = createDlqService();
    const entry = dlq.enqueue(makeEntry());

    const result = await dlq.retryDeadLetter(entry.id, async () => true);

    expect(result).toBe(true);
    expect(dlq.listDeadLetters()).toHaveLength(0);
  });

  it('retryDeadLetter with failing deliverFn keeps entry and returns false', async () => {
    const dlq = createDlqService();
    const entry = dlq.enqueue(makeEntry());

    const result = await dlq.retryDeadLetter(entry.id, async () => false);

    expect(result).toBe(false);
    expect(dlq.listDeadLetters()).toHaveLength(1);
  });

  it('purgeDeadLetters(0) removes all entries', async () => {
    const dlq = createDlqService();
    dlq.enqueue(makeEntry());
    dlq.enqueue(makeEntry({ webhookId: 'wh-2' }));

    expect(dlq.listDeadLetters()).toHaveLength(2);

    // Wait a tick so failedAt < cutoff (not same millisecond as purge call)
    await new Promise((r) => setTimeout(r, 5));

    const purged = dlq.purgeDeadLetters(0);

    expect(purged).toBe(2);
    expect(dlq.listDeadLetters()).toHaveLength(0);
  });

  it('retryDeadLetter with unknown id returns false', async () => {
    const dlq = createDlqService();

    const result = await dlq.retryDeadLetter('nonexistent-id', async () => true);

    expect(result).toBe(false);
  });
});
