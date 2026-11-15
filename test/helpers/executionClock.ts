import { afterEach, beforeEach, vi } from 'vitest';

export function useStillExecutionClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
