// Theme application + cache. Dependency-free (no api/auth imports) to avoid
// circular imports; persistence to the server lives in the auth store's setTheme.
const STORAGE_KEY = 'bext-theme';

function readInitial() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const theme = $state({ value: readInitial() });

// Sets data-theme on <html> and caches the choice for the next page load.
export function applyTheme(value) {
  const next = value === 'dark' ? 'dark' : 'light';
  theme.value = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

// Ensure DOM + store agree at module load.
applyTheme(theme.value);
