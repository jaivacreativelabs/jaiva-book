/**
 * A steady tick for food alerts. Browsers slow timers in background tabs down to about once a
 * minute, but not timers in a worker – so a waiter's or kitchen's screen in the background still
 * checks for Ready food / new orders on time.
 */
const scope = self as unknown as { postMessage(message: string): void };
setInterval(() => scope.postMessage('tick'), 3_000);
