import RAPIER, { type RigidBody } from "@dimforge/rapier2d-deterministic-compat";
import { ENGINE, GRAVITY, MOVE_ANGULAR, MOVE_LINEAR, PUSH_SPEED, SIM_STEPS, TIMESTEP } from "./constants.js";
import type { Blueprint } from "./blueprint.js";
import { blueprintBodies } from "./geometry.js";
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
  /** Dynamic parts only: half-open step intervals [start, end) during which the part was moving. */
  moving: Record<string, [number, number][]>;
}

let ready: Promise<void> | null = null;

/** Loads the physics WASM once. Await before the first runSim. */
export function initPhysics(): Promise<void> {
  ready ??= RAPIER.init();
  return ready;
}

const MATERIAL = { density: 1, friction: 0.5, restitution: 0.1 };
const round = (n: number) => Math.round(n * 1e4) / 1e4;

export function runSim(bp: Blueprint, steps = SIM_STEPS): SimResult {
  const world = new RAPIER.World(GRAVITY);
  world.timestep = TIMESTEP;
  const queue = new RAPIER.EventQueue(true);
  try {
    const bodies = blueprintBodies(bp);
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

    const finale = bodies.find((b) => b.id === "finale")!;
    const pushed = rigid.get(bp.firstPush.ball)!;
    const speed = PUSH_SPEED[bp.firstPush.strength] * (bp.firstPush.direction === "right" ? 1 : -1);
    pushed.applyImpulse({ x: pushed.mass() * speed, y: 0 }, true);

    const dynamicIds = bodies.filter((b) => b.dynamic).map((b) => b.id);
    const movingFlags = new Map<string, boolean[]>(dynamicIds.map((id) => [id, []]));
    const minDist = new Map<string, number>(dynamicIds.map((id) => [id, Infinity]));
    const start = new Map(dynamicIds.map((id) => {
      const t = rigid.get(id)!.translation();
      return [id, { x: t.x, y: t.y }] as const;
    }));
    const raw: { step: number; a: string; b: string }[] = [];
    let finaleHit = null as SimResult["finaleHit"];
    const open = new Map<string, { contact: Contact; count: number }>();
    const contacts: Contact[] = [];

    for (let step = 0; step < steps; step++) {
      world.step(queue);
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
        movingFlags.get(id)!.push(Math.hypot(v.x, v.y) > MOVE_LINEAR || Math.abs(body.angvel()) > MOVE_ANGULAR);
        const t = body.translation();
        minDist.set(id, Math.min(minDist.get(id)!, Math.hypot(t.x - finale.x, t.y - finale.y)));
      }
    }

    const events: SimEvent[] = raw.map((e) => ({ ...e }));

    const parts: Record<string, PartTrack> = {};
    const moving: Record<string, [number, number][]> = {};
    for (const id of dynamicIds) {
      const t = rigid.get(id)!.translation();
      parts[id] = { start: start.get(id)!, end: { x: t.x, y: t.y }, moved: movingFlags.get(id)!.some(Boolean), minDistToFinale: minDist.get(id)! };
      moving[id] = intervals(movingFlags.get(id)!);
    }

    const hash = fnv1a64(JSON.stringify({
      events: raw,
      finaleHit,
      end: dynamicIds.map((id) => [id, round(parts[id]!.end.x), round(parts[id]!.end.y)]),
    }));
    return { events, parts, finaleHit, steps, hash, engine: ENGINE, contacts, moving };
  } finally {
    queue.free();
    world.free();
  }
}

function intervals(flags: boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  flags.forEach((m, i) => {
    if (m && start < 0) start = i;
    if (!m && start >= 0) { out.push([start, i]); start = -1; }
  });
  if (start >= 0) out.push([start, flags.length]);
  return out;
}
