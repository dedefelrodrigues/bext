import { api } from '$lib/api.js';
import { applyTheme } from '$lib/theme.svelte.js';

// Global auth state. `loading` is true until the initial /me probe resolves so
// the app can avoid flashing the login screen for already-authenticated users.
export const auth = $state({ user: null, loading: true });

export async function loadUser() {
  try {
    auth.user = await api('/auth/me');
    applyTheme(auth.user.theme);
  } catch {
    auth.user = null;
  } finally {
    auth.loading = false;
  }
}

export async function login(username, password) {
  auth.user = await api('/auth/login', { method: 'POST', body: { username, password } });
  applyTheme(auth.user.theme);
}

// Persist the theme preference (optimistically applied first for snappy toggles).
export async function setTheme(value) {
  applyTheme(value);
  const updated = await api('/settings', { method: 'PUT', body: { theme: value } });
  auth.user = { ...auth.user, ...updated };
}

export async function logout() {
  await api('/auth/logout', { method: 'POST' });
  auth.user = null;
}

export async function changePassword(currentPassword, newPassword) {
  auth.user = await api('/auth/change-password', {
    method: 'POST',
    body: { currentPassword, newPassword },
  });
}
