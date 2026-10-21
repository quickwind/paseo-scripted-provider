export interface Badge { schemaVersion: 1; label: string; message: string; color: string }
export function coverageBadge(summary: { total?: { lines?: { pct?: number } } } | null): Badge;
export function testsBadge(junitXml: string): Badge;
export function snykBadge(result: unknown): Badge;
