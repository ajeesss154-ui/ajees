"use client";
export type ThemePreference = "light" | "dark" | "system";
export const THEME_CHANGED_EVENT = "aura-theme-changed";
export function normalizeTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
export function cachedTheme(): ThemePreference {
  try {
    return normalizeTheme(localStorage.getItem("aura-theme"));
  } catch {
    return "system";
  }
}
/** Persist the preference while the HTML always receives a resolved color scheme. */
export function applyTheme(preference: unknown): void {
  const theme = normalizeTheme(preference);
  document.documentElement.dataset.theme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  try {
    localStorage.setItem("aura-theme", theme);
  } catch {
    /* A blocked browser cache does not prevent applying the theme. */
  }
  window.dispatchEvent(
    new CustomEvent(THEME_CHANGED_EVENT, {
      detail: {
        preference: theme,
        resolved: document.documentElement.dataset.theme,
      },
    }),
  );
}
