import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createReceipt, readReceipt, measurePacket } from '../public/packet-v6.mjs';
import { createDefaultMessages, coverage, recommendSelection } from '../public/minimal-v61.mjs';
import { createReceipt as createLegacyReceipt } from '../public/packet-core.mjs';

// A deliberately limited DOM/control/storage model, not a real browser.
// Visual layout, apparent motion, device power and real offline use are not measured.
const pageURL = new URL('../public/index.html', import.meta.url);
const html = fs.readFileSync(pageURL, 'utf8');
const entry = html.match(/<script\s+type="module"\s+src="([^"]+)"/)[1];
const KEY = 'yuxun.last-packet.v4';
const original = new Map();
const networkCalls = [];
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
let context;
let serial = 0;
let passed = 0;

function install(name, value) {
  if (!original.has(name)) original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.disabled = false;
    this.hidden = false;
    this.inert = false;
    this.open = false;
    this.checked = false;
    this.value = '';
    this._text = '';
    this.className = '';
    this.classList = {
      contains: value => this.className.split(/\s+/).includes(value),
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(' '); },
      remove: (...values) => { this.className = this.className.split(/\s+/).filter(value => !values.includes(value)).join(' '); },
      toggle: (value, force) => {
        const enabled = force === undefined ? !this.classList.contains(value) : force;
        this.classList[enabled ? 'add' : 'remove'](value);
        return enabled;
      },
    };
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.replaceChildren(); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  get clientHeight() { return context?.layoutMetrics && this.id === 'received-messages' ? Math.max(80, context.window.innerHeight * 0.4 - 90) : 0; }
  get clientWidth() { return context?.layoutMetrics && this.id === 'received-messages' ? Math.max(180, context.window.innerWidth - 100) : 0; }
  get scrollHeight() {
    if (!context?.layoutMetrics || !this.classList.contains('receipt-measure')) return 0;
    // Synthetic text measurement exercises relayout state, never browser geometry.
    const columns = Math.max(8, Math.floor((parseFloat(this.style.width) - 70) / 16));
    return this.children.reduce((sum, child) => sum + Math.ceil(Array.from(child.querySelector('.received-text').textContent).length / columns) * 28 + 16, 0);
  }
  get offsetWidth() { return 0; }
  append(...children) {
    for (const child of children) {
      if (typeof child === 'string') { this._text += child; continue; }
      child.remove(); child.parentElement = this; this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (['id', 'class', 'value', 'type'].includes(name)) this[name === 'class' ? 'className' : name] = String(value);
    if (['disabled', 'hidden', 'inert', 'checked'].includes(name)) this[name] = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (['disabled', 'hidden', 'inert', 'checked'].includes(name)) this[name] = false;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }
  dispatch(type, detail = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...detail };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'A') { context.downloads.push({ href: this.href, filename: this.download }); return; }
    if (this.type === 'checkbox') this.checked = !this.checked;
    this.dispatch('click');
    if (this.type === 'checkbox') this.dispatch('change');
    if (this.type === 'submit') this.closest('form')?.dispatch('submit', { submitter: this });
  }
  focus() { context.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  matches(selector) {
    return selector.split(',').some(part => {
      const text = part.trim();
      if (text === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
      if (text.startsWith('#')) return this.id === text.slice(1);
      if (text.startsWith('.')) return this.classList.contains(text.slice(1));
      if (text.startsWith('[')) {
        const [, name, value] = text.match(/^\[([^=]+)(?:="([^"]*)")?\]$/) || [];
        return value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value;
      }
      return this.tagName.toLowerCase() === text;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  getBoundingClientRect() { return { width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
  animate(frames, options) {
    if (context.throwHeroAnimation && this.classList.contains('hero-number')) throw new Error('Animation unavailable');
    const animation = { element: this, frames, options, cancelled: false,
      finished: context.pendingAnimations ? new Promise(() => {}) : Promise.resolve(),
      cancel() { this.cancelled = true; } };
    context.animations.push(animation);
    return animation;
  }
}

function parseHtml() {
  const root = new Element('document');
  const stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/([\w-]+)\s*>|<([\w-]+)([^>]*)>|([^<]+)/g)) {
    const [, closing, opening, attributes, text] = token;
    if (closing) {
      const index = stack.findLastIndex(element => element.tagName.toLowerCase() === closing);
      if (index > 0) stack.length = index;
    } else if (opening) {
      const element = new Element(opening);
      for (const [, name, value] of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) element.setAttribute(name, value ?? '');
      stack.at(-1).append(element);
      if (!voidTags.has(opening)) stack.push(element);
    } else if (text) stack.at(-1)._text += text;
  }
  return root;
}

async function setup({ storage = new Map(), denied = false, noWrite = false, noDelete = false, width = 1440, height = 900, reduced = false, layoutMetrics = false, pendingAnimations = false, throwHeroAnimation = false } = {}) {
  const document = new Element('document');
  document.append(parseHtml());
  document.getElementById = id => document.querySelector(`#${id}`);
  document.body = document.querySelector('body');
  document.documentElement = document.querySelector('html');
  document.createElement = tag => new Element(tag);
  const media = new Element('media');
  media.matches = reduced;
  const window = new Element('window');
  Object.assign(window, { innerWidth: width, innerHeight: height, matchMedia: () => media,
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {},
    setTimeout: fn => { context.timers.push(fn); return context.timers.length; }, clearTimeout() {},
  });
  context = { document, window, media, storage, layoutMetrics, pendingAnimations, throwHeroAnimation, animations: [], downloads: [], blobs: new Map(), timers: [] };
  const activeContext = context;
  install('document', document); install('window', window);
  install('requestAnimationFrame', window.requestAnimationFrame); install('cancelAnimationFrame', window.cancelAnimationFrame);
  install('localStorage', {
    getItem(key) { if (denied) throw new Error('denied'); return storage.get(key) ?? null; },
    setItem(key, value) { if (denied) throw new Error('denied'); if (!noWrite) storage.set(key, String(value)); },
    removeItem(key) { if (denied) throw new Error('denied'); if (!noDelete) storage.delete(key); },
  });
  URL.createObjectURL = blob => { const url = `blob:v6-ui-model-${activeContext.blobs.size}`; activeContext.blobs.set(url, blob); return url; };
  URL.revokeObjectURL = () => {};
  const moduleURL = new URL(entry, pageURL);
  moduleURL.searchParams.set('dom-v61-test', String(serial++));
  await import(moduleURL.href);
  const $ = id => { const element = document.getElementById(id); assert(element, `Missing real page element: ${id}`); return element; };
  return { ...context, $,
    click(id) { const element = $(id); assert.equal(element.disabled, false, `${id} should be available`); element.click(); },
    input(id, value) { $(id).value = String(value); $(id).dispatch('input'); },
    change(id, value) { $(id).value = String(value); $(id).dispatch('change'); },
    async settle() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); },
    key(key, target = document.body, modifiers = {}) { return document.dispatch('keydown', { key, target, ...modifiers }); },
    enter() { this.click('enter-minimal'); },
    edit(id, text, category) {
      this.findDraft(id); this.click(`edit-${id}`); this.input('message-text', text);
      if (category) this.change('message-category', category);
      this.click('edit-save');
    },
    findDraft(id) {
      while (!$('draft-prev').disabled) this.click('draft-prev');
      for (let limit = 0; !document.getElementById(`select-${id}`) && limit < 10; limit += 1) this.click('draft-next');
      return $(`select-${id}`);
    },
    selectedIds() {
      const ids = [];
      while (!$('draft-prev').disabled) this.click('draft-prev');
      for (let limit = 0; limit < 10; limit += 1) {
        for (const button of $('message-list').querySelectorAll('.message-select')) {
          if (button.getAttribute('aria-pressed') === 'true') ids.push(button.id.replace('select-', ''));
        }
        if ($('draft-next').disabled) break;
        this.click('draft-next');
      }
      return ids;
    },
    received() { return $('received-messages').querySelectorAll('.received-text').map(element => element.textContent); },
    scene() { return Number(document.body.dataset.scene); },
  };
}

async function test(name, check) {
  await check();
  assert.deepEqual(networkCalls, [], 'Local controls must not call network APIs');
  passed += 1;
  console.log(`PASS ${name}`);
}

for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) install(name, () => { networkCalls.push(name); throw new Error(`Unexpected ${name}`); });

try {
  await test('question opens directly with four chapters and no full-system or sync surface', async () => {
    const h = await setup();
    assert.equal(h.scene(), 1); assert.equal(h.$('scene-1').hidden, false);
    assert.equal(h.$('nav-1').disabled, false);
    for (const id of [2, 3, 4]) assert.equal(h.$(`nav-${id}`).disabled, true);
    for (const id of [2, 3]) { assert.equal(h.$(`scene-${id}`).hidden, true); assert.equal(h.$(`scene-${id}`).inert, true); }
    for (const id of ['nav-0', 'scene-0', 'system-form', 'sync-draft', 'sync-dialog', 'consider-low']) {
      assert.equal(h.document.getElementById(id), null, `Removed full-system element: ${id}`);
    }
    assert.equal(h.$('restore-open').hidden, true);
    h.key('ArrowLeft'); h.key('ArrowRight'); assert.equal(h.scene(), 1);
    assert.equal(h.animations.length, 1);
    assert.equal(h.animations[0].element.classList.contains('hero-number'), true);
    assert.equal(h.$('enter-minimal').disabled, false);
  });

  await test('minimal model exposes independent fixed candidates and bounded category-first recommendations', async () => {
    const a = createDefaultMessages(); const b = createDefaultMessages();
    assert.equal(a.length, 6); assert.deepEqual(a.map(item => item.category), ['safety', 'location', 'plan', 'contact', 'life', 'later']);
    a[0].text = 'changed'; assert.equal(b[0].text, '我平安');
    for (const budget of [64, 80, 96, 128, 512]) {
      const ids = recommendSelection(b, budget);
      const selected = b.filter(item => ids.includes(item.id));
      assert(measurePacket(selected) <= budget);
      assert.equal(coverage(selected).count, budget === 64 ? 3 : 4);
    }
    assert.equal(recommendSelection(b, 96).length, 5);
    assert.throws(() => recommendSelection(b, 95));
    assert.throws(() => recommendSelection([{ ...b[0] }, { ...b[0] }], 96));
    assert.throws(() => coverage([{ category: 'unknown', text: 'x' }]));
  });

  await test('one-shot number reveal cancels on early entry and is not replayed when revisiting the question', async () => {
    const h = await setup({ pendingAnimations: true });
    const intro = h.animations[0];
    assert.equal(intro.element.classList.contains('hero-number'), true);
    assert.equal(intro.options.duration, 560); assert.equal(intro.options.fill, 'none');
    assert.equal(intro.cancelled, false); assert.equal(h.$('enter-minimal').disabled, false);
    assert(intro.frames.every(frame => !Object.hasOwn(frame, 'transform')));
    h.enter(); assert.equal(intro.cancelled, true); assert.equal(h.scene(), 2);
    h.click('nav-1');
    assert.equal(h.animations.filter(animation => animation.element.classList.contains('hero-number')).length, 1);
    assert.equal(h.$('scene-1').inert, false);
  });

  await test('number reveal respects reduced-motion changes and animation API failures never block entry', async () => {
    const h = await setup({ pendingAnimations: true });
    const intro = h.animations[0];
    h.media.matches = true; h.media.dispatch('change', { matches: true });
    assert.equal(intro.cancelled, true); assert.equal(h.scene(), 1);
    assert.equal(h.$('scene-1').hidden, false); assert.equal(h.$('enter-minimal').disabled, false);
    h.enter(); assert.equal(h.scene(), 2); assert.equal(h.animations.length, 1);
    const failure = await setup({ throwHeroAnimation: true });
    assert.equal(failure.animations.length, 0); assert.equal(failure.$('enter-minimal').disabled, false);
    failure.enter(); assert.equal(failure.scene(), 2); assert.equal(failure.$('send').disabled, false);
  });

  await test('question is a separate accessible chapter and explicitly hypothetical', async () => {
    const h = await setup();
    assert.equal(h.scene(), 1);
    assert.match(h.$('scene-title-1').textContent, /1%.*Battery/);
    assert.match(h.$('scene-1').textContent, /未读取设备电量/);
    assert.match(h.$('about-dialog').textContent, /不与字节数换算/);
    assert.equal(h.$('nav-2').disabled, true);
    h.click('enter-minimal'); await h.settle();
    assert.equal(h.scene(), 2);
    assert.equal(h.$('budget').disabled, false);
    assert.equal(h.$('send').disabled, false);
    assert.equal(h.document.activeElement.id, 'scene-title-2');
    assert.match(h.$('coverage-summary').textContent, /4\s*\/\s*4/);
  });

  await test('empty and over-budget selections block sending; coverage recommendation respects capacity', async () => {
    const h = await setup(); h.enter();
    for (const id of h.selectedIds()) { h.findDraft(id).click(); }
    assert.equal(h.$('send').disabled, true);
    assert.match(h.$('capacity-status').textContent, /先选|至少|选择/);
    h.click('recommend');
    assert.equal(h.$('send').disabled, false);
    assert.match(h.$('coverage-summary').textContent, /4\s*\/\s*4/);
    h.input('budget', 64);
    assert.equal(h.$('send').disabled, true);
    h.click('recommend');
    assert.equal(h.$('send').disabled, false);
    assert.match(h.$('coverage-summary').textContent, /3\s*\/\s*4/);
    h.click('send');
    const decoded = readReceipt(JSON.parse(h.storage.get(KEY)));
    assert(decoded.byteLength <= 64);
    assert.equal(new Set(decoded.items.map(item => item.category)).size, 3);
  });

  await test('classification edits change real encoded metadata and coverage without rewriting other text', async () => {
    const h = await setup(); h.enter(); h.input('budget', 512);
    h.edit('m1', '我到了🙂', 'location');
    assert.match(h.findDraft('m1').getAttribute('aria-label'), /我到了🙂/);
    assert.match(h.findDraft('m2').getAttribute('aria-label'), /我在图书馆/);
    assert.match(h.$('coverage-summary').textContent, /3\s*\/\s*4/);
    h.click('send');
    const decoded = readReceipt(JSON.parse(h.storage.get(KEY)));
    const item = decoded.items.find(item => item.text === '我到了🙂');
    assert.deepEqual(item, { category: 'location', text: '我到了🙂' });
    assert.equal(decoded.byteLength, measurePacket(decoded.items));
  });

  await test('editor rejects invalid text; six-message cap releases after deletion and new message is selected', async () => {
    const h = await setup(); h.enter();
    assert.equal(h.$('add-message').disabled, true);
    h.findDraft('m6'); h.click('edit-m6'); h.click('delete-message');
    assert.equal(h.$('add-message').disabled, false);
    h.click('add-message');
    assert.equal(h.$('edit-save').disabled, true);
    h.input('message-text', 'x'.repeat(81)); assert.equal(h.$('edit-save').disabled, true);
    h.input('message-text', '一\n二\n三\n四'); assert.equal(h.$('edit-save').disabled, true);
    h.input('message-text', '自己写的话🙂'); h.change('message-category', 'contact'); h.click('edit-save');
    assert.equal(h.$('edit-dialog').open, false);
    assert.equal(h.$('add-message').disabled, true);
    assert.equal(h.findDraft('m7').getAttribute('aria-pressed'), 'true');
    assert.match(h.findDraft('m7').getAttribute('aria-label'), /自己写的话🙂/);
  });

  await test('returning to the question and entering again preserves edited text, categories and selection', async () => {
    const h = await setup(); h.enter(); h.edit('m2', '我在自己选的位置', 'contact');
    h.findDraft('m2').click();
    const selected = h.selectedIds();
    h.click('nav-1'); assert.equal(h.scene(), 1); h.enter();
    assert.match(h.findDraft('m2').getAttribute('aria-label'), /我在自己选的位置/);
    assert.match(h.findDraft('m2').getAttribute('aria-label'), /联系/);
    assert.equal(h.findDraft('m2').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(h.selectedIds(), selected);
  });

  await test('send creates V6 packet and literal categorized receipt; draft edits preserve received snapshot', async () => {
    const h = await setup(); h.enter(); h.input('budget', 512);
    h.edit('m1', '<img src=x onerror=alert(1)>', 'safety');
    h.click('send'); await h.settle();
    const stored = h.storage.get(KEY); const decoded = readReceipt(JSON.parse(stored));
    assert.equal(decoded.version, 6); assert.equal(h.scene(), 3);
    assert.equal(h.$('nav-4').disabled, true);
    assert.equal(h.document.activeElement.id, 'scene-title-3');
    assert(h.received().includes('<img src=x onerror=alert(1)>'));
    assert.equal(h.$('received-messages').querySelectorAll('img').length, 0);
    assert.match(h.$('received-messages').textContent, /状态|位置/);
    h.click('edit-draft'); h.edit('m1', '重新写的内容', 'safety');
    assert.equal(h.storage.get(KEY), stored);
    h.click('nav-3'); assert(h.received().includes('<img src=x onerror=alert(1)>'));
    h.click('edit-draft'); h.click('send');
    assert.notEqual(h.storage.get(KEY), stored);
    assert(h.received().includes('重新写的内容'));
  });

  await test('disconnect changes state but retains exact receipt nodes and page; re-send re-locks kept chapter', async () => {
    const h = await setup(); h.enter(); h.click('send');
    const paper = h.$('receipt-paper'); const body = h.$('received-messages');
    const rows = [...body.children]; const page = h.$('received-page').textContent; const before = h.received();
    h.click('disconnect'); await h.settle();
    assert.equal(h.scene(), 4); assert.equal(h.$('scene-3').hidden, false);
    assert.equal(h.$('receipt-paper'), paper); assert.equal(h.$('received-messages'), body);
    assert.deepEqual([...body.children], rows); assert.deepEqual(h.received(), before);
    assert.equal(h.$('received-page').textContent, page);
    assert.equal(h.$('download').hidden, false);
    h.click('nav-3'); assert.match(h.$('connection-label').textContent, /结束|断开/);
    h.key('ArrowRight'); assert.equal(h.scene(), 4);
    h.click('edit-draft'); h.click('send');
    assert.equal(h.$('nav-4').disabled, true);
  });

  await test('existing V4 record is recoverable without bypassing question opening', async () => {
    const receipt = createLegacyReceipt(['旧版原话🙂', '第二句'], 128, 1700000000000);
    const h = await setup({ storage: new Map([[KEY, JSON.stringify(receipt)]]) });
    assert.equal(h.scene(), 1); assert.equal(h.$('restore-open').hidden, false);
    h.click('restore-open');
    assert.equal(h.scene(), 4);
    assert.deepEqual(h.received(), ['旧版原话🙂', '第二句']);
    assert.match(h.$('received-messages').textContent, /未分类/);
    assert.equal(JSON.parse(h.storage.get(KEY)).version, 4);
  });

  await test('valid V6 record retains categories and damaged record is visibly rejected', async () => {
    const receipt = createReceipt([{ category: 'contact', text: '恢复分类🙂' }], 128, 1700000000000);
    const h = await setup({ storage: new Map([[KEY, JSON.stringify(receipt)]]) });
    h.click('restore-open'); assert.deepEqual(h.received(), ['恢复分类🙂']);
    assert.match(h.$('received-messages').textContent, /联系/);
    receipt.packet[8] ^= 1;
    const bad = await setup({ storage: new Map([[KEY, JSON.stringify(receipt)]]) });
    assert.equal(bad.scene(), 1); assert.equal(bad.$('restore-open').hidden, true);
    assert.equal(bad.$('nav-3').disabled, true);
    assert.match(bad.$('announcement').textContent, /未能恢复|损坏|无效/);
  });

  await test('stored receipt and new default draft remain independent until explicitly editing the note', async () => {
    const receipt = createReceipt([{ category: 'location', text: '这是旧的西门约定' }], 128, 1700000000000);
    const stored = JSON.stringify(receipt);
    const h = await setup({ storage: new Map([[KEY, stored]]) });
    assert.equal(h.$('nav-2').disabled, true);
    h.enter(); assert.match(h.findDraft('m2').getAttribute('aria-label'), /我在图书馆/);
    assert.equal(h.$('budget').value, '96'); assert.equal(h.storage.get(KEY), stored);
    h.click('nav-4'); assert.deepEqual(h.received(), ['这是旧的西门约定']);
    h.click('edit-draft'); assert.match(h.findDraft('m2').getAttribute('aria-label'), /我在图书馆/);
    const noteFirst = await setup({ storage: new Map([[KEY, stored]]) });
    noteFirst.click('restore-open'); assert.match(noteFirst.$('edit-draft').textContent, /便笺/);
    noteFirst.click('edit-draft'); assert.match(noteFirst.findDraft('m1').getAttribute('aria-label'), /这是旧的西门约定/);
    assert.equal(noteFirst.$('budget').value, '128'); assert.equal(noteFirst.storage.get(KEY), stored);
  });

  await test('denied or ineffective storage leaves complete in-page receipt and honest memory-only notice', async () => {
    for (const option of [{ denied: true }, { noWrite: true }]) {
      const h = await setup(option); h.enter(); h.click('send'); h.click('disconnect');
      assert(h.received().length >= 4);
      assert.match(h.$('receipt-storage').textContent, /仅(?:保留)?在当前页面(?:保留)?/);
      assert.match(h.$('receipt-storage').textContent, /刷新不会保留/);
      assert.equal(h.storage.has(KEY), false);
    }
  });

  await test('keyboard chapter movement respects controls, dialogs, composition and modifier keys', async () => {
    const h = await setup(); h.enter();
    for (const id of ['budget', 'message-category', 'message-text']) { h.key('ArrowLeft', h.$(id)); assert.equal(h.scene(), 2); }
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      h.key('ArrowLeft', h.document.body, modifiers); assert.equal(h.scene(), 2);
    }
    h.click('about-open'); h.key('ArrowLeft'); assert.equal(h.scene(), 2);
    h.click('about-close'); h.key('ArrowLeft'); assert.equal(h.scene(), 1);
    h.key('ArrowRight'); assert.equal(h.scene(), 2);
  });

  await test('reduced motion avoids animations and changing preference settles current visibility', async () => {
    const h = await setup({ reduced: true }); h.enter(); h.click('send'); h.click('disconnect');
    assert.equal(h.animations.length, 0);
    h.media.matches = false; h.media.dispatch('change', { matches: false });
    h.click('nav-1'); await h.settle(); assert(h.animations.length > 0);
    h.media.matches = true; h.media.dispatch('change', { matches: true });
    assert.equal(h.$('scene-1').hidden, false); assert.equal(h.$('scene-1').inert, false);
    assert.equal(h.$('scene-2').hidden, true);
    assert(h.animations.every(animation => animation.cancelled));
  });

  await test('completed motion releases fill state and rapid page changes leave one interactive scene', async () => {
    const h = await setup(); h.enter(); h.click('nav-1'); h.click('nav-2'); await h.settle();
    assert.equal(h.scene(), 2);
    for (const id of [1, 3]) { assert.equal(h.$(`scene-${id}`).inert, true); assert.equal(h.$(`scene-${id}`).hidden, true); }
    assert.equal(h.$('scene-2').inert, false); assert.equal(h.$('scene-2').hidden, false);
    assert(h.animations.every(animation => animation.cancelled));
    assert(h.animations.every(animation => animation.frames.every(frame => !String(frame.transform).includes('scale'))));
  });

  await test('resize keeps focused message on the visible new draft page', async () => {
    const h = await setup(); h.enter();
    h.findDraft('m4'); h.$('edit-m4').focus();
    h.window.innerHeight = 540; h.window.dispatch('resize');
    assert.equal(h.$('message-list').children.length, 1);
    assert.equal(h.document.activeElement.id, 'edit-m4');
    assert.equal(h.document.activeElement, h.$('edit-m4'));
    assert.equal(h.$('scene-2').hidden, false); assert.equal(h.$('scene-2').inert, false);
  });

  await test('long receipt paging reconstructs all text and disconnect preserves a later page', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ category: ['safety', 'location', 'plan', 'contact', 'life', 'later'][index], text: `${index + 1}: ${String.fromCharCode(65 + index).repeat(70)}` }));
    const receipt = createReceipt(items, 512, 1700000000000);
    const h = await setup({ width: 390, height: 540, storage: new Map([[KEY, JSON.stringify(receipt)]]) });
    h.click('restore-open');
    const reconstructed = Array.from({ length: items.length }, () => '');
    let pagesSeen = 0;
    do {
      for (const row of h.$('received-messages').children) reconstructed[Number(row.dataset.messageIndex)] += row.querySelector('.received-text').textContent;
      pagesSeen += 1;
      if (h.$('received-next').disabled) break;
      h.click('received-next'); assert(pagesSeen < 30, 'Receipt pagination must terminate');
    } while (true);
    assert(pagesSeen > 1); assert.deepEqual(reconstructed, items.map(item => item.text));
    const rows = [...h.$('received-messages').children]; const page = h.$('received-page').textContent;
    h.click('nav-3'); h.click('nav-4');
    assert.deepEqual([...h.$('received-messages').children], rows); assert.equal(h.$('received-page').textContent, page);
    h.click('edit-draft'); assert.equal(h.$('message-list').children.length, 1);
    assert.equal(h.$('draft-pager').hidden, false);
    h.window.innerWidth = 1440; h.window.innerHeight = 900; h.window.dispatch('resize');
    assert(h.$('message-list').children.length > 1);
  });

  await test('download preserves categories and full literal text; clear confirmation retains draft', async () => {
    const h = await setup(); h.enter(); h.input('budget', 512); h.edit('m1', '保存我的原话🙂', 'safety');
    h.click('send'); h.click('disconnect'); h.click('download');
    assert.equal(h.downloads.length, 1);
    const file = await h.blobs.get(h.downloads[0].href).text();
    assert.match(file, /保存我的原话🙂/); assert.match(file, /\[状态\]/); assert.match(file, /\[位置\]/);
    h.click('about-open'); h.click('forget-open'); h.click('forget-cancel'); assert.equal(h.storage.has(KEY), true);
    h.click('about-open'); h.click('forget-open'); h.click('forget-confirm');
    assert.equal(h.storage.has(KEY), false); assert.equal(h.$('nav-3').disabled, true);
    assert.deepEqual(h.received(), []);
    if (h.scene() !== 2) h.click('nav-2');
    assert.match(h.findDraft('m1').getAttribute('aria-label'), /保存我的原话🙂/);
  });

  await test('receipt relayout preserves the same reading anchor under synthetic measurement changes', async () => {
    const sequence = Array.from({ length: 70 }, (_, index) => String.fromCharCode(33 + index)).join('');
    const items = Array.from({ length: 6 }, (_, index) => ({ category: 'other', text: `${index}: ${sequence}` }));
    const receipt = createReceipt(items, 512, 1700000000000);
    const h = await setup({ width: 390, height: 540, layoutMetrics: true, storage: new Map([[KEY, JSON.stringify(receipt)]]) });
    h.click('restore-open'); h.click('received-next'); h.click('received-next');
    const beforeRow = h.$('received-messages').firstElementChild;
    const anchor = { index: Number(beforeRow.dataset.messageIndex), firstText: beforeRow.querySelector('.received-text').textContent };
    const anchorOffset = items[anchor.index].text.indexOf(anchor.firstText);
    assert(anchorOffset >= 0);
    h.window.innerWidth = 1100; h.window.innerHeight = 900; h.window.dispatch('resize');
    const currentRows = [...h.$('received-messages').children].filter(row => Number(row.dataset.messageIndex) === anchor.index);
    assert(currentRows.length > 0, 'New reading page must contain the former anchor message');
    assert(currentRows.some(row => {
      const text = row.querySelector('.received-text').textContent;
      const start = items[anchor.index].text.indexOf(text);
      return start <= anchorOffset && start + text.length > anchorOffset;
    }), 'Relayout page must contain the same character offset, not merely reuse old page number');
  });

  await test('failed or silently ineffective record deletion keeps note and shows a recoverable error', async () => {
    for (const option of [{ denied: true }, { noDelete: true }]) {
      const h = await setup(option); h.enter(); h.click('send'); h.click('disconnect');
      const before = h.received();
      h.click('about-open'); h.click('forget-open'); h.click('forget-confirm');
      assert.equal(h.$('forget-dialog').open, true);
      assert.match(h.$('forget-error').textContent, /无法清除/);
      assert.deepEqual(h.received(), before);
      assert.equal(h.$('nav-4').disabled, false);
      h.click('forget-cancel'); assert.equal(h.$('forget-dialog').open, false);
    }
  });
} finally {
  URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
  for (const [name, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}

console.log(`${passed} V6.1 ordinary-control DOM groups passed. No network calls. Not browser layout, animation appearance, real offline or energy validation.`);

