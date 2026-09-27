import RAPIER, { type EventQueue, type RigidBody, type World } from "@dimforge/rapier2d-deterministic-compat";
import { DEVIATION_ONSET, DEVIATION_VISIBLE, ENGINE, GRAVITY, MOVE_SPEED, PUSH_SPEED, SETTLE_STEPS, SIM_STEPS, TIMESTEP } from "./constants.js";
import type { Blueprint } from "./blueprint.js";
import { blueprintBodies, bodyRadius, type Body } from "./geometry.js";
import { fnv1a64 } from "./hash.js";

export interface SimEvent {
  step: number;
  /** Alphabetically first of the pair. */
  a: string;
  b: string;
}

export interface PartTrack {
  start: { x: number; y: number };
  end: { x: number; y: number };
  moved: boolean;
  minDistToFinale: number;
}

/** Two things touching from step `from` until step `to` (`to` = the run's step count if still touching at the end). a < b; the floor is excluded. */
export interface Contact {
  a: string;
  b: string;
  from: number;
  to: number;
}

/** How far the first push moved a part off the path it takes in the push-free twin run. */
export interface Deviation {
  /** First step at which some point of the part is at least DEVIATION_ONSET from its push-free pose, or null. */
  onset: number | null;
  /** First step at which that distance reaches DEVIATION_VISIBLE, or null. */
  visible: number | null;
}

/** Poses of the dynamic parts after every step, for drawing a run. */
export interface Frames {
  /** Dynamic part ids, in the order their poses appear in each frame. */
  ids: string[];
  /** Step number of frame 1; frame 0 is the layout before the first step. Frame k shows the world after step `first + k - 1`. */
  first: number;
  count: number;
  /** x, y, angle for each id, frame after frame: data[(frame * ids.length + i) * 3 + k]. */
  data: Float32Array;
}

export interface SimResult {
  /** Contacts that started between two things (the floor excluded), in step order. */
  events: SimEvent[];
  /** Dynamic parts only. */
  parts: Record<string, PartTrack>;
  finaleHit: { step: number; by: string } | null;
  steps: number;
  /** Fingerprint of what happened, for replay verification. */
  hash: string;
  engine: string;
  /** Every contact interval, in the order the contacts began. */
  contacts: Contact[];
  /** Dynamic parts only: half-open step intervals [start, end) during which the part was moving.
   * The push is step 0, so settling steps (before the push) are negative. */
  moving: Record<string, [number, number][]>;
  /** Dynamic parts only, for a pushed run: how the push changed each part's path. Empty for a push-free run. */
  deviation: Record<string, Deviation>;
  /** Only when SimOptions.record is set. */
  frames?: Frames;
}

let ready: Promise<void> | null = null;

/** Loads the physics WASM once. Await before the first runSim. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

const MATERIAL = { density: 1, friction: 0.5, restitution: 0.1 };
const round = (n: number) => Math.round(n * 1e4) / 1e4;

export interface SimOptions {
  /** Apply the first push at step 0 (default true). Without it the machine runs the same settle and steps untouched. */
  push?: boolean;
  /** Keep every dynamic part's pose after every step (default false). */
  record?: boolean;
}

interface BuiltWorld {
  world: World;
  queue: EventQueue;
  rigid: Map<string, RigidBody>;
  nameOf: Map<number, string>;
}

/** Builds a world from the bodies in canonical order, so two builds of one blueprint step identically. */
function buildWorld(bodies: Body[]): BuiltWorld {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = TIMESTEP;
  const queue = new RAPIER.EventQueue(true);
  const nameOf = new Map<number, string>();
  const rigid = new Map<string, RigidBody>();
  for (const b of bodies) {
    const desc = (b.dynamic ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
      .setTranslation(b.x, b.y)
      .setRotation(b.angle)
      .setCcdEnabled(b.dynamic);
    const body = world.createRigidBody(desc);
    for (const s of b.shapes) {
      const cd = (s.type === "circle" ? RAPIER.ColliderDesc.ball(s.r) : RAPIER.ColliderDesc.cuboid(s.hx, s.hy))
        .setTranslation(s.x, s.y)
        .setDensity(MATERIAL.density)
        .setFriction(MATERIAL.friction)
        .setRestitution(MATERIAL.restitution)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      nameOf.set(world.createCollider(cd, body).handle, b.id);
    }
    if (b.pivot) {
      const anchor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.pivot.x, b.pivot.y));
      const joint = RAPIER.JointData.revolute({ x: 0, y: 0 }, { x: b.pivot.x - b.x, y: b.pivot.y - b.y });
      world.createImpulseJoint(joint, anchor, body, true);
    }
    rigid.set(b.id, body);
  }
  return { world, queue, rigid, nameOf };
}

/** Angle difference folded into (-π, π]. */
function angleGap(a: number, b: number): number {
  const d = (a - b) % (2 * Math.PI);
  return Math.abs(d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d);
}

/**
 * Runs the machine. A pushed run also steps a push-free twin of the same machine in lockstep; the engine is
 * deterministic, so the two stay identical until the push, and any later difference in a part's pose was caused by it.
 */
