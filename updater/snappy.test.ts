import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snappyUncompress } from "./snappy.ts";

const sn = new URL("./fixtures/gh-cli-provenance.json.sn", import.meta.url);
const json = new URL("./fixtures/gh-cli-provenance.json", import.meta.url);

const HELLO = Uint8Array.from([0x05, 0x10, ...Buffer.from("hello")]);

describe("snappyUncompress", () => {
  it("decodes literals", () => {
    expect(snappyUncompress(HELLO, 100).toString()).toBe("hello");
  });

  it("decodes an overlapping copy", () => {
    const input = Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x02]);
    expect(snappyUncompress(input, 100).toString()).toBe("abababab");
  });

  it("decodes the real attestation bundle", () => {
    const out = snappyUncompress(readFileSync(sn), 1_000_000);
    expect(JSON.parse(out.toString())).toEqual(JSON.parse(readFileSync(json, "utf8")));
  });

  it("rejects a declared length over the limit", () => {
    expect(() => snappyUncompress(HELLO, 4)).toThrow(/zu groß/);
  });

  it("rejects offset 0", () => {
    const input = Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x00]);
    expect(() => snappyUncompress(input, 100)).toThrow();
  });

  it("rejects an offset before the start", () => {
    const input = Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x05]);
    expect(() => snappyUncompress(input, 100)).toThrow();
  });

  it("rejects truncated input", () => {
    expect(() => snappyUncompress(Uint8Array.from([0x05, 0x10, 0x68, 0x65]), 100)).toThrow();
  });

  it("rejects output shorter than declared", () => {
    expect(() => snappyUncompress(Uint8Array.from([0x06, 0x10, ...Buffer.from("hello")]), 100)).toThrow();
  });

  it("rejects an empty input", () => {
    expect(() => snappyUncompress(new Uint8Array(), 100)).toThrow();
  });
});
