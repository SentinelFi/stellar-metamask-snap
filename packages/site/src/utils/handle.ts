/**
 * Adapts an async action into a DOM event handler.
 *
 * DOM handlers must return void, and an `async` handler returns a promise, so
 * passing one directly leaves a rejection with nowhere to go. Every action on
 * this page already reports its own failures (connector errors go to the page
 * error box), so the wrapper's job is only to stop the promise escaping into
 * an attribute that will drop it.
 *
 * @param action - The async action to run.
 * @returns A handler that starts the action and returns nothing.
 */
export function handle<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args: Args) => {
    action(...args).catch(() => undefined);
  };
}
