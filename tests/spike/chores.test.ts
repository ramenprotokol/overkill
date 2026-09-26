import { describe, expect, it } from "vitest";
import { CHORES } from "../../src/spike/chores.js";

describe("CHORES", () => {
  it("holds 20 distinct chores", () => {
    expect(CHORES).toHaveLength(20);
    expect(new Set(CHORES).size).toBe(20);
  });

  it("starts every round of five with one chore per finale kind", () => {
    expect(CHORES.slice(0, 5)).toEqual(["turn off the light", "feed the cat", "ring the dinner bell", "close the door", "water the plant"]);
    expect(CHORES.slice(15)).toEqual(["mute the TV", "give the goldfish a snack", "call everyone to the meeting", "let the dog out", "water the tomatoes"]);
  });
});
