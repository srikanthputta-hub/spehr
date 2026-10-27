export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

/**
 * Prevents dashboard fetches from leaving the UI in a permanent spinner.
 * If the request errors or exceeds the timeout, the supplied fallback is used.
 */
export async function fetchWithTimeout<T>(
  fetchFn: () => Promise<T> | T,
  fallback: T,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(fetchFn)
        .catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
