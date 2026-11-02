import { useSyncExternalStore } from "react";
import type { ITheme } from "@xterm/xterm";

export const themes = {
  classic: "Classic (default)",
  sage: "Sage & Cream",
  ember: "Ember & Ivory",
} as const;
export type Theme = keyof typeof themes;
const storageKey = "autopilot.theme";
const changeEvent = "autopilot:theme-change";
const normalize = (value: string | null | undefined): Theme =>
  value === "sage" || value === "ember" ? value : "classic";

export const getTheme = (): Theme =>
  normalize(document.documentElement.dataset.theme);

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (meta)
    meta.content = { classic: "#111216", sage: "#2a3029", ember: "#101010" }[
      theme
    ];
  window.dispatchEvent(new Event(changeEvent));
}

export function setTheme(value: string) {
  const theme = normalize(value);
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    /* Keep the choice for this window. */
  }
  applyTheme(theme);
}

// Other open windows update without reloading or interrupting their terminals.
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null)
    applyTheme(normalize(event.newValue));
});

export function subscribeTheme(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  return () => window.removeEventListener(changeEvent, listener);
}

export const useTheme = () => useSyncExternalStore(subscribeTheme, getTheme);

export function terminalTheme(): ITheme {
  if (getTheme() === "classic")
    return { background: "#101115", foreground: "#e5e5ea" };
  if (getTheme() === "ember")
    return {
      background: "#101010",
      foreground: "#e6d5bd",
      cursor: "#d5360c",
      cursorAccent: "#101010",
      selectionBackground: "#d5360c66",
      black: "#101010",
      brightBlack: "#9e9080",
      red: "#ee7858",
      brightRed: "#ffad92",
      green: "#b6c39c",
      brightGreen: "#d6e2c0",
      yellow: "#dcb47e",
      brightYellow: "#f2d2a1",
      blue: "#a6b8c5",
      brightBlue: "#cbdbe5",
      magenta: "#c79eae",
      brightMagenta: "#e5becd",
      cyan: "#a5c2b7",
      brightCyan: "#c6e0d6",
      white: "#e6d5bd",
      brightWhite: "#fffaf4",
    };
  return {
    background: "#2a3029",
    foreground: "#e8d2b5",
    cursor: "#e8d2b5",
    selectionBackground: "#a5a79b52",
    black: "#2a3029",
    brightBlack: "#a5a79b",
    red: "#d8897e",
    brightRed: "#edb0a6",
    green: "#b9c8ac",
    brightGreen: "#d8e5cb",
    yellow: "#e8d2b5",
    brightYellow: "#f6e7d2",
    blue: "#a5a79b",
    brightBlue: "#c5c7ba",
    magenta: "#c9a8a0",
    brightMagenta: "#e2c3bb",
    cyan: "#a8c0b5",
    brightCyan: "#c7dbd2",
    white: "#f7ecd9",
    brightWhite: "#fffaf0",
  };
}
