// The console follows the system unless the person picks one. The choice is
// kept in localStorage and applied before first paint by the inline script in
// index.html, so a chosen theme never flashes the other one.
export type Theme = "system" | "light" | "dark";
const KEY = "barua-theme";

export function readTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(t: Theme) {
  if (t === "system") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(KEY, t);
    document.documentElement.dataset.theme = t;
  }
}
