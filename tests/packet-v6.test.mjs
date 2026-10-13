import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, LIMITS, byteLength, encodePacket, decodePacket,
  measurePacket, createReceipt, readReceipt, receiptText,
} from '../public/packet-v6.mjs';
import { createReceipt as createLegacyReceipt } from '../public/packet-core.mjs';

const savedAt = 1791820800000;
const item = (text, category = 'safety') => ({ category, text });

// Table-based test helper repairs checksums to test structural validation beyond CRC.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function repairChecksum(bytes) {
  let crc = 0xffffffff;
  const end = bytes.length - 4;
  for (const byte of bytes.subarray(0, end)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(end, (crc ^ 0xffffffff) >>> 0, false);
  return bytes;
}

test('YX6 independent binary fixture includes one byte of category per item', () => {
  // CRC generated independently with Python zlib.crc32.
  const fixture = Uint8Array.from(Buffer.from('5958360101000141704e7a76', 'hex'));
  assert.deepEqual(encodePacket([item('A')]), fixture);
  assert.deepEqual(decodePacket(fixture), [item('A')]);
  assert.equal(measurePacket([]), 8);
  assert.equal(measurePacket([item('东门'), item('A🙂', 'location')]), 25);
  assert.equal(byteLength('A🙂'), 5);
});

test('every category and its order survive full UTF-8 round trip', () => {
  const texts = [' 集合改到东门。\n请带伞。 ', '我已到达 🫶🏽', '\ufeff保留开头', 'é e\u0301', '取药', '稍后回复'];
  const items = CATEGORIES.slice(0, 6).map((category, index) => item(texts[index], category.id));
  assert.deepEqual(decodePacket(encodePacket(items)), items);
  assert.deepEqual(decodePacket(encodePacket([item('旧消息', 'other')])), [item('旧消息', 'other')]);
  assert.deepEqual(decodePacket(encodePacket([])), []);
  const wrapped = new Uint8Array(encodePacket(items).length + 20);
  wrapped.set(encodePacket(items), 7);
  assert.deepEqual(decodePacket(wrapped.subarray(7, wrapped.length - 13)), items);
});

test('category framing is charged against exact byte budgets', () => {
  const exact = [item('a'.repeat(53))];
  assert.equal(measurePacket(exact), 64);
  assert.equal(readReceipt(createReceipt(exact, 64, savedAt)).byteLength, 64);
  assert.throws(() => createReceipt([item('a'.repeat(54))], 64, savedAt), /超出容量 1 B/);
  const chineseExact = [item('中'.repeat(17) + 'ab', 'plan')];
  assert.equal(measurePacket(chineseExact), 64);
  assert.deepEqual(readReceipt(createReceipt(chineseExact, 64, savedAt)).items, chineseExact);
});

test('receipt snapshots never follow draft edits or read-result edits', () => {
  const items = [item('今晚东门见', 'plan'), item('我到了，别担心 🫶🏽')];
  const expected = structuredClone(items);
  const receipt = createReceipt(items, 128, savedAt);
  const serialized = JSON.parse(JSON.stringify(receipt));
  items[0].text = '明天出发';
  items[1].category = 'later';
  items.push(item('额外消息'));
  const decoded = readReceipt(serialized);
  assert.deepEqual(decoded.items, expected);
  decoded.items[0].text = '修改副本';
  decoded.packet[0] = 0;
  assert.deepEqual(readReceipt(serialized).items, expected);
  assert.deepEqual(serialized, receipt);
});

test('legacy V4 receipt recovery stays exact and is explicitly unclassified', () => {
  const original = ['校园卡在桌上。\n回来时带上 🙂', '\ufeff前导标记'];
  const legacy = createLegacyReceipt(original, 128, savedAt);
  const decoded = readReceipt(legacy);
  assert.equal(decoded.version, 4);
  assert.deepEqual(decoded.items, original.map(text => item(text, 'other')));
  assert.deepEqual(decoded.packet, legacy.packet);
  assert.deepEqual(readReceipt(decoded).items, decoded.items);
  assert.match(receiptText(decoded), /\[未分类\] 校园卡在桌上。\n回来时带上 🙂/);
});

test('download text preserves complete text and labels for both serialized and decoded receipts', () => {
  const original = [item('药已经取了。\n明天记得带卡。', 'life'), item('请联系我', 'safety')];
  const receipt = createReceipt(original, 128, savedAt);
  const text = receiptText(receipt);
  assert.match(text, /1\. \[生活\] 药已经取了。\n明天记得带卡。/);
  assert.match(text, /2\. \[状态\] 请联系我/);
  assert.equal(receiptText(readReceipt(receipt)), text);
});

