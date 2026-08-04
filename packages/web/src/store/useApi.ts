import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '../api/client.js';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch `path` whenever it or `deps` change. Passing `null` skips the request,
 * which is how a route says "not yet" without breaking the rules of hooks.
 *
 * Every failure arrives as an `ApiError`, including the ones that never reached
 * the server: those get `status: 0` rather than an invented HTTP code, so a
 * caller can tell "the API said no" from "the API said nothing". `error` and
 * `data` are never both stale — a successful reload clears the previous error.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    apiGet<T>(path, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? err
            : // Plan 1's canonical signature: (code, message, status, requestId, details?).
              // status 0 means "the request never reached the server".
              new ApiError('internal', 'The GrantSpotter API could not be reached.', 0, '', err),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
    // `deps` is spread so a caller can name the values that should refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, loading, reload };
}
