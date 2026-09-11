export const learningPeriodStartDates = [
  '2026-04-10T00:00:00+09:00',
  '2026-07-03T00:00:00+09:00',
  '2026-10-02T00:00:00+09:00',
  '2026-12-25T00:00:00+09:00',
] as const;

export function getLearningPeriodFilter(now = new Date()): { createdAt?: { gte: Date } } {
  const start = learningPeriodStartDates
    .map((date) => new Date(date))
    .filter((date) => date <= now)
    .toSorted((a, b) => b.getTime() - a.getTime())[0];
  return start ? { createdAt: { gte: start } } : {};
}
