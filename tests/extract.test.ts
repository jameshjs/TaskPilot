// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createRegistry, extractElements, insertText, pageSummary, resolve, scanFields } from '../src/content/extract';

const opts = { requireLayout: false };
let reg = createRegistry();

function page(html: string) {
  document.body.innerHTML = html;
  reg = createRegistry();
}

describe('extractElements', () => {
  it('produces the spec shape: buttons by text, inputs by label', () => {
    page(`
      <a href="/apply"><span>Apply   Now</span></a>
      <label for="e">Email</label><input id="e" type="email" required placeholder="you@x.com" />
      <button aria-label="Close dialog">×</button>
    `);
    const els = extractElements(document, reg, opts);
    expect(els).toEqual([
      { id: 'tp-1', type: 'link', text: 'Apply Now' },
      { id: 'tp-2', type: 'input', label: 'Email', inputType: 'email', placeholder: 'you@x.com', required: true, filled: false },
      { id: 'tp-3', type: 'button', text: 'Close dialog' },
    ]);
  });

  it('never leaks field values and marks sensitive fields', () => {
    page(`
      <input type="password" name="pw" value="hunter2" aria-label="Password" />
      <input name="cardNumber" value="4111111111111111" aria-label="Card number" />
      <input type="text" aria-label="Name" value="Ada" />
    `);
    const els = extractElements(document, reg, opts);
    expect(JSON.stringify(els)).not.toMatch(/hunter2|4111|Ada/);
    expect(els[0]).toMatchObject({ sensitive: true, filled: true });
    expect(els[1]).toMatchObject({ sensitive: true });
    expect(els[2]!.sensitive).toBeUndefined();
  });

  it('skips hidden elements and hidden inputs', () => {
    page(`
      <button style="display:none">Ghost</button>
      <div style="visibility:hidden"><button>Invisible</button></div>
      <input type="hidden" name="csrf" value="x" />
      <button>Real</button>
    `);
    expect(extractElements(document, reg, opts).map((e) => e.text)).toEqual(['Real']);
  });

  it('keeps ids stable across extractions and finds elements by id', () => {
    page(`<button id="a">One</button><button id="b">Two</button>`);
    const first = extractElements(document, reg, opts);
    document.body.insertAdjacentHTML('afterbegin', '<button id="c">New</button>');
    const second = extractElements(document, reg, opts);
    expect(second.find((e) => e.text === 'One')!.id).toBe(first[0]!.id);
    expect(resolve(reg, first[1]!.id)).toBe(document.getElementById('b'));
  });

  it('reaches into open shadow roots', () => {
    page(`<div id="host"></div>`);
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' });
    root.innerHTML = `<button>Inside shadow</button>`;
    expect(extractElements(document, reg, opts).map((e) => e.text)).toEqual(['Inside shadow']);
  });

  it('caps the element count', () => {
    page(Array.from({ length: 300 }, (_, i) => `<button>b${i}</button>`).join(''));
    expect(extractElements(document, reg, { ...opts, max: 150 })).toHaveLength(150);
  });

  it('lists select options and generic role=button', () => {
    page(`<label>Country<select><option>Canada</option><option>USA</option></select></label><div role="button">Continue Application</div>`);
    const els = extractElements(document, reg, opts);
    expect(els[0]).toMatchObject({ type: 'select', label: 'Country', options: ['Canada', 'USA'] });
    expect(els[1]).toMatchObject({ type: 'button', text: 'Continue Application' });
  });

  it('ignores TaskPilot\'s own overlay', () => {
    page(`<div id="taskpilot-root"><button>Return to Task</button></div><button>Page button</button>`);
    expect(extractElements(document, reg, opts).map((e) => e.text)).toEqual(['Page button']);
  });
});

describe('scanFields + insertText', () => {
  it('offers only empty, editable, non-sensitive text fields', () => {
    page(`
      <label>Tell us about a project you're proud of <textarea id="t"></textarea></label>
      <input aria-label="Filled" value="x" />
      <input aria-label="Password" type="password" />
      <input aria-label="Read only" readonly />
      <input aria-label="Agree" type="checkbox" />
    `);
    const fields = scanFields(document, reg, opts);
    expect(fields.map((f) => f.label)).toEqual(["Tell us about a project you're proud of"]);
    expect(fields[0]!.type).toBe('textarea');
  });

  it('inserts text and fires input/change events, but never overwrites or fills sensitive fields', () => {
    page(`<textarea id="t" aria-label="About"></textarea><input id="p" type="password" aria-label="pw"/><input id="f" aria-label="Full" value="keep"/>`);
    const id = scanFields(document, reg, opts)[0]!.id;
    const events: string[] = [];
    document.getElementById('t')!.addEventListener('input', () => events.push('input'));
    document.getElementById('t')!.addEventListener('change', () => events.push('change'));
    insertText(reg, id, 'Built Cairn');
    expect((document.getElementById('t') as HTMLTextAreaElement).value).toBe('Built Cairn');
    expect(events).toEqual(['input', 'change']);

    const all = extractElements(document, reg, opts);
    const pw = all.find((e) => e.inputType === 'password')!;
    const filled = all.find((e) => e.label === 'Full')!;
    expect(() => insertText(reg, pw.id, 'x')).toThrow(/never fills/);
    expect(() => insertText(reg, filled.id, 'x')).toThrow(/overwrite/);
  });
});

describe('pageSummary', () => {
  it('uses description and headings only', () => {
    document.head.innerHTML = '<meta name="description" content="A tutorial on hooks">';
    page('<h1>React Hooks</h1><p>secret body text</p><h2>useState</h2>');
    const s = pageSummary(document);
    expect(s).toContain('A tutorial on hooks');
    expect(s).toContain('React Hooks | useState');
    expect(s).not.toContain('secret body');
  });
});
