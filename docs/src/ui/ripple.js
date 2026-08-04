/* ══════════════════════════════════════════════════════════════
   Ripple — Material touch feedback, centred on the pointer.

   Delegated from the document so it applies to controls created at any
   time. Keyboard activation gets an equivalent ripple from the centre
   of the control, so the feedback isn't mouse-only.

   Under prefers-reduced-motion the CSS swaps the expanding circle for
   a brief flat wash — the feedback survives, the travel doesn't.
   ══════════════════════════════════════════════════════════════ */

const SELECTOR = '.btn, .tab, .keycap, .slot, .roomcode';

function spawn(el, clientX, clientY) {
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return;

  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const x = clientX == null ? rect.width / 2 : clientX - rect.left;
  const y = clientY == null ? rect.height / 2 : clientY - rect.top;

  // Radius must reach the furthest corner from the origin.
  const dx = Math.max(x, rect.width - x);
  const dy = Math.max(y, rect.height - y);
  const r = Math.sqrt(dx * dx + dy * dy);

  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.left = `${x - r}px`;
  span.style.top = `${y - r}px`;
  span.style.width = span.style.height = `${r * 2}px`;

  el.appendChild(span);
  span.addEventListener('animationend', () => span.remove(), { once: true });
  // Belt and braces: if the animation never fires (element hidden mid-flight)
  // the node would leak, so clean up on a timer too.
  setTimeout(() => span.remove(), 900);
}

export function installRipples(root = document) {
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.target.closest(SELECTOR);
    if (el) spawn(el, e.clientX, e.clientY);
  }, { passive: true });

  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.repeat) return;
    const el = e.target.closest?.(SELECTOR);
    if (el) spawn(el, null, null);
  });
}
