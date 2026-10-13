import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, byteLength, encodePacket, decodePacket, measurePacket,
  createReceipt, readReceipt, receiptText,
} from '../public/packet-core.mjs';

const hex = (value) => Uint8Array.from(Buffer.from(value, 'hex'));
const savedAt = 1791820800000;

test('actual UTF-8 cost differs from character count, including emoji', () => {
  assert.equal(byteLength('东门'), 6);
  assert.equal(byteLength('A🙂'), 5);
  assert.equal(byteLength(''), 0);
  assert.equal(measurePacket(['东门', 'A🙂']), 23);
  assert.equal(measurePacket([]), 8);
});

test('independent binary fixture agrees with framing and CRC32', () => {
  // Fixture CRC generated independently using Python zlib, not the implementation.
  const fixture = hex('595834010001413f21c0e4');
  assert.deepEqual(encodePacket(['A']), fixture);
  assert.deepEqual(decodePacket(fixture), ['A']);
});

test('Chinese, emoji, newlines, spaces and Unicode form survive unchanged', () => {
  const original = [' 集合改到东门。\n请带伞。 ', '我到了，别担心 🫶🏽', '\ufeff保留开头字符', 'é e\u0301'];
  assert.deepEqual(decodePacket(encodePacket(original)), original);
  assert.deepEqual(decodePacket(encodePacket([])), []);
});

test('decoder respects a Uint8Array subview rather than its backing buffer', () => {
  const expected = ['放在更大的缓冲区中'];
  const packet = encodePacket(expected);
  const wrapped = new Uint8Array(packet.length + 20);
  wrapped.set(packet, 7);
  assert.deepEqual(decodePacket(wrapped.subarray(7, 7 + packet.length)), expected);
});

test('whole messages fit exactly at the byte budget; one extra byte is rejected', () => {
  const exact = ['a'.repeat(54)];
  assert.equal(measurePacket(exact), 64);
  assert.equal(readReceipt(createReceipt(exact, 64, savedAt)).byteLength, 64);
  assert.throws(() => createReceipt(['a'.repeat(55)], 64, savedAt), /超出容量 1 B/);
  const chineseExact = ['中'.repeat(18)];
  assert.equal(measurePacket(chineseExact), 64);
  assert.deepEqual(readReceipt(createReceipt(chineseExact, 64, savedAt)).messages, chineseExact);
});

test('measure supports messages too large for current budget without truncation', () => {
  const text = '文字'.repeat(100);
  assert.equal(measurePacket([text]), 610);
  assert.deepEqual(decodePacket(encodePacket([text])), [text]);
  assert.throws(() => createReceipt([text], 512, savedAt), /超出容量/);
});

test('receipt survives JSON storage and source edits do not rewrite sent content', () => {
  const draft = ['今晚八点，东门见。', '我已经安全到达。'];
  const receipt = createReceipt(draft, 192, savedAt);
  const persisted = JSON.parse(JSON.stringify(receipt));
  draft[0] = '明天才出发';
  draft.push('新消息');
  const received = readReceipt(persisted);
  assert.deepEqual(received.messages, ['今晚八点，东门见。', '我已经安全到达。']);
  received.messages[0] = '修改显示副本';
  received.packet[0] = 0;
  assert.deepEqual(readReceipt(persisted).messages, ['今晚八点，东门见。', '我已经安全到达。']);
  assert.deepEqual(persisted, receipt);
});

test('empty/blank messages and invalid types cannot be sent', () => {
  assert.throws(() => createReceipt([], 64, savedAt), /至少选择/);
  for (const text of ['', '  \n\t', null, 123, {}, undefined]) {
    assert.throws(() => encodePacket([text]));
  }
  assert.throws(() => encodePacket(new Array(1)));
  assert.throws(() => encodePacket('消息'));
  assert.throws(() => byteLength(2));
});

test('isolated surrogates are rejected rather than silently changing the text', () => {
  for (const text of ['\ud800', '\udfff', 'A\ud800B']) {
    assert.throws(() => encodePacket([text]), /无法完整保存/);
    assert.throws(() => byteLength(text), /无法完整保存/);
  }
});

