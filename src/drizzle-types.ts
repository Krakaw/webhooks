/**
 * Minimal Drizzle type definitions to avoid full dependency.
 * Uses a structural interface to avoid class version conflicts between
 * different installed versions of drizzle-orm.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = Record<string, any>;
