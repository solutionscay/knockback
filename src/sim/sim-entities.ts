import type RAPIER from "@dimforge/rapier2d-deterministic-compat";
import type { Entity } from "./sim-types";

/** Keeps body removal and collider lookup in sync, with one ID sequence for bodies and rockets. */
export class EntityStore {
  readonly entities = new Map<number, Entity>();
  private readonly byCollider = new Map<number, Entity>();
  private nextId = 1;

  constructor(private readonly world: RAPIER.World) {}

  allocateId() {
    return this.nextId++;
  }

  register(e: Entity) {
    this.entities.set(e.id, e);
    for (const c of e.colliders ?? [e.collider]) this.byCollider.set(c.handle, e);
  }

  entityOf(c: RAPIER.Collider): Entity | undefined {
    return this.byCollider.get(c.handle);
  }

  remove(e: Entity) {
    if (e.dead) return;
    e.dead = true;
    for (const c of e.colliders ?? [e.collider]) this.byCollider.delete(c.handle);
    this.entities.delete(e.id);
    if (e.joint) {
      this.world.removeImpulseJoint(e.joint, false);
      e.joint = null;
    }
    this.world.removeRigidBody(e.body);
  }
}
