/**
 * Minimal Drizzle type definitions to avoid full dependency.
 * Projects using this package should have drizzle-orm installed.
 */

import type { PgDatabase } from 'drizzle-orm/pg-core';

export type DrizzleDb = PgDatabase<any, any, any>;
