import type { Blueprint } from "../../src/core/blueprint.js";

/** Ball rolls into five dominoes; the last one hits the switch. Verified 6-part chain. */
export const goldenDominoes: Blueprint = {
  note: "Five dominoes to press one switch.",
  finale: { kind: "switch", label: "turn off the light", col: 8, row: 9 },
  firstPush: { ball: "b1", direction: "right", strength: "medium" },
  parts: [
    { id: "b1", kind: "ball", col: 0, row: 9, size: "m" },
    { id: "d1", kind: "domino", col: 3, row: 9 },
    { id: "d2", kind: "domino", col: 4, row: 9 },
    { id: "d3", kind: "domino", col: 5, row: 9 },
    { id: "d4", kind: "domino", col: 6, row: 9 },
    { id: "d5", kind: "domino", col: 7, row: 9 },
  ],
};

/** Works, but only a 3-part chain: not overkill enough. */
export const shortChain: Blueprint = {
  note: "Two dominoes. Minimalism.",
  finale: { kind: "switch", label: "turn off the light", col: 8, row: 9 },
  firstPush: { ball: "b1", direction: "right", strength: "medium" },
  parts: [
    { id: "b1", kind: "ball", col: 3, row: 9, size: "m" },
    { id: "d1", kind: "domino", col: 6, row: 9 },
    { id: "d2", kind: "domino", col: 7, row: 9 },
  ],
};

/** The lazy cheat: the ball rolls straight into the switch. */
export const lazyRoll: Blueprint = {
  note: "Why build a machine when you have a ball.",
  finale: { kind: "switch", label: "turn off the light", col: 8, row: 9 },
  firstPush: { ball: "b1", direction: "right", strength: "medium" },
  parts: [{ id: "b1", kind: "ball", col: 6, row: 9, size: "m" }],
};

/** Pushed the wrong way: the ball rolls off the board and nothing else moves. */
export const dudMachine: Blueprint = {
  ...goldenDominoes,
  note: "Pushed it the wrong way.",
  firstPush: { ball: "b1", direction: "left", strength: "soft" },
};

/** A ball dropped onto a level seesaw tips it. */
export const seesawDrop: Blueprint = {
  note: "Gravity, meet seesaw.",
  finale: { kind: "bell", label: "ring the bell", col: 14, row: 9 },
  firstPush: { ball: "b1", direction: "right", strength: "soft" },
  parts: [
    { id: "b1", kind: "ball", col: 5, row: 3, size: "m" },
    { id: "s1", kind: "seesaw", col: 5, row: 7, length: 4 },
  ],
};
