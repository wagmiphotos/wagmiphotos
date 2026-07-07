import { describe, it, expect } from "vitest";
import { similarityFloor } from "../src/floor";

describe("similarityFloor", () => {
  it("maps strict->max, loose->min, clamps", () => {
    expect(similarityFloor(0)).toBeCloseTo(0.87);
    expect(similarityFloor(1)).toBeCloseTo(0.75);
    expect(similarityFloor(-5)).toBeCloseTo(0.87);
    expect(similarityFloor(9)).toBeCloseTo(0.75);
    expect(similarityFloor(0.5)).toBeGreaterThan(0.75);
    expect(similarityFloor(0.5)).toBeLessThan(0.87);
  });
  it("honors custom bounds", () => {
    expect(similarityFloor(0, 0.9, 0.5)).toBeCloseTo(0.9);
  });
});
