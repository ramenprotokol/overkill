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

/** A part counts as moving when its fastest point moves faster than this (m/s). */
export const MOVE_SPEED = 0.2;
/** The machine settles under gravity for this many steps (1 second) before the first push. */
export const SETTLE_STEPS = 60;
/**
 * Chain attribution compares every run with a push-free twin run stepped in lockstep. A part has left its push-free
 * path once some point of it is this far (metres) from where the twin has it: far above float noise (about 1e-6 m
 * on this board), small enough that a touch registers within a step or two.
 */
export const DEVIATION_ONSET = 1e-4;
/** A part only counts toward the chain if the push moved some point of it at least this far (metres) off its push-free path. */
export const DEVIATION_VISIBLE = 0.05;
/**
 * Timing slack, in steps, when matching a part leaving its push-free path to a touch: contact events can be reported a
 * step or two away from the impulse that changed the part's path, and a load can register a step before its carrier.
 */
export const JOIN_SLACK = 2;

/** Speed given to the first ball, in m/s. */
export const PUSH_SPEED = { soft: 2, medium: 4, hard: 6 } as const;

/** Parts may touch; they may not start interpenetrating by more than this (metres). */
export const OVERLAP_TOLERANCE = 0.02;

/** Stored with every run so replays can pin the same engine. Must match package.json. */
export const ENGINE = "@dimforge/rapier2d-deterministic-compat@0.21.0";