test('message and count bounds are enforced independently of send budget', () => {
  const largest = 'a'.repeat(LIMITS.maxTextBytes);
  assert.deepEqual(decodePacket(encodePacket([largest])), [largest]);
  assert.throws(() => encodePacket([largest + 'a']), /最多 1024/);
  assert.equal(decodePacket(encodePacket(Array(6).fill('a'))).length, 6);
  assert.throws(() => encodePacket(Array(7).fill('a')), /最多放入 6/);
});

test('budgets and timestamps are validated without coercion', () => {
  for (const budget of [0, 63, 65, 513, 528, 64.5, '64', NaN, Infinity, null]) {
    assert.throws(() => createReceipt(['A'], budget, savedAt));
  }
  for (const budget of [64, 80, 192, 512]) {
    assert.equal(readReceipt(createReceipt(['A'], budget, savedAt)).budget, budget);
  }
  for (const date of [-1, NaN, Infinity, '1', 1.2, 8640000000000001]) {
    assert.throws(() => createReceipt(['A'], 64, date));
  }
});

test('a corrupted or truncated packet cannot become a successful receipt', () => {
  const valid = encodePacket(['今夜平安']);
  for (let end = 0; end < valid.length; end += 1) {
    assert.throws(() => decodePacket(valid.slice(0, end)));
  }
  const corrupted = valid.slice();
  corrupted[6] ^= 1;
  assert.throws(() => decodePacket(corrupted), /校验失败/);
  const wrongVersion = valid.slice();
  wrongVersion[2] = 0x35;
  assert.throws(() => decodePacket(wrongVersion), /版本/);
  const tooMany = valid.slice();
  tooMany[3] = 7;
  assert.throws(() => decodePacket(tooMany), /条数/);
  assert.throws(() => decodePacket(Array.from(valid)), /字节数组/);
});

test('valid checksums cannot bypass strict UTF-8, length or trailing-byte checks', () => {
  // Independent fixtures carry valid CRCs, so failures must concern their content.
  const invalid = [
    ['595834010002c0af13ed4106', /编码无效/],
    ['595834010001200594912a', /写下完整消息/],
    ['595834010000ecab7957', /长度无效/],
    ['59583401000241140c9327', /内容不完整/],
    ['5958340100c7e101e7', /长度记录不完整/],
    ['5958340100014142ed88c890', /多余内容/],
    ['5958340104014138286838', /长度无效/],
    ['5958340041df2141a0', /多余内容/],
  ];
  for (const [fixture, expected] of invalid) {
    assert.throws(() => decodePacket(hex(fixture)), expected);
  }
});

test('saved payload validates byte values, metadata, capacity and actual contents', () => {
  const receipt = createReceipt(['A'], 64, savedAt);
  for (const candidate of [null, [], {}, { ...receipt, version: 3 },
    { ...receipt, packet: new Uint8Array(receipt.packet) },
    { ...receipt, budget: '64' }, { ...receipt, createdAt: null },
    { ...receipt, packet: Array(6200).fill(0) },
    { ...receipt, packet: Array.from(encodePacket([])) },
    { ...receipt, packet: Array.from(encodePacket(['a'.repeat(55)])) },
  ]) {
    assert.throws(() => readReceipt(candidate));
  }
  for (const byte of [-1, 256, 0.5, '89', null, undefined, NaN]) {
    const bytes = receipt.packet.slice();
    bytes[0] = byte;
    assert.throws(() => readReceipt({ ...receipt, packet: bytes }));
  }
  const sparse = receipt.packet.slice();
  delete sparse[0];
  assert.throws(() => readReceipt({ ...receipt, packet: sparse }));
  assert.deepEqual(readReceipt({ ...receipt, messages: ['伪造显示文字'] }).messages, ['A']);
});

test('plain-text result carries complete received content and can stand alone', () => {
  const receipt = createReceipt(['我到了，别担心。\n明天见！', '  原样保留  '], 192, savedAt);
  const text = receiptText(receipt);
  assert.match(text, /余讯 · 最后一包/);
  assert.ok(text.includes('我到了，别担心。\n明天见！'));
  assert.ok(text.includes('  原样保留  '));
  assert.ok(text.includes('本地模拟传递'));
  assert.ok(text.includes('UTC'));
  assert.equal(receiptText(readReceipt(receipt)), text);
  assert.throws(() => receiptText({ ...receipt, version: 3 }));
});
