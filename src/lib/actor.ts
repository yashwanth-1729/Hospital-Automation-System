import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The signed-in staff member for the current request.
 *
 * Staff actions call into workflow code that writes audit rows, several layers down and
 * written before accounts existed. Rather than thread a user id through every signature, the
 * guard records who is acting here and `audit()` reads it, so every staff-initiated audit row
 * names a person.
 */
const store = new AsyncLocalStorage<{ userId: string }>();

export function enterActor(userId: string): void {
  store.enterWith({ userId });
}

export function currentActorId(): string | null {
  return store.getStore()?.userId ?? null;
}

/** Runs fn as a given staff member. Used by tests and scripts; requests use enterActor. */
export function runAs<T>(userId: string, fn: () => T): T {
  return store.run({ userId }, fn);
}
