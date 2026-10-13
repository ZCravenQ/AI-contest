/** Local, lossless classified messages. CRC32 detects damage; it is not encryption. */
import { byteLength as textByteLength, readReceipt as readLegacyReceipt } from './packet-core.mjs';

export const LIMITS = Object.freeze({ minBudget: 64, maxBudget: 512, step: 16, maxMessages: 6, maxTextBytes: 1024 });
export const CATEGORIES = Object.freeze([
  { id: 'safety', label: '状态', code: 1, basic: true },
  { id: 'location', label: '位置', code: 2, basic: true },
  { id: 'plan', label: '下一步', code: 3, basic: true },
  { id: 'contact', label: '联系', code: 4, basic: true },
  { id: 'life', label: '生活', code: 5, basic: false },
  { id: 'later', label: '稍后', code: 6, basic: false },
  { id: 'other', label: '未分类', code: 0, basic: false },
].map(Object.freeze));
export const BASIC_CATEGORIES = Object.freeze(CATEGORIES.filter(item => item.basic).map(item => item.id));
const byId = new Map(CATEGORIES.map(item => [item.id, item]));
const byCode = new Map(CATEGORIES.map(item => [item.code, item]));
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAGIC = [0x59, 0x58, 0x36];
const FRAMING_BYTES = 8;
const MAX_PACKET_BYTES = FRAMING_BYTES + LIMITS.maxMessages * (3 + LIMITS.maxTextBytes);
export const byteLength = textByteLength;

function assertBudget(budget) {
  if (!Number.isInteger(budget) || budget < LIMITS.minBudget || budget > LIMITS.maxBudget
    || (budget - LIMITS.minBudget) % LIMITS.step !== 0) {
    throw new RangeError('容量必须是 64–512 B 之间、以 16 B 递增的整数。');
  }
}

function assertCreatedAt(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) {
    throw new RangeError('消息保存时间无效。');
  }
}

function assertItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !byId.has(item.category)) {
    throw new TypeError('消息分类无效。');
  }
  const size = byteLength(item.text);
  if (item.text.trim().length === 0) throw new Error('请先写下完整消息。');
  if (size > LIMITS.maxTextBytes) throw new RangeError(`每条消息最多 ${LIMITS.maxTextBytes} B。`);
  return { code: byId.get(item.category).code, text: encoder.encode(item.text) };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** YX6, count:u8, repeated [category:u8, length:u16be, full UTF-8], CRC32:u32be. */
export function encodePacket(items) {
  if (!Array.isArray(items)) throw new TypeError('消息列表格式无效。');
  if (items.length > LIMITS.maxMessages) throw new RangeError(`一包最多放入 ${LIMITS.maxMessages} 条消息。`);
  const encoded = Array.from(items, assertItem);
  const size = FRAMING_BYTES + encoded.reduce((sum, item) => sum + 3 + item.text.byteLength, 0);
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  packet.set(MAGIC);
  packet[3] = encoded.length;
  let offset = 4;
  for (const item of encoded) {
    packet[offset] = item.code;
    view.setUint16(offset + 1, item.text.byteLength, false);
    offset += 3;
    packet.set(item.text, offset);
    offset += item.text.byteLength;
  }
  view.setUint32(offset, crc32(packet.subarray(0, offset)), false);
  return packet;
}

/** Empty drafts cost 8 framing bytes, but cannot become receipts. */
export function measurePacket(items) { return encodePacket(items).byteLength; }

export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('消息包必须是字节数组。');
  if (bytes.byteLength < FRAMING_BYTES || bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error('消息包长度无效或内容不完整。');
  }
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) throw new Error('无法识别消息包版本。');
  if (bytes[3] > LIMITS.maxMessages) throw new Error('消息条数超出限制。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 4;
  if (view.getUint32(end, false) !== crc32(bytes.subarray(0, end))) {
    throw new Error('消息包校验失败，内容可能已经损坏。');
  }
  let offset = 4;
  const items = [];
  for (let index = 0; index < bytes[3]; index += 1) {
    if (offset + 3 > end) throw new Error('消息长度记录不完整。');
    const category = byCode.get(bytes[offset]);
    if (!category) throw new Error('消息分类无效。');
    const length = view.getUint16(offset + 1, false);
    offset += 3;
    if (length === 0 || length > LIMITS.maxTextBytes || offset + length > end) {
      throw new Error('消息长度无效或内容不完整。');
    }
    let text;
    try { text = decoder.decode(bytes.subarray(offset, offset + length)); }
    catch { throw new Error('消息文字编码无效。'); }
    const item = { category: category.id, text };
    assertItem(item);
    items.push(item);
    offset += length;
  }
  if (offset !== end) throw new Error('消息包包含多余内容。');
  return items;
}

export function createReceipt(items, budget, timestamp = Date.now()) {
  assertBudget(budget);
  assertCreatedAt(timestamp);
  const packet = encodePacket(items);
  if (items.length === 0) throw new Error('请至少选择一条消息。');
  if (packet.byteLength > budget) throw new RangeError(`这一包超出容量 ${packet.byteLength - budget} B。`);
  return { version: 6, packet: Array.from(packet), budget, createdAt: timestamp };
}

/** Every display is decoded anew. Legacy V4 texts stay lossless and explicitly unclassified. */
export function readReceipt(candidate) {
  if (candidate?.version === 4) {
    const old = readLegacyReceipt(candidate);
    return {
      items: old.messages.map(text => ({ category: 'other', text })),
      byteLength: old.byteLength, budget: old.budget, createdAt: old.createdAt,
      packet: old.packet, version: 4,
    };
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || candidate.version !== 6 || !Array.isArray(candidate.packet)) {
    throw new Error('保存的消息记录格式无效。');
  }
  assertBudget(candidate.budget);
  assertCreatedAt(candidate.createdAt);
  if (candidate.packet.length > MAX_PACKET_BYTES) throw new Error('保存的消息包过长。');
  for (const byte of candidate.packet) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('保存的消息包包含无效字节。');
  }
  const packet = Uint8Array.from(candidate.packet);
  const items = decodePacket(packet);
  if (items.length === 0) throw new Error('保存的消息包为空。');
  if (packet.byteLength > candidate.budget) throw new Error('保存的消息包超出容量。');
  return { items, byteLength: packet.byteLength, budget: candidate.budget,
    createdAt: candidate.createdAt, packet: Array.from(packet), version: 6 };
}

/** Accepts either the serialized receipt or readReceipt's decoded result. */
export function receiptText(receipt) {
  const received = readReceipt(receipt);
  return [
    '余讯 · 最后一包', '已经抵达的消息', '',
    ...received.items.map((item, index) => `${index + 1}. [${byId.get(item.category).label}] ${item.text}`),
    '', `这一包：${received.items.length} 条消息 · ${received.byteLength} / ${received.budget} B`,
    `送出时间：${new Date(received.createdAt).toISOString()}（UTC）`,
    '这是本地模拟传递后保存的完整消息，不需要连接服务器阅读。',
  ].join('\n');
}
