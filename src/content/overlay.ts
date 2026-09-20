/**
 * Everything TaskPilot draws on a web page lives in one closed-off shadow root,
 * so page CSS can't break it and it can't break the page. It never blocks the page:
 * the host is pointer-events:none except for the small cards themselves.
 */
const HOST_ID = 'taskpilot-root';

/**
 * Organic Biophilic styling — see docs/design-organic-biophilic.md.
 *
 * Earth tones, generous curves, soft natural shadows, green accent. Motion is ease-out
 * 200–300ms on transform and opacity only, so nothing here can cause the host page to
 * reflow.
 *
 * One departure from the spec: the highlight ring keeps a saturated green outline and an
 * animated pulse. The spec's "subtle colour shift" is right for a card in our own UI, but
 * this ring has to be findable on a page whose colours we do not control, and a muted
 * earth tone disappears against a photo or a coloured header.
 */
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ${FONT_STACK}; line-height: 1.6; }

.ring { position: fixed; pointer-events: none; border: 3px solid #1f7a1f; border-radius: 12px;
  box-shadow: 0 0 0 4px rgba(31,122,31,.18), 0 2px 12px rgba(43,42,38,.12);
  transition: opacity .2s cubic-bezier(.22,.61,.36,1); animation: pulse 2.4s ease-in-out infinite; }
.ring.unsure { border-style: dashed; }
@keyframes pulse { 50% { box-shadow: 0 0 0 9px rgba(31,122,31,.08), 0 2px 12px rgba(43,42,38,.1); } }

.tip { position: fixed; pointer-events: auto; max-width: 300px; background: #2b2a26; color: #f7f4e9;
  padding: 10px 12px; border-radius: 12px; font-size: 13px; box-shadow: 0 4px 16px rgba(43,42,38,.3);
  display: flex; gap: 10px; align-items: flex-start; animation: rise .3s cubic-bezier(.22,.61,.36,1) both; }
