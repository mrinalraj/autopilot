import { AsyncLocalStorage } from "node:async_hooks";
import { log } from "./log";

/** The current step of each in-flight launch, for the page (card status and activity banner). */
export const launchSteps = new Map<string, string>();

const ctx = new AsyncLocalStorage<{ identifier: string }>();

/** Runs `fn` with steps attributed to `identifier`; clears its step when done. */
export async function withTicket<T>(identifier: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await ctx.run({ identifier }, fn);
  } finally {
    launchSteps.delete(identifier);
  }
}

/** Records a launch step: shown on the ticket's card and in the log panel. */
export function step(msg: string) {
  const c = ctx.getStore();
  if (c) launchSteps.set(c.identifier, msg);
  log.info(c ? `${c.identifier}: ${msg}` : msg);
}
