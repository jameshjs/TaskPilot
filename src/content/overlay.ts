/**
 * Everything TaskPilot draws on a web page lives in one closed-off shadow root,
 * so page CSS can't break it and it can't break the page. It never blocks the page:
 * the host is pointer-events:none except for the small cards themselves.
 */
const HOST_ID = 'taskpilot-root';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.ring { position: fixed; pointer-events: none; border: 3px solid #6d5efc; border-radius: 8px;
  box-shadow: 0 0 0 4px rgba(109,94,252,.25), 0 0 24px rgba(109,94,252,.5); transition: all .15s ease; animation: pulse 1.6s ease-in-out infinite; }
.ring.unsure { border-style: dashed; }
@keyframes pulse { 50% { box-shadow: 0 0 0 8px rgba(109,94,252,.12), 0 0 24px rgba(109,94,252,.35); } }
.tip { position: fixed; pointer-events: auto; max-width: 280px; background: #17142b; color: #fff; padding: 8px 10px 8px 12px;
  border-radius: 10px; font-size: 13px; line-height: 1.35; box-shadow: 0 6px 24px rgba(0,0,0,.35); display: flex; gap: 8px; align-items: flex-start; }
.tip b { color: #b9b1ff; font-weight: 600; }
.tip button { all: unset; cursor: pointer; opacity: .6; padding: 0 2px; font-size: 14px; }
.tip button:hover { opacity: 1; }
.banner { position: fixed; top: 16px; right: 16px; width: 340px; pointer-events: auto; background: #fff; color: #1b1930;
  border-radius: 14px; padding: 16px; box-shadow: 0 12px 40px rgba(20,16,60,.35); border: 1px solid #e4e1fb; font-size: 13px; line-height: 1.45; }
.banner h4 { margin: 0 0 6px; font-size: 14px; }
.banner .meta { color: #5b5878; margin: 4px 0; }
.banner .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.banner button.act { all: unset; cursor: pointer; padding: 7px 12px; border-radius: 8px; font-weight: 600; font-size: 12.5px; background: #efedff; color: #3d32c9; }
.banner button.act.primary { background: #6d5efc; color: #fff; }
.banner button.act:hover { filter: brightness(.95); }
.banner .x { all: unset; cursor: pointer; position: absolute; top: 10px; right: 12px; opacity: .5; }
@media (prefers-color-scheme: dark) { .banner { background: #1e1b36; color: #f0eeff; border-color: #34305a; } .banner .meta { color: #a9a5c9; } .banner button.act { background: #2c2852; color: #cfc9ff; } }
`;

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
  const arrow = document.createElement('b');
  arrow.textContent = '→ ';
  label.append(arrow, document.createTextNode(instruction));
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Dismiss';
  close.addEventListener('click', () => {
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

  const h = text('h4', '', `This page doesn't appear related to your task`);
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
  const x = text('button', 'x', '✕');
  x.title = 'Dismiss';
  x.addEventListener('click', () => {
    hideBanner();
    onAction('dismiss');
  });
  el.append(row, x);
  root().append(el);
  banner = el;
}
