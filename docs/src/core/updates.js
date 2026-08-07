/* ══════════════════════════════════════════════════════════════
   Keeping the installed game up to date.

   The service worker serves from cache, so the game opens instantly and
   works with no network. The cost of that is the failure this replaced:
   a refresh could hand back an old build with nothing to say so.

   So the page takes responsibility for noticing. It asks the browser to
   re-check the worker on load, whenever the tab comes back to the front,
   and every so often while it sits open. When a new worker has finished
   installing beside the running one, the player is told — and the swap
   happens only when they say so, never underneath a match.
   ══════════════════════════════════════════════════════════════ */

/** How often to look for a new build while the page stays open. */
const CHECK_EVERY_MS = 15 * 60 * 1000;

export const updates = {
  registration: null,
  onAvailable: null,     // set by the UI to show its banner
  _applying: false,      // did the player ask for the swap?
  _reloading: false,
};

export async function installUpdates() {
  if (!('serviceWorker' in navigator)) return null;
  // file:// has no origin to scope a worker to.
  if (location.protocol === 'file:') return null;

  try {
    const reg = await navigator.serviceWorker.register('sw.js', {
      // Never let an HTTP cache answer for the worker itself; that is exactly
      // how an update goes unnoticed for hours.
      updateViaCache: 'none',
    });
    updates.registration = reg;

    // Already one waiting from a previous visit?
    if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      if (!next) return;
      next.addEventListener('statechange', () => {
        // 'installed' with a controller already present means this is a new
        // version arriving, not the very first install.
        if (next.state === 'installed' && navigator.serviceWorker.controller) {
          announce(next);
        }
      });
    });

    // The new worker took over: everything must be reloaded together, or the
    // page ends up running modules from two different builds.
    //
    // Only when the player asked for it, though. The FIRST worker also fires
    // this, because activate() calls clients.claim() to take over the page
    // that installed it — reloading there means the game boots and then
    // instantly restarts itself in front of every new visitor.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updates._applying || updates._reloading) return;
      updates._reloading = true;
      location.reload();
    });

    const check = () => { reg.update().catch(() => { /* offline; try later */ }); };
    check();
    setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });

    return reg;
  } catch {
    return null;    // an unavailable worker must never stop the game loading
  }
}

function announce(worker) {
  updates.waiting = worker;
  updates.onAvailable?.();
}

/** Take the update the player was offered. Triggers controllerchange. */
export function applyUpdate() {
  updates._applying = true;
  const w = updates.waiting || updates.registration?.waiting;
  if (!w) { location.reload(); return; }
  w.postMessage('apply-update');
}
