// @vitest-environment jsdom
/**
 * The highlight is what turns an instruction into progress: the step advances only when
 * the user really acts on the element TaskPilot pointed at.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actSignalFor, clearHighlight, isUserGesture, showHighlight } from '../src/content/overlay';

const rect = () => ({ left: 10, top: 10, width: 80, height: 20, bottom: 30, right: 90 }) as DOMRect;

/**
 * jsdom marks every script-dispatched event untrusted and makes `isTrusted`
 * non-configurable, so a genuine gesture is simulated by injecting the trust policy.
 * `trusts: undefined` exercises the real `isTrusted` check.
 */
function highlight(el: Element, asUser = true) {
  const handlers = { onLost: vi.fn(), onAct: vi.fn(), onDismiss: vi.fn(), trusts: asUser ? () => true : isUserGesture };
  showHighlight(el, rect, 'Click Apply now', 0.9, handlers);
  return handlers;
}

const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));

beforeEach(() => {
  clearHighlight();
  document.body.innerHTML = '';
  // jsdom has no layout loop; keep the reposition tick from recursing forever.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  Element.prototype.scrollIntoView = vi.fn(); // not implemented in jsdom
});

describe('acting on the highlighted element', () => {
  it('reports a real user click on the target', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const h = highlight(button);

    fire(button, 'click');
    expect(h.onAct).toHaveBeenCalledTimes(1);
  });

  it('ignores a click the page synthesized, so a script cannot tick off the plan', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const h = highlight(button, false); // the real isTrusted check

    button.click(); // programmatic: isTrusted === false
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.onAct).not.toHaveBeenCalled();
    expect(h.onDismiss).not.toHaveBeenCalled();
  });

  it('isUserGesture rejects every event a script can make', () => {
    expect(isUserGesture(new MouseEvent('click'))).toBe(false);
    expect(isUserGesture(new Event('change'))).toBe(false);
  });

  it('sees the click even when the page stops it propagating', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.addEventListener('click', (e) => e.stopPropagation());
    const h = highlight(button);

    fire(button, 'click');
    expect(h.onAct).toHaveBeenCalledTimes(1); // capture phase runs first
  });

  it('only acts once, then stops listening', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const h = highlight(button);
    fire(button, 'click');
    fire(button, 'click');
    expect(h.onAct).toHaveBeenCalledTimes(1);
  });

  it('waits for a typed value on a text field, not the click that focuses it', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const h = highlight(input);

    fire(input, 'click');
    expect(h.onAct).not.toHaveBeenCalled(); // clicking a box is not filling it in

    fire(input, 'change');
    expect(h.onAct).toHaveBeenCalledTimes(1);
  });

  it('dismissing is not acting', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const h = highlight(button);

    const esc = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(esc);
    expect(h.onDismiss).toHaveBeenCalledTimes(1);
    expect(h.onAct).not.toHaveBeenCalled();
  });
});

describe('actSignalFor', () => {
  const el = (html: string) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild!;
  };

  it('waits for a change on things you fill in', () => {
    expect(actSignalFor(el('<input type="text">'))).toBe('change');
    expect(actSignalFor(el('<input>'))).toBe('change');
    expect(actSignalFor(el('<textarea></textarea>'))).toBe('change');
    expect(actSignalFor(el('<select></select>'))).toBe('change');
    expect(actSignalFor(el('<input type="email">'))).toBe('change');
  });

  it('treats a click as the action for things you click', () => {
    expect(actSignalFor(el('<button></button>'))).toBe('click');
    expect(actSignalFor(el('<a href="#"></a>'))).toBe('click');
    expect(actSignalFor(el('<input type="checkbox">'))).toBe('click');
    expect(actSignalFor(el('<input type="radio">'))).toBe('click');
    expect(actSignalFor(el('<input type="submit">'))).toBe('click');
  });
});
