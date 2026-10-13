/** Local, lossless packet format used by the V4 experience. No network I/O. */
export const LIMITS = Object.freeze({
  minBudget: 64,
  maxBudget: 512,
  step: 16,
  maxMessages: 6,
  maxTextBytes: 1024,
});

const MAGIC = [0x59, 0x58, 0x34]; // "YX4", format version 4.
const HEADER_BYTES = 4;
const CHECKSUM_BYTES = 4;
const MAX_PACKET_BYTES = HEADER_BYTES + CHECKSUM_BYTES
  + LIMITS.maxMessages * (2 + LIMITS.maxTextBytes);
const encoder = new TextEncoder();
// ignoreBOM preserves an intentional leading U+FEFF in a message.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function assertText(text) {
  if (typeof text !== 'string') throw new TypeError('消息必须是文字。');
  // TextEncoder replaces isolated surrogates. Reject them to guarantee exactness.
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('消息包含无法完整保存的字符。');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('消息包含无法完整保存的字符。');
    }
  }
}

export function byteLength(text) {
  assertText(text);
  return encoder.encode(text).byteLength;
}

function assertMessage(text) {
  assertText(text);
  if (text.trim().length === 0) throw new Error('请先写下完整消息。');
  const encoded = encoder.encode(text);
  if (encoded.byteLength > LIMITS.maxTextBytes) {
    throw new RangeError(`每条消息最多 ${LIMITS.maxTextBytes} B。`);
  }
  return encoded;
}

function assertBudget(budget) {
  if (!Number.isInteger(budget)
    || budget < LIMITS.minBudget
    || budget > LIMITS.maxBudget
    || (budget - LIMITS.minBudget) % LIMITS.step !== 0) {
    throw new RangeError('容量必须是 64–512 B 之间、以 16 B 递增的整数。');
  }
}

function assertCreatedAt(createdAt) {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > 8640000000000000) {
    throw new RangeError('消息保存时间无效。');
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Framing: YX4, count:u8, repeated [length:u16be, UTF-8], CRC32:u32be. */
export function encodePacket(messages) {
  if (!Array.isArray(messages)) throw new TypeError('消息列表格式无效。');
  if (messages.length > LIMITS.maxMessages) {
    throw new RangeError(`一包最多放入 ${LIMITS.maxMessages} 条消息。`);
  }
  const encoded = Array.from(messages, assertMessage);
  const size = HEADER_BYTES + CHECKSUM_BYTES
    + encoded.reduce((total, text) => total + 2 + text.byteLength, 0);
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  packet.set(MAGIC);
  packet[3] = messages.length;
  let offset = HEADER_BYTES;
  for (const text of encoded) {
    view.setUint16(offset, text.byteLength, false);
    offset += 2;
    packet.set(text, offset);
    offset += text.byteLength;
  }
  view.setUint32(offset, crc32(packet.subarray(0, offset)), false);
  return packet;
}

/** Empty lists are measurable (8 B framing), but cannot be sent as receipts. */
export function measurePacket(messages) {
  return encodePacket(messages).byteLength;
}

export function decodePacket(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('消息包必须是字节数组。');
  if (bytes.byteLength < HEADER_BYTES + CHECKSUM_BYTES || bytes.byteLength > MAX_PACKET_BYTES) {
    throw new Error('消息包长度无效或内容不完整。');
  }
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error('无法识别消息包版本。');
  }
  const count = bytes[3];
  if (count > LIMITS.maxMessages) throw new Error('消息条数超出限制。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadEnd = bytes.byteLength - CHECKSUM_BYTES;
  if (view.getUint32(payloadEnd, false) !== crc32(bytes.subarray(0, payloadEnd))) {
    throw new Error('消息包校验失败，内容可能已经损坏。');
  }
  const messages = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > payloadEnd) throw new Error('消息长度记录不完整。');
    const length = view.getUint16(offset, false);
    offset += 2;
    if (length === 0 || length > LIMITS.maxTextBytes || offset + length > payloadEnd) {
      throw new Error('消息长度无效或内容不完整。');
    }
    let message;
    try {
      message = decoder.decode(bytes.subarray(offset, offset + length));
    } catch {
      throw new Error('消息文字编码无效。');
    }
    assertMessage(message);
    messages.push(message);
    offset += length;
  }
  if (offset !== payloadEnd) throw new Error('消息包包含多余内容。');
  return messages;
}

export function createReceipt(messages, budget, now = Date.now()) {
  assertBudget(budget);
  assertCreatedAt(now);
  const packet = encodePacket(messages);
  if (messages.length === 0) throw new Error('请至少选择一条消息。');
  if (packet.byteLength > budget) {
    throw new RangeError(`这一包超出容量 ${packet.byteLength - budget} B。`);
  }
  return { version: 4, packet: Array.from(packet), budget, createdAt: now };
}

/** Saved receipt metadata is checked; received text is always decoded anew. */
export function readReceipt(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || candidate.version !== 4 || !Array.isArray(candidate.packet)) {
    throw new Error('保存的消息记录格式无效。');
  }
  assertBudget(candidate.budget);
  assertCreatedAt(candidate.createdAt);
  if (candidate.packet.length > MAX_PACKET_BYTES) throw new Error('保存的消息包过长。');
  for (const byte of candidate.packet) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error('保存的消息包包含无效字节。');
    }
  }
  const packet = Uint8Array.from(candidate.packet);
  const messages = decodePacket(packet);
  if (messages.length === 0) throw new Error('保存的消息包为空。');
  if (packet.byteLength > candidate.budget) throw new Error('保存的消息包超出容量。');
  return {
    messages,
    byteLength: packet.byteLength,
    budget: candidate.budget,
    createdAt: candidate.createdAt,
    packet: Array.from(packet),
  };
}

/** Accepts either createReceipt's serialized value or readReceipt's result. */
export function receiptText(receipt) {
  const received = readReceipt(receipt?.version === undefined
    ? { ...receipt, version: 4 }
    : receipt);
  const sentAt = new Date(received.createdAt).toISOString();
  return [
    '余讯 · 最后一包',
    '已经抵达的消息',
    '',
    ...received.messages.map((message, index) => `${index + 1}. ${message}`),
    '',
    `这一包：${received.messages.length} 条消息 · ${received.byteLength} / ${received.budget} B`,
    `送出时间：${sentAt}（UTC）`,
    '这是本地模拟传递后保存的完整消息，不需要连接服务器阅读。',
  ].join('\n');
}
