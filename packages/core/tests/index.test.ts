import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index";

describe("@invfin/core", () => {
  it("should export VERSION constant", () => {
    expect(VERSION).toBe("0.0.1");
  });

  it("should have a valid string VERSION", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
