export type FeishuFrameHeader = {
  key: string;
  value: string;
};

export type FeishuFrame = {
  SeqID?: bigint;
  LogID?: bigint;
  service?: number;
  method?: number;
  headers?: FeishuFrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFeishuFrame(frame: FeishuFrame): Uint8Array {
  const parts: Uint8Array[] = [];

  pushVarintField(parts, 1, frame.SeqID ?? 0n);
  pushVarintField(parts, 2, frame.LogID ?? 0n);
  if (frame.service != null) pushVarintField(parts, 3, BigInt(frame.service));
  if (frame.method != null) pushVarintField(parts, 4, BigInt(frame.method));
  for (const header of frame.headers ?? []) {
    pushBytesField(parts, 5, encodeHeader(header));
  }
  if (frame.payloadEncoding != null) pushStringField(parts, 6, frame.payloadEncoding);
  if (frame.payloadType != null) pushStringField(parts, 7, frame.payloadType);
  if (frame.payload != null) pushBytesField(parts, 8, frame.payload);
  if (frame.LogIDNew != null) pushStringField(parts, 9, frame.LogIDNew);

  return concat(parts);
}

export function decodeFeishuFrame(buffer: Uint8Array): FeishuFrame {
  const frame: FeishuFrame = { headers: [] };
  let offset = 0;
  while (offset < buffer.length) {
    const keyInfo = readVarint(buffer, offset);
    const tag = Number(keyInfo.value);
    offset = keyInfo.offset;
    const fieldNumber = tag >> 3;
    const wireType = tag & 0b111;

    switch (fieldNumber) {
      case 1: {
        const value = readRequiredVarint(buffer, offset, wireType);
        frame.SeqID = value.value;
        offset = value.offset;
        break;
      }
      case 2: {
        const value = readRequiredVarint(buffer, offset, wireType);
        frame.LogID = value.value;
        offset = value.offset;
        break;
      }
      case 3: {
        const value = readRequiredVarint(buffer, offset, wireType);
        frame.service = Number(value.value);
        offset = value.offset;
        break;
      }
      case 4: {
        const value = readRequiredVarint(buffer, offset, wireType);
        frame.method = Number(value.value);
        offset = value.offset;
        break;
      }
      case 5: {
        const value = readLengthDelimited(buffer, offset, wireType);
        frame.headers?.push(decodeHeader(value.value));
        offset = value.offset;
        break;
      }
      case 6: {
        const value = readLengthDelimited(buffer, offset, wireType);
        frame.payloadEncoding = textDecoder.decode(value.value);
        offset = value.offset;
        break;
      }
      case 7: {
        const value = readLengthDelimited(buffer, offset, wireType);
        frame.payloadType = textDecoder.decode(value.value);
        offset = value.offset;
        break;
      }
      case 8: {
        const value = readLengthDelimited(buffer, offset, wireType);
        frame.payload = value.value;
        offset = value.offset;
        break;
      }
      case 9: {
        const value = readLengthDelimited(buffer, offset, wireType);
        frame.LogIDNew = textDecoder.decode(value.value);
        offset = value.offset;
        break;
      }
      default: {
        offset = skipUnknownField(buffer, offset, wireType);
        break;
      }
    }
  }

  return frame;
}

export function feishuFrameHeadersToRecord(headers: FeishuFrameHeader[] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers ?? []) {
    record[header.key] = header.value;
  }
  return record;
}

function encodeHeader(header: FeishuFrameHeader): Uint8Array {
  const parts: Uint8Array[] = [];
  pushStringField(parts, 1, header.key);
  pushStringField(parts, 2, header.value);
  return concat(parts);
}

function decodeHeader(buffer: Uint8Array): FeishuFrameHeader {
  const header: FeishuFrameHeader = { key: '', value: '' };
  let offset = 0;
  while (offset < buffer.length) {
    const keyInfo = readVarint(buffer, offset);
    const tag = Number(keyInfo.value);
    offset = keyInfo.offset;
    const fieldNumber = tag >> 3;
    const wireType = tag & 0b111;

    if (fieldNumber === 1) {
      const value = readLengthDelimited(buffer, offset, wireType);
      header.key = textDecoder.decode(value.value);
      offset = value.offset;
      continue;
    }

    if (fieldNumber === 2) {
      const value = readLengthDelimited(buffer, offset, wireType);
      header.value = textDecoder.decode(value.value);
      offset = value.offset;
      continue;
    }

    offset = skipUnknownField(buffer, offset, wireType);
  }

  return header;
}

function pushVarintField(parts: Uint8Array[], fieldNumber: number, value: bigint): void {
  parts.push(writeVarint(BigInt((fieldNumber << 3) | 0)));
  parts.push(writeVarint(value));
}

function pushStringField(parts: Uint8Array[], fieldNumber: number, value: string): void {
  pushBytesField(parts, fieldNumber, textEncoder.encode(value));
}

function pushBytesField(parts: Uint8Array[], fieldNumber: number, value: Uint8Array): void {
  parts.push(writeVarint(BigInt((fieldNumber << 3) | 2)));
  parts.push(writeVarint(BigInt(value.length)));
  parts.push(value);
}

function writeVarint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('Negative varint is not supported');
  const bytes: number[] = [];
  let current = value;
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (current > 0n);
  return Uint8Array.from(bytes);
}

function readVarint(buffer: Uint8Array, start: number): { value: bigint; offset: number } {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < buffer.length) {
    const byte = buffer[offset];
    if (byte == null) throw new Error('Unexpected end of buffer while reading varint');
    result |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value: result, offset };
    shift += 7n;
  }
  throw new Error('Unexpected end of buffer while reading varint');
}

function readRequiredVarint(buffer: Uint8Array, start: number, wireType: number): { value: bigint; offset: number } {
  if (wireType !== 0) throw new Error(`Expected varint wire type, got ${wireType}`);
  return readVarint(buffer, start);
}

function readLengthDelimited(buffer: Uint8Array, start: number, wireType: number): { value: Uint8Array; offset: number } {
  if (wireType !== 2) throw new Error(`Expected length-delimited wire type, got ${wireType}`);
  const lengthInfo = readVarint(buffer, start);
  const length = Number(lengthInfo.value);
  const offset = lengthInfo.offset;
  const end = offset + length;
  if (end > buffer.length) throw new Error('Unexpected end of buffer while reading bytes');
  return { value: buffer.slice(offset, end), offset: end };
}

function skipUnknownField(buffer: Uint8Array, start: number, wireType: number): number {
  if (wireType === 0) {
    return readVarint(buffer, start).offset;
  }
  if (wireType === 2) {
    return readLengthDelimited(buffer, start, wireType).offset;
  }
  throw new Error(`Unsupported protobuf wire type: ${wireType}`);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}
