export class TimeoutError extends Error {
  override name = "TimeoutError";
}

export class AbortedError extends Error {
  override name = "AbortError";
}

/**
 * Runs `fn` with an AbortSignal that fires on timeout or when `parent`
 * aborts, and rejects as soon as either happens. A result that arrives after
 * the deadline is ignored: settling is first-wins and happens once.
 * Synchronous throws from `fn` become rejections.
 */
export function runWithDeadline<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      controller.abort(parent?.reason);
      finish(() => reject(new AbortedError("Request was aborted")));
    };
    const timer = setTimeout(() => {
      controller.abort(new TimeoutError(`Timed out after ${timeoutMs} ms`));
      finish(() => reject(new TimeoutError(`Timed out after ${timeoutMs} ms`)));
    }, timeoutMs);

    if (parent?.aborted) {
      onAbort();
      return;
    }
    parent?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
