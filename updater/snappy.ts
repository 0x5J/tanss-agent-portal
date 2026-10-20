// Snappy raw block decoder. GitHub serves Sigstore attestation bundles in this
// format (not the framing format). Node built-ins only, no npm dependencies.

const CORRUPT = "Snappy-Daten beschädigt";

export function snappyUncompress(input: Uint8Array, maxLength: number): Buffer {
  let pos = 0;

  // Preamble: uncompressed length as little-endian varint (at most 32 bits).
  let declared = 0;
  for (let i = 0; ; i++) {
    if (i >= 5 || pos >= input.length) throw new Error(CORRUPT);
    const byte = input[pos++];
    declared += (byte & 0x7f) * 2 ** (7 * i);
    if ((byte & 0x80) === 0) break;
  }
  if (declared > maxLength) throw new Error("Snappy-Daten zu groß");

  const out = Buffer.alloc(declared);
  let outPos = 0;

  const readLE = (bytes: number): number => {
    if (pos + bytes > input.length) throw new Error(CORRUPT);
    let value = 0;
    for (let i = 0; i < bytes; i++) value += input[pos++] * 2 ** (8 * i);
    return value;
  };

  while (pos < input.length) {
    const tag = input[pos++];
    const type = tag & 0x03;

    if (type === 0) {
      // Literal: lengths 1-60 live in the tag, 61-64 take 1-4 extra length bytes.
      let length = tag >> 2;
      if (length >= 60) length = readLE(length - 59);
      length += 1;
      if (pos + length > input.length || outPos + length > declared) throw new Error(CORRUPT);
      out.set(input.subarray(pos, pos + length), outPos);
      pos += length;
      outPos += length;
      continue;
    }

    let length: number;
    let offset: number;
    if (type === 1) {
      length = 4 + ((tag >> 2) & 0x07);
      offset = (tag >> 5) * 256 + readLE(1);
    } else if (type === 2) {
      length = 1 + (tag >> 2);
      offset = readLE(2);
    } else {
      length = 1 + (tag >> 2);
      offset = readLE(4);
    }
    if (offset === 0 || offset > outPos || outPos + length > declared) throw new Error(CORRUPT);
    // Byte by byte: the source may overlap the bytes being written.
    for (let i = 0; i < length; i++, outPos++) out[outPos] = out[outPos - offset];
  }

  if (outPos !== declared) throw new Error(CORRUPT);
  return out;
}
