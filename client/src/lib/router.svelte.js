// Minimal hash-based router. Kept deliberately small; later phases add routes by
// registering more cases in the authed page switch. Hash routing avoids needing
// server-side rewrites for deep links.
function parse() {
  return window.location.hash.replace(/^#/, '') || '/';
}

export const router = $state({ path: parse() });

window.addEventListener('hashchange', () => {
  router.path = parse();
});

export function navigate(path) {
  window.location.hash = path;
}