export function runSim(bp: Blueprint, steps = SIM_STEPS, options: SimOptions = {}): SimResult {
  const push = options.push ?? true;
  const bodies = blueprintBodies(bp);
  const main = buildWorld(bodies);
  const twin = push ? buildWorld(bodies) : null;
  try {
    const { world, queue, rigid, nameOf } = main;
    const finale = bodies.find((b) => b.id === "finale")!;
    const pushed = rigid.get(bp.firstPush.ball)!;
    const speed = PUSH_SPEED[bp.firstPush.strength] * (bp.firstPush.direction === "right" ? 1 : -1);

    const dynamicIds = bodies.filter((b) => b.dynamic).map((b) => b.id);
    const radiusOf = new Map(bodies.filter((b) => b.dynamic).map((b) => [b.id, bodyRadius(b)]));
    const movingFlags = new Map<string, boolean[]>(dynamicIds.map((id) => [id, []]));
    const minDist = new Map<string, number>(dynamicIds.map((id) => [id, Infinity]));
    const start = new Map<string, { x: number; y: number }>();
    const raw: { step: number; a: string; b: string }[] = [];
    let finaleHit = null as SimResult["finaleHit"];
    const open = new Map<string, { contact: Contact; count: number }>();
    const contacts: Contact[] = [];
    const deviation: Record<string, Deviation> = {};
    if (twin) for (const id of dynamicIds) deviation[id] = { onset: null, visible: null };

    const total = SETTLE_STEPS + steps;
    const frames: Frames | undefined = options.record
      ? { ids: dynamicIds, first: -SETTLE_STEPS, count: total + 1, data: new Float32Array((total + 1) * dynamicIds.length * 3) }
      : undefined;
    const recordFrame = (frame: number) => {
      if (!frames) return;
      dynamicIds.forEach((id, i) => {
        const body = rigid.get(id)!;
        const t = body.translation();
        const o = (frame * dynamicIds.length + i) * 3;
        frames.data[o] = t.x;
        frames.data[o + 1] = t.y;
        frames.data[o + 2] = body.rotation();
      });
    };
    recordFrame(0);

    // The machine settles under gravity for SETTLE_STEPS before the first push, so a ball that
    // spawns above whatever it rests on has already landed by the time it's judged to be "moving".
    for (let i = 0; i < total; i++) {
      const step = i - SETTLE_STEPS;
      if (step === 0) {
        for (const id of dynamicIds) {
          const t = rigid.get(id)!.translation();
          start.set(id, { x: t.x, y: t.y });
        }
        if (push) pushed.applyImpulse({ x: pushed.mass() * speed, y: 0 }, true);
      }
      world.step(queue);
      if (twin) {
        twin.world.step(twin.queue);
        twin.queue.drainCollisionEvents(() => {});
      }
      queue.drainCollisionEvents((h1, h2, started) => {
        const n1 = nameOf.get(h1);
        const n2 = nameOf.get(h2);
        if (n1 === undefined || n2 === undefined || n1 === n2 || n1 === "floor" || n2 === "floor") return;
        const [a, b] = n1 < n2 ? [n1, n2] : [n2, n1];
        const key = `${a}|${b}`;
        if (started) {
          raw.push({ step, a, b });
          if (!finaleHit && (a === "finale" || b === "finale")) finaleHit = { step, by: a === "finale" ? b : a };
          const o = open.get(key);
          if (o) o.count++;
          else {
            const contact: Contact = { a, b, from: step, to: steps };
            contacts.push(contact);
            open.set(key, { contact, count: 1 });
          }
        } else {
          const o = open.get(key);
          if (!o) return;
          o.count--;
          if (o.count === 0) {
            o.contact.to = step;
            open.delete(key);
          }
        }
      });
      for (const id of dynamicIds) {
        const body = rigid.get(id)!;
        const v = body.linvel();
        const radius = radiusOf.get(id)!;
        movingFlags.get(id)!.push(Math.hypot(v.x, v.y) + Math.abs(body.angvel()) * radius > MOVE_SPEED);
        if (step >= 0) {
          const t = body.translation();
          minDist.set(id, Math.min(minDist.get(id)!, Math.hypot(t.x - finale.x, t.y - finale.y)));
          const d = deviation[id];
          if (twin && d && d.visible === null) {
            const other = twin.rigid.get(id)!;
            const u = other.translation();
            // Bounds how far any point of the part is from where the push-free twin has it.
            const gap = Math.hypot(t.x - u.x, t.y - u.y) + angleGap(body.rotation(), other.rotation()) * radius;
            if (d.onset === null && gap >= DEVIATION_ONSET) d.onset = step;
            if (gap >= DEVIATION_VISIBLE) d.visible = step;
          }
        }
      }
      recordFrame(i + 1);
    }

    const events: SimEvent[] = raw.map((e) => ({ ...e }));

    const parts: Record<string, PartTrack> = {};
    const moving: Record<string, [number, number][]> = {};
    for (const id of dynamicIds) {
      const t = rigid.get(id)!.translation();
      const flags = movingFlags.get(id)!;
      parts[id] = {
        start: start.get(id)!,
        end: { x: t.x, y: t.y },
        moved: flags.slice(SETTLE_STEPS).some(Boolean),
        minDistToFinale: minDist.get(id)!,
      };
      moving[id] = intervals(flags, -SETTLE_STEPS);
    }

    const hash = fnv1a64(JSON.stringify({
      events: raw,
      finaleHit,
      contacts,
      moving,
      deviation: dynamicIds.filter((id) => deviation[id]).map((id) => [id, deviation[id]!.onset, deviation[id]!.visible]),
      end: dynamicIds.map((id) => [id, round(parts[id]!.end.x), round(parts[id]!.end.y)]),
    }));
    return { events, parts, finaleHit, steps, hash, engine: ENGINE, contacts, moving, deviation, ...(frames ? { frames } : {}) };
  } finally {
    for (const w of twin ? [main, twin] : [main]) {
      w.queue.free();
      w.world.free();
    }
  }
}

function intervals(flags: boolean[], offset: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((m, i) => {
    if (m && start < 0) start = i;
    if (!m && start >= 0) { out.push([start + offset, i + offset]); start = -1; }
  });
  if (start >= 0) out.push([start + offset, flags.length + offset]);
  return out;
}
