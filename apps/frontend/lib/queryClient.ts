import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Single QueryClient factory used by the Providers component.
 * In React Strict Mode + Next.js App Router we want one stable client per
 * browser session, so Providers caches the result via useState(() => getQueryClient()).
 */
export function getQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            // Don't retry client errors except 408/429.
            if (error.status >= 400 && error.status < 500) {
              return error.status === 408 || error.status === 429
                ? failureCount < 1
                : false;
            }
          }
          return failureCount < 1;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
