import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  generateTotp,
  parseTotpConfig,
  secondsUntilNextCode,
} from "./totp.ts";

// RFC 6238 appendix B uses the ASCII seed "12345678901234567890".
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("decodeBase32", () => {
  it("decodes a seed to its bytes", () => {
    expect(decodeBase32("JBSWY3DPEHPK3PXP").toString("hex")).toBe("48656c6c6f21deadbeef");
  });

  it("tolerates the spacing seeds are usually written with", () => {
    expect(decodeBase32("jbsw y3dp-ehpk 3pxp")).toEqual(decodeBase32("JBSWY3DPEHPK3PXP"));
  });

  it("names an invalid character instead of guessing", () => {
    expect(() => decodeBase32("JBSW1YDP")).toThrow(/ungültiges Zeichen: 1/);
    expect(() => decodeBase32("   ")).toThrow(/leer/);
  });
});

describe("generateTotp", () => {
  const config = parseTotpConfig(RFC_SEED);

  it("matches the RFC 6238 reference vectors", () => {
    // The RFC lists eight digits; a six-digit token shows the last six.
    expect(generateTotp(config, 59_000)).toBe("287082");
    expect(generateTotp(config, 1_111_111_109_000)).toBe("081804");
    expect(generateTotp(config, 1_111_111_111_000)).toBe("050471");
    expect(generateTotp(config, 1_234_567_890_000)).toBe("005924");
    expect(generateTotp(config, 2_000_000_000_000)).toBe("279037");
    expect(generateTotp(config, 20_000_000_000_000)).toBe("353130");
  });

  it("holds the code steady inside a 30-second step and changes at the boundary", () => {
    expect(generateTotp(config, 30_000)).toBe(generateTotp(config, 59_999));
    expect(generateTotp(config, 60_000)).not.toBe(generateTotp(config, 59_999));
  });

  it("always pads to the configured length", () => {
    for (let step = 0; step < 200; step++) {
      expect(generateTotp(config, step * 30_000)).toMatch(/^\d{6}$/);
    }
  });
});

describe("parseTotpConfig", () => {
  it("reads a bare seed with the usual defaults", () => {
    expect(parseTotpConfig(RFC_SEED)).toMatchObject({
      digits: 6,
      period: 30,
      algorithm: "sha1",
    });
  });

  it("reads an otpauth URI including its parameters", () => {
    const config = parseTotpConfig(
      `otpauth://totp/TANSS:sj?secret=${RFC_SEED}&issuer=TANSS&digits=8&period=60&algorithm=SHA256`,
    );
    expect(config).toMatchObject({ digits: 8, period: 60, algorithm: "sha256" });
    expect(generateTotp(config, 0)).toMatch(/^\d{8}$/);
  });

  it("refuses counter-based tokens and unusable parameters", () => {
    expect(() => parseTotpConfig(`otpauth://hotp/TANSS:sj?secret=${RFC_SEED}`)).toThrow(
      /nicht hotp/,
    );
    expect(() => parseTotpConfig("otpauth://totp/TANSS:sj")).toThrow(/secret/);
    expect(() =>
      parseTotpConfig(`otpauth://totp/TANSS:sj?secret=${RFC_SEED}&digits=9`),
    ).toThrow(/digits/);
  });
});

describe("secondsUntilNextCode", () => {
  it("counts down inside the current step", () => {
    const config = parseTotpConfig(RFC_SEED);
    expect(secondsUntilNextCode(config, 0)).toBe(30);
    expect(secondsUntilNextCode(config, 25_000)).toBe(5);
    expect(secondsUntilNextCode(config, 30_000)).toBe(30);
  });
});
