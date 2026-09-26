/** Board: 16 × 10 cells, row 0 at the top. One cell is one metre. */
export const GRID_COLS = 16;
export const GRID_ROWS = 10;

export const MAX_PARTS = 25;
/** A success needs at least this many parts in the chain, pushed ball included. */
export const MIN_CHAIN_PARTS = 5;

export const TIMESTEP = 1 / 60;
/** 20 simulated seconds. */
export const SIM_STEPS = 1200;
export const GRAVITY = { x: 0, y: -9.81 };

/** Above these speeds a part counts as moving. */
export const MOVE_LINEAR = 0.2; // m/s
export const MOVE_ANGULAR = 0.5; // rad/s
/** Steps after a hit in which the hit part must start moving to join the chain. */
export const MOVE_WINDOW = 30;

/** Speed given to the first ball, in m/s. */
export const PUSH_SPEED = { soft: 2, medium: 4, hard: 6 } as const;

/** Parts may touch; they may not start interpenetrating by more than this (metres). */
export const OVERLAP_TOLERANCE = 0.02;

/** Stored with every run so replays can pin the same engine. Must match package.json. */
export const ENGINE = "@dimforge/rapier2d-deterministic-compat@0.21.0";
