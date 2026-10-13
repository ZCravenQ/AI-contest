import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateReceipt } from '../public/receipt-layout.mjs';

const codepoints = text => Array.from(text).length;

function checkLossless(messages, pages) {
  const reconstructed = Array(messages.length).fill('');
  const seen = new Set();
  let lastIndex = -1;
  for (const page of pages) {
    assert.ok(page.length > 0, 'No empty rendered page');
    for (const item of page) {
      assert.ok(item.text.length > 0, 'No empty page fragment');
      assert.ok(Number.isInteger(item.index) && item.index >= 0 && item.index < messages.length);
      assert.ok(item.index >= lastIndex, 'Message order must remain unchanged');
      assert.equal(item.continuation, seen.has(item.index), 'Only subsequent fragments are continuations');
      reconstructed[item.index] += item.text;
      seen.add(item.index);
      lastIndex = item.index;
    }
  }
  assert.deepEqual(reconstructed, messages, 'Every original character is retained in order');
}

test('empty receipt has no pages', () => {
  assert.deepEqual(paginateReceipt([], () => true), []);
});

test('several messages share a page when the full rendered group fits exactly', () => {
  const messages = ['东门见', '我到了🙂', '带伞'];
  // One unit for each row number, one unit between rows and one per code point.
  const cost = items => items.reduce((sum, item) => sum + 1 + codepoints(item.text), 0)
    + Math.max(0, items.length - 1);
  const expected = messages.map((text, index) => ({ index, continuation: false, text }));
  const capacity = cost(expected);
  const pages = paginateReceipt(messages, items => cost(items) <= capacity);
  assert.deepEqual(pages, [expected]);
  checkLossless(messages, pages);
  const smaller = paginateReceipt(messages, items => cost(items) <= capacity - 1);
  assert.ok(smaller.length > 1, 'Crossing the exact boundary needs another page');
  checkLossless(messages, smaller);
});

test('one message splits without losing newlines, whitespace, emoji or Unicode form', () => {
  const messages = ['  东门\n见🙂\n👩‍🔬 e\u0301\n再见  '];
  const fits = items => items.reduce((sum, item) => sum + codepoints(item.text), 0) <= 4;
  const pages = paginateReceipt(messages, fits);
  assert.ok(pages.length > 3);
  assert.equal(pages[0][0].continuation, false);
  assert.ok(pages.slice(1).every(page => page[0].continuation));
  assert.ok(pages.every(fits));
  // JS string length would incorrectly split this surrogate pair.
  assert.ok(pages.flat().some(item => item.text.includes('🙂')));
  checkLossless(messages, pages);
});

test('a split tail and the next whole message can occupy the same final page', () => {
  const messages = ['abcdef', 'XY'];
  const fits = items => items.reduce((sum, item) => sum + codepoints(item.text), 0) <= 5;
  const pages = paginateReceipt(messages, fits);
  assert.deepEqual(pages, [
    [{ index: 0, continuation: false, text: 'abcde' }],
    [{ index: 0, continuation: true, text: 'f' }, { index: 1, continuation: false, text: 'XY' }],
  ]);
  checkLossless(messages, pages);
});

test('a whole message starts on the next page if only the current page is too small', () => {
  const messages = ['abc', 'defg', 'h'];
  const fits = items => items.reduce((sum, item) => sum + codepoints(item.text), 0) <= 5;
  const pages = paginateReceipt(messages, fits);
  assert.deepEqual(pages, [
    [{ index: 0, continuation: false, text: 'abc' }],
    [{ index: 1, continuation: false, text: 'defg' }, { index: 2, continuation: false, text: 'h' }],
  ]);
  checkLossless(messages, pages);
});

test('the unavoidable floor is a single code point, never an empty or infinite page', () => {
  const messages = ['中🙂', 'A\nB'];
  const pages = paginateReceipt(messages, () => false);
  assert.equal(pages.length, messages.reduce((sum, text) => sum + codepoints(text), 0));
  assert.ok(pages.every(page => page.length === 1 && codepoints(page[0].text) === 1));
  assert.equal(pages[1][0].text, '🙂');
  checkLossless(messages, pages);
});

test('varying budgets retain all text, order and bounds with newline and continuation costs', () => {
  const messages = [
    '集合改到东门。\n20:30 见。',
    '我到宿舍了，别担心。🙂',
    ' A B C\n\n保留两次换行 ',
    '📨'.repeat(17),
    'e\u0301 / é',
    '最后一条',
  ];
  const original = messages.slice();
  const cost = items => items.reduce((sum, item) => {
    const textCost = Array.from(item.text).reduce((value, char) => value + (char === '\n' ? 3 : 1), 0);
    return sum + textCost + (item.continuation ? 3 : 2);
  }, Math.max(0, items.length - 1));
  for (let budget = 1; budget <= 60; budget += 1) {
    const fits = items => cost(items) <= budget;
    const pages = paginateReceipt(messages, fits);
    checkLossless(messages, pages);
    for (const page of pages) {
      assert.ok(fits(page) || (page.length === 1 && codepoints(page[0].text) === 1),
        `Page overflow at budget ${budget} may contain only the unavoidable one-code-point floor`);
    }
  }
  assert.deepEqual(messages, original, 'Pagination must not mutate the received message list');
});
