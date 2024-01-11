import type { UseQueryResult } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';

import { getCurrentDisplayName } from './actions';

const queryFn: () => Promise<string | undefined> = () => getCurrentDisplayName();

export function useCurrentDisplayName({ enabled = true } = {}): UseQueryResult<string | undefined> {
  return useQuery({
    queryKey: ['currentDisplayName'],
    queryFn,
    enabled,
  });
}