test('unknown categories, sparse lists and invalid text are never coerced', () => {
  for (const invalid of [null, '消息', {}, { category: 'missing', text: 'A' }, { category: 1, text: 'A' },
    { category: 'safety', text: 1 }, { category: 'safety', text: ' \n\t' }]) {
    assert.throws(() => encodePacket([invalid]));
  }
  assert.throws(() => encodePacket(new Array(1)));
  assert.throws(() => encodePacket('消息'));
  assert.throws(() => createReceipt([], 64, savedAt), /至少选择/);
  for (const text of ['\ud800', '\udfff', 'A\ud800B']) {
    assert.throws(() => encodePacket([item(text)]), /无法完整保存/);
    assert.throws(() => byteLength(text), /无法完整保存/);
  }
});

test('message limits apply before sending without silently shortening drafts', () => {
  const largest = item('a'.repeat(LIMITS.maxTextBytes));
  assert.deepEqual(decodePacket(encodePacket([largest])), [largest]);
  assert.equal(measurePacket([largest]), 1035);
  assert.throws(() => createReceipt([largest], 512, savedAt), /超出容量/);
  assert.throws(() => encodePacket([item(largest.text + 'a')]), /最多 1024/);
  assert.equal(decodePacket(encodePacket(Array(6).fill(item('a')))).length, 6);
  assert.throws(() => encodePacket(Array(7).fill(item('a'))), /最多放入 6/);
});

test('budgets and timestamps reject invalid values on create and read', () => {
  const valid = createReceipt([item('A')], 64, savedAt);
  for (const budget of [0, 63, 65, 513, 528, 64.5, '64', NaN, Infinity, null]) {
    assert.throws(() => createReceipt([item('A')], budget, savedAt));
    assert.throws(() => readReceipt({ ...valid, budget }));
  }
  for (const budget of [64, 80, 192, 512]) assert.equal(readReceipt(createReceipt([item('A')], budget, savedAt)).budget, budget);
  for (const createdAt of [-1, NaN, Infinity, '1', 1.2, 8640000000000001]) {
    assert.throws(() => createReceipt([item('A')], 64, createdAt));
    assert.throws(() => readReceipt({ ...valid, createdAt }));
  }
  for (const createdAt of [0, 8640000000000000]) assert.equal(readReceipt(createReceipt([item('A')], 64, createdAt)).createdAt, createdAt);
});

test('corruption, every truncation and extra bytes never form a successful packet', () => {
  const packet = encodePacket([item('今夜平安')]);
  for (let end = 0; end < packet.length; end += 1) assert.throws(() => decodePacket(packet.slice(0, end)));
  for (let index = 0; index < packet.length; index += 1) {
    const damaged = packet.slice();
    damaged[index] ^= 1;
    assert.throws(() => decodePacket(damaged));
  }
  const extra = new Uint8Array(packet.length + 1);
  extra.set(packet.subarray(0, -4));
  assert.throws(() => decodePacket(repairChecksum(extra)), /多余内容/);
});

test('strict UTF-8, category, count and length are checked even with valid CRC32', () => {
  const invalidCategory = encodePacket([item('A')]);
  invalidCategory[4] = 255;
  assert.throws(() => decodePacket(repairChecksum(invalidCategory)), /分类无效/);
  const invalidUtf8 = encodePacket([item('AB')]);
  invalidUtf8.set([0xc0, 0xaf], 7);
  assert.throws(() => decodePacket(repairChecksum(invalidUtf8)), /文字编码无效/);
  const invalidCount = encodePacket([item('A')]);
  invalidCount[3] = 7;
  assert.throws(() => decodePacket(repairChecksum(invalidCount)), /条数超出限制/);
  const zeroLength = encodePacket([item('A')]);
  zeroLength[6] = 0;
  assert.throws(() => decodePacket(repairChecksum(zeroLength)), /长度无效/);
});

test('saved receipts reject invalid envelopes, byte values and impossible sizes', () => {
  const valid = createReceipt([item('A')], 64, savedAt);
  for (const value of [null, [], {}, { ...valid, version: 5 }, { ...valid, packet: new Uint8Array(valid.packet) }]) {
    assert.throws(() => readReceipt(value));
  }
  for (const byte of [-1, 256, 1.5, '1', NaN, Infinity, null]) {
    assert.throws(() => readReceipt({ ...valid, packet: [byte, ...valid.packet.slice(1)] }));
  }
  assert.throws(() => readReceipt({ ...valid, packet: Array(10000).fill(0) }), /过长/);
  assert.throws(() => readReceipt({ ...valid, packet: Array.from(encodePacket([])) }), /为空/);
  assert.throws(() => readReceipt({ ...valid, packet: Array.from(encodePacket([item('a'.repeat(54))])) }), /超出容量/);
});

