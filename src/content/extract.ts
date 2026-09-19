import type { PageElement } from '../../shared/api';
import type { FormField } from '../shared/types';

/** Elements a user could plausibly click, type into, or choose from. */
const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=menuitem]',
  '[role=tab]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=switch]',
  '[role=combobox]',
  '[role=textbox]',
  '[contenteditable=""]',
  '[contenteditable=true]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const MAX_ELEMENTS = 150;
const MAX_TEXT = 100;
const SENSITIVE_NAME = /(passw|passcode|card.?n|cc.?num|cvv|cvc|security.?code|iban|routing|account.?n|ssn|social.?sec|otp|one.?time)/i;
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/i;
const ROOT_ID = 'taskpilot-root';

export interface Registry {
  counter: number;
  ids: WeakMap<Element, string>;
  byId: Map<string, WeakRef<Element>>;
}

export function createRegistry(): Registry {
  return { counter: 0, ids: new WeakMap(), byId: new Map() };
}

export interface ExtractOptions {
  /** Require real layout (non-zero rects). Disabled in jsdom tests, which have no layout engine. */
  requireLayout?: boolean;
  max?: number;
}

const clean = (s: string | null | undefined, max = MAX_TEXT): string | undefined => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};

// ── Element discovery ──────────────────────────────────────────────────────

function* walk(root: Document | ShadowRoot | Element): Generator<Element> {
  const tree = (root as Document).createTreeWalker
    ? (root as Document).createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT)
    : (root.ownerDocument ?? document).createTreeWalker(root as Node, NodeFilter.SHOW_ELEMENT);
  let node = tree.nextNode() as Element | null;
  while (node) {
    yield node;
    if (node.shadowRoot) yield* walk(node.shadowRoot); // open shadow roots only
    node = tree.nextNode() as Element | null;
  }
}

function inOwnUi(el: Element): boolean {
  return !!el.closest(`#${ROOT_ID}`) || (el.getRootNode() as ShadowRoot).host?.id === ROOT_ID;
}

/** Rect used for both visibility and highlighting. Visually-hidden checkboxes borrow their label's box. */
export function rectOf(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if ((r.width === 0 || r.height === 0) && el instanceof HTMLInputElement && el.labels?.[0]) {
    return el.labels[0].getBoundingClientRect();
  }
  return r;
}

function isVisible(el: Element, requireLayout: boolean): boolean {
  const cv = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (cv) {
    if (!cv.call(el, { checkVisibilityCSS: true })) return false;
  } else {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
  }
  if (!requireLayout) return true;
  const r = rectOf(el);
  return r.width > 1 && r.height > 1;
}

// ── Labelling ──────────────────────────────────────────────────────────────

function labelledBy(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts = ids.map((id) => root.getElementById?.(id)?.textContent ?? '');
  return clean(parts.join(' '));
}

function humanize(s: string | null): string | undefined {
  return clean((s ?? '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

function fieldLabel(el: Element): string | undefined {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const by = labelledBy(el);
  if (by) return by;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const l = el.labels?.[0];
    if (l) {
      // Take the label's own words, not the control's current value or option list.
      const copy = l.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('input,select,textarea,option').forEach((n) => n.remove());
      const t = clean(copy.textContent);
      if (t) return t;
    }
  }
  const ph = clean(el.getAttribute('placeholder'));
  if (ph) return ph;
  const title = clean(el.getAttribute('title'));
  if (title) return title;
  return humanize(el.getAttribute('name')) ?? humanize(el.id);
}

function clickableText(el: Element): string | undefined {
  if (el instanceof HTMLInputElement && /^(submit|button|reset)$/i.test(el.type)) return clean(el.value) ?? clean(el.getAttribute('aria-label'));
  return (
    clean(el.getAttribute('aria-label')) ??
    labelledBy(el) ??
    clean((el as HTMLElement).innerText ?? el.textContent) ??
    clean(el.querySelector('img[alt]')?.getAttribute('alt')) ??
    clean(el.getAttribute('title'))
  );
}

// ── Classification ─────────────────────────────────────────────────────────

function typeOf(el: Element): PageElement['type'] {
  const role = el.getAttribute('role');
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || role === 'textbox' || el.hasAttribute('contenteditable')) return 'textarea';
  if (tag === 'select' || role === 'combobox') return 'select';
  if (tag === 'input') {
    const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (/^(button|submit|reset|image)$/.test(t)) return 'button';
    return 'input';
  }
  if (role === 'checkbox' || role === 'switch') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'button' || tag === 'summary' || role === 'button' || role === 'tab' || role === 'menuitem') return 'button';
  return 'other';
}

