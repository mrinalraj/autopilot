import { esc } from "./escape";

export function authPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Autopilot</title><body style="font:16px -apple-system,sans-serif;padding:40px">${esc(message)}</body>`;
}