.tip b { color: #7cc77c; display: inline-flex; flex: none; padding-top: 2px; }
.tip button { all: unset; cursor: pointer; color: #b0ad9f; padding: 0 2px; border-radius: 6px; transition: color .2s; }
.tip button:hover { color: #f7f4e9; }
.tip button:focus-visible { outline: 2px solid #7cc77c; outline-offset: 2px; }

/* Card geometry from the spec: 18px radius, 1px stroke, soft low shadow, no glow. */
.banner { position: fixed; top: 20px; right: 20px; width: 340px; pointer-events: auto;
  background: #fffdf8; color: #5c5a52; border: 1px solid rgba(43,42,38,.12); border-radius: 18px;
  padding: 18px; box-shadow: 0 2px 12px rgba(43,42,38,.14); font-size: 13px;
  animation: rise .42s cubic-bezier(.22,.61,.36,1) both; }
.banner h4 { margin: 0 0 6px; font-size: 15px; font-weight: 600; color: #2b2a26; display: flex; gap: 8px; align-items: center; }
.banner h4 svg { flex: none; color: #8a6410; }
.banner .meta { color: #5c5a52; margin: 4px 0; }
.banner .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }

.banner button.act { all: unset; cursor: pointer; min-height: 32px; display: inline-flex; align-items: center;
  padding: 7px 12px; border: 1.5px solid rgba(43,42,38,.12); border-radius: 12px; font-weight: 500; font-size: 12.5px;
  color: #5c5a52; transition: background-color .2s cubic-bezier(.22,.61,.36,1), border-color .2s, transform .2s; }
.banner button.act:hover { background: #e7f1e2; border-color: #1f7a1f; color: #1f7a1f; }
.banner button.act:active { transform: translateY(1px); }
.banner button.act.primary { background: #1f7a1f; border-color: #1f7a1f; color: #fffdf8; font-weight: 600; }
.banner button.act.primary:hover { background: #175e17; border-color: #175e17; color: #fffdf8; box-shadow: 0 4px 16px rgba(43,42,38,.18); }
.banner button.act:focus-visible { outline: 2px solid #1f7a1f; outline-offset: 2px; }

.banner .x { all: unset; cursor: pointer; position: absolute; top: 14px; right: 16px; color: #7d7a6f; border-radius: 6px; transition: color .2s; }
.banner .x:hover { color: #a63a2e; }
.banner .x:focus-visible { outline: 2px solid #1f7a1f; outline-offset: 2px; }

@keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }

@media (prefers-color-scheme: dark) {
  .banner { background: #242822; color: #b0ad9f; border-color: rgba(242,240,230,.14); box-shadow: 0 2px 12px rgba(0,0,0,.4); }
  .banner h4 { color: #f2f0e6; }
  .banner h4 svg { color: #d9b45c; }
  .banner .meta { color: #b0ad9f; }
  .banner button.act { color: #b0ad9f; border-color: rgba(242,240,230,.14); }
  .banner button.act:hover { background: #22301f; border-color: #7cc77c; color: #7cc77c; }
  .banner button.act.primary { background: #7cc77c; border-color: #7cc77c; color: #1c1f1b; }
  .banner button.act.primary:hover { background: #9bd69b; border-color: #9bd69b; color: #1c1f1b; }
  .ring { border-color: #7cc77c; }
  .tip b { color: #9bd69b; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

/** Lucide paths, inlined: the spec forbids emoji and both of these need a mark. */
const ICON_ATTRS = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const ALERT_SVG = `<svg width="16" height="16" ${ICON_ATTRS}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;
const X_SVG = `<svg width="14" height="14" ${ICON_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const ARROW_SVG = `<svg width="14" height="14" ${ICON_ATTRS}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

/** A close button carrying the X glyph as SVG rather than a ✕ character. */
function closeButton(cls: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.className = cls;
  b.innerHTML = X_SVG; // hardcoded constant, never external text
  b.title = 'Dismiss';
  b.setAttribute('aria-label', 'Dismiss');
  b.addEventListener('click', onClick);
  return b;
}

let shadow: ShadowRoot | null = null;

function root(): ShadowRoot {
  if (shadow && document.getElementById(HOST_ID)) return shadow;
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);
  document.documentElement.append(host);
  return shadow;
}

const text = (tag: string, cls: string, content: string): HTMLElement => {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = content; // never innerHTML: instructions and goals come from a model / the user
  return el;
};

// ── Element highlight ──────────────────────────────────────────────────────

interface Highlight {
  ring: HTMLElement;
  tip: HTMLElement;
  target: Element;
  raf: number;
  onLost: () => void;
  cleanup: () => void;
}
let highlight: Highlight | null = null;

export function clearHighlight(): void {
  if (!highlight) return;
  cancelAnimationFrame(highlight.raf);
  highlight.cleanup();
  highlight.ring.remove();
  highlight.tip.remove();
  highlight = null;
}

/**
 * What the user has to do to this element for the instruction to count as carried out.
 *
 * A click on a text field or a `select` only puts the caret in it or opens the dropdown —
 * treating that as "done" would tick off "fill in your name" the moment they clicked the
 * box. Those wait for the value to actually change instead.
 */
export function actSignalFor(el: Element): 'click' | 'change' {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return 'change';
  if (tag !== 'input') return 'click';
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  // Checkboxes, radios and the button-like inputs are done by clicking them.
  return ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(type) ? 'click' : 'change';
}

/**
 * Only a real user gesture advances the plan. Anything the page dispatched itself — a
 * script, an analytics shim, a synthesized click — carries `isTrusted: false`, and
 * counting it would let a page tick the user's plan off on its own.
 */
export const isUserGesture = (e: Event): boolean => e.isTrusted === true;

export interface HighlightHandlers {
  /** The element left the page before the user could act on it. */
  onLost: () => void;
  /** The user actually did the thing we pointed at. */
  onAct: () => void;
  /** The user waved the highlight away instead. */
  onDismiss: () => void;
  /** What counts as a user gesture. Injectable because `isTrusted` cannot be faked in a test DOM. */
  trusts?: (e: Event) => boolean;
}

export function showHighlight(
  target: Element,
  rectOf: (el: Element) => DOMRect,
  instruction: string,
  confidence: number,
  handlers: HighlightHandlers,
): void {
  clearHighlight();
  const { onLost, onAct, onDismiss, trusts = isUserGesture } = handlers;
  const r = root();
  const ring = text('div', confidence < 0.7 ? 'ring unsure' : 'ring', '');
  const tip = document.createElement('div');
  tip.className = 'tip';
  const label = document.createElement('span');
  // An SVG arrow rather than a "→" character, keeping the tip free of glyph characters.
  const arrow = document.createElement('b');
  arrow.innerHTML = ARROW_SVG; // hardcoded constant, never external text
  label.append(arrow, document.createTextNode(instruction));
  const close = closeButton('', () => {
    clearHighlight();
    onDismiss();
  });
  tip.append(label, close);
  r.append(ring, tip);

  const signal = actSignalFor(target);

  const acted = (e: Event) => {
    if (!trusts(e)) return;
    clearHighlight();
    onAct();
  };
  // Capture phase: the page may stop propagation, and a click that navigates tears this
  // frame down, so we report before the default action runs.
  target.addEventListener(signal, acted, { capture: true });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    clearHighlight();
    onDismiss();
  };
  window.addEventListener('keydown', onKey);
  const cleanup = () => {
    target.removeEventListener(signal, acted, { capture: true });
    window.removeEventListener('keydown', onKey);
  };

  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });

  const state: Highlight = { ring, tip, target, raf: 0, onLost, cleanup };
  highlight = state;
  const tick = () => {
    if (highlight !== state) return;
    if (!target.isConnected) {
      clearHighlight();
      onLost();
      return;
    }
    const b = rectOf(target);
    const pad = 4;
    ring.style.cssText = `left:${b.left - pad}px;top:${b.top - pad}px;width:${b.width + pad * 2}px;height:${b.height + pad * 2}px;`;
    const below = b.bottom + 12 + 60 < innerHeight;
    tip.style.left = `${Math.max(8, Math.min(b.left, innerWidth - 296))}px`;
    tip.style.top = below ? `${b.bottom + 12}px` : `${Math.max(8, b.top - 12 - tip.offsetHeight)}px`;
    state.raf = requestAnimationFrame(tick);
  };
  tick();
}

// ── Distraction banner ─────────────────────────────────────────────────────

export interface BannerData {
  goal: string;
  step: string | null;
  minutesAway: number | null;
  reason?: string;
}
export type BannerAction = 'return' | 'relevant' | 'pause' | 'dismiss';

let banner: HTMLElement | null = null;

export function hideBanner(): void {
  banner?.remove();
  banner = null;
}

export function showBanner(data: BannerData, onAction: (a: BannerAction) => void): void {
  hideBanner();
  const el = document.createElement('div');
  el.className = 'banner';
  el.setAttribute('role', 'alert');

  // innerHTML is safe here and only here: ALERT_SVG is a hardcoded constant, never model
  // or user text. The heading itself is appended as a text node, as everywhere else.
  const h = document.createElement('h4');
  h.innerHTML = ALERT_SVG;
  h.append(document.createTextNode(`This page doesn't appear related to your task`));
  const goal = text('div', 'meta', `“${data.goal}”`);
  el.append(h, goal);
  if (data.step) el.append(text('div', 'meta', `Current step: ${data.step}`));
  if (data.reason) el.append(text('div', 'meta', data.reason));
  if (data.minutesAway && data.minutesAway >= 1) {
    el.append(text('div', 'meta', `You've been away from your task for ${data.minutesAway} minute${data.minutesAway === 1 ? '' : 's'}.`));
  }

  const row = document.createElement('div');
  row.className = 'row';
  const mk = (label: string, action: BannerAction, primary = false) => {
    const b = text('button', primary ? 'act primary' : 'act', label);
    b.addEventListener('click', () => {
      hideBanner();
      onAction(action);
    });
    return b;
  };
  row.append(mk('Return to Task', 'return', true), mk('This Is Relevant', 'relevant'), mk('Pause Task', 'pause'));
  const x = closeButton('x', () => {
    hideBanner();
    onAction('dismiss');
  });
  el.append(row, x);
  root().append(el);
  banner = el;
}
