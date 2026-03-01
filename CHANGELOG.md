# Changelog

## [0.2.0] - 2026-03-01 - WIP / Draft

### Added - Production-Ready DLQ Pattern (extracted from Calendr)

⚠️ **STATUS:** Work in progress — TypeScript compilation errors need resolution before merge.

This version extracts Calendr's battle-tested Dead Letter Queue implementation into the shared package.

**New schema tables:**
- `webhook_delivery_log` — Immutable audit log of every HTTP attempt
- `webhook_dead_letter_queue` — Persistent retry queue for failed deliveries

**New functionality:**
- `startWebhookRetryJob()` — Background job that polls DLQ and retries failed deliveries
- Persistent retry with configurable delays (default: 1min, 5min, 30min)
- Concurrent retry processing with SELECT FOR UPDATE SKIP LOCKED
- Comprehensive delivery logging for debugging and observability
- Automatic DLQ enrollment on delivery failure

**Migration from 0.1.0:**
- Schema is backwards compatible (adds new tables, updates existing `webhooks` table)
- API is mostly compatible (delivery service signature unchanged)
- New `startWebhookRetryJob(db, config)` must be called on server startup

**Known issues (blocking release):**
- [ ] TypeScript compilation errors in delivery.ts and retryJob.ts
- [ ] `DeliveryResult` type mismatch between types.ts and delivery.ts
- [ ] Drizzle type inference issues with schema updates
- [ ] Missing tests for DLQ retry logic

**Why this matters:**
Calendr built a sophisticated webhook DLQ system that solves hard problems:
- Network failures don't lose events
- Exponential backoff prevents thundering herd
- Concurrent workers don't duplicate deliveries (SKIP LOCKED)
- Full audit trail for compliance/debugging

Rather than have psych-transcribe and roundup reinvent this, we extract it once and share across the ecosystem.

**Next steps:**
1. Fix TypeScript compilation (reconcile types.ts with new schema)
2. Add integration tests for DLQ retry flow
3. Publish 0.2.0 to npm
4. Migrate Calendr to use shared package (dogfooding)
5. Add DLQ support to psych-transcribe and roundup

---

## [0.1.0] - 2026-02-20

Initial release — basic HMAC-signed webhook delivery with in-memory exponential backoff.