export function isSensitive(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  const ac = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
  return SENSITIVE_NAME.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''}`);
}

function isFilled(el: Element): boolean | undefined {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked;
    return el.value.length > 0;
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value.length > 0;
  if (el.hasAttribute('contenteditable')) return (el.textContent ?? '').trim().length > 0;
  return undefined;
}

function inViewport(el: Element): boolean {
  const r = rectOf(el);
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

// ── Public API ─────────────────────────────────────────────────────────────

function idFor(reg: Registry, el: Element): string {
  let id = reg.ids.get(el);
  if (!id) {
    id = `tp-${++reg.counter}`;
    reg.ids.set(el, id);
  }
  reg.byId.set(id, new WeakRef(el));
  return id;
}

export function resolve(reg: Registry, id: string): Element | null {
  const el = reg.byId.get(id)?.deref();
  return el && el.isConnected ? el : null;
}

/** Compact, model-ready description of what can be interacted with on the page. Never includes field values. */
export function extractElements(doc: Document, reg: Registry, opts: ExtractOptions = {}): PageElement[] {
  const requireLayout = opts.requireLayout ?? true;
  const max = opts.max ?? MAX_ELEMENTS;
  const found: { el: Element; view: boolean }[] = [];
  const seen = new Set<Element>();

  for (const el of walk(doc)) {
    if (!el.matches(INTERACTIVE) || seen.has(el) || inOwnUi(el)) continue;
    seen.add(el);
    if (!isVisible(el, requireLayout)) continue;
    found.push({ el, view: requireLayout ? inViewport(el) : true });
  }

  // Over budget: keep what's on screen first, then fill from the rest, preserving document order.
  let chosen = found;
  if (found.length > max) {
    const onScreen = found.filter((f) => f.view);
    const rest = found.filter((f) => !f.view);
    const keep = new Set([...onScreen, ...rest].slice(0, max));
    chosen = found.filter((f) => keep.has(f));
  }

  return chosen.map(({ el, view }): PageElement => {
    const type = typeOf(el);
    const isField = type === 'input' || type === 'textarea' || type === 'select' || type === 'checkbox' || type === 'radio';
    const sensitive = isSensitive(el);
    const out: PageElement = { id: idFor(reg, el), type };
    if (isField) out.label = fieldLabel(el);
    else out.text = clickableText(el);
    if (el instanceof HTMLInputElement) {
      out.inputType = el.type;
      out.placeholder = clean(el.placeholder, 60);
    } else if (el instanceof HTMLTextAreaElement) {
      out.placeholder = clean(el.placeholder, 60);
    }
    if ('required' in el && (el as HTMLInputElement).required) out.required = true;
    if ('disabled' in el && (el as HTMLInputElement).disabled) out.disabled = true;
    if (isField) out.filled = isFilled(el);
    if (sensitive) out.sensitive = true;
    if (el instanceof HTMLSelectElement) out.options = [...el.options].slice(0, 15).map((o) => o.text.trim()).filter(Boolean);
    if (requireLayout) out.inViewport = view;
    return out;
  });
}

const FIELD_TYPES = /^(text|email|tel|url|)$/i;

/** Empty, editable, non-sensitive text fields a suggestion could be inserted into. */
export function scanFields(doc: Document, reg: Registry, opts: ExtractOptions = {}): FormField[] {
  const requireLayout = opts.requireLayout ?? true;
  const out: FormField[] = [];
  for (const el of walk(doc)) {
    if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) continue;
    if (inOwnUi(el)) continue;
    if (el instanceof HTMLInputElement && !FIELD_TYPES.test(el.type)) continue;
    if (el.disabled || el.readOnly || isSensitive(el) || el.value.length > 0) continue;
    if (!isVisible(el, requireLayout)) continue;
    const label = fieldLabel(el);
    if (!label) continue;
    out.push({
      id: idFor(reg, el),
      label,
      type: el instanceof HTMLTextAreaElement ? 'textarea' : el.type || 'text',
      placeholder: clean(el.placeholder, 80),
      maxLength: el.maxLength > 0 ? el.maxLength : undefined,
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** Type text into an empty field the way a user would, so React/Vue-controlled inputs notice. Never submits. */
export function insertText(reg: Registry, id: string, text: string): void {
  const el = resolve(reg, id);
  if (!el) throw new Error('That field is no longer on the page.');
  if (isSensitive(el)) throw new Error('TaskPilot never fills passwords, payment or security fields.');
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.value.length > 0) throw new Error('That field already has text; TaskPilot will not overwrite it.');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  throw new Error('Unsupported field type.');
}

/** Short, low-exposure description of the page for relevance checks: description + headings, no body text. */
export function pageSummary(doc: Document): string {
  const meta = clean(
    doc.querySelector('meta[name="description"]')?.getAttribute('content') ?? doc.querySelector('meta[property="og:description"]')?.getAttribute('content'),
    240,
  );
  const heads = [...doc.querySelectorAll('h1,h2')]
    .map((h) => clean(h.textContent, 80))
    .filter((t): t is string => !!t)
    .slice(0, 5);
  return [meta, heads.length ? `Headings: ${heads.join(' | ')}` : undefined].filter(Boolean).join('\n').slice(0, 500);
}
