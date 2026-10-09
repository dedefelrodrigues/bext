#!/usr/bin/env bash
# Start the BeXT dev stack: Express API (:3001) and the Vite client (:5173).
# Both halves reload on save: the server runs under `node --watch` (a full
# restart on any change under server/src or server/drizzle) and the client runs
# Vite, which hot-swaps modules in the browser. Nothing to restart by hand.
# Ctrl-C stops both. Written for bash 3.2, the version macOS ships.
set -uo pipefail

# Job control, so each background pipeline gets its own process group and a
# single kill takes npm and the node/vite child it spawned down with it.
set -m

root="$(cd "$(dirname "$0")" && pwd)"

# No workspace tooling in this repo — each folder installs on its own.
for dir in server client; do
  if [ ! -d "$root/$dir/node_modules" ]; then
    echo "==> installing $dir dependencies"
    (cd "$root/$dir" && npm install) || exit 1
  fi
done

pids=""

# Kill each pipeline by process group, so npm and the node/vite it spawned
# both go down. Guarded: the signal trap and the EXIT trap can both reach it.
stopped=""
shutdown() {
  [ -n "$stopped" ] && return
  stopped=1
  for pid in $pids; do
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap 'shutdown; exit 0' INT TERM
trap shutdown EXIT

# Tag every line so the two log streams stay readable when interleaved.
start() {
  name="$1"
  dir="$2"
  (
    cd "$root/$dir" || exit 1
    npm run dev 2>&1 | while IFS= read -r line; do
      printf '[%s] %s\n' "$name" "$line"
    done
  ) &
  pids="$pids $!"
}

start server server
start client client

echo "==> server http://localhost:3001   client http://localhost:5173"

# Exit as soon as either side dies, rather than leaving half a stack running.
while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "==> a process exited; shutting the other down"
      exit 1
    fi
  done
  sleep 1
done
