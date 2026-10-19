import { describe, expect, it } from "vitest";
import { rangeSelection } from "./selection.ts";

const visible = [10, 20, 30, 40, 50];

describe("rangeSelection", () => {
  it("takes everything between anchor and target, both included", () => {
    expect(rangeSelection([10], visible, 10, 40)).toEqual([10, 20, 30, 40]);
  });

  it("works upwards just as well", () => {
    expect(rangeSelection([40], visible, 40, 10)).toEqual([40, 10, 20, 30]);
  });

  it("adds to the selection instead of replacing it, and never twice", () => {
    expect(rangeSelection([50, 20], visible, 20, 40)).toEqual([50, 20, 30, 40]);
  });

  it("toggles the target alone when there is no anchor", () => {
    expect(rangeSelection([], visible, null, 30)).toEqual([30]);
    expect(rangeSelection([30], visible, null, 30)).toEqual([]);
  });

  it("toggles when the anchor is no longer visible, a filter having dropped it", () => {
    expect(rangeSelection([], visible, 99, 30)).toEqual([30]);
  });

  it("selects the single row when anchor and target are the same", () => {
    expect(rangeSelection([], visible, 30, 30)).toEqual([30]);
  });
});
