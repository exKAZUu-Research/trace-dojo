import type { Entity } from './entities';

export class Scope {
  readonly entities = new Map<string, Entity>();

  constructor(readonly parent: Scope | undefined) {}

  lookup(name: string): Entity | undefined {
    return this.entities.get(name) ?? this.parent?.lookup(name);
  }
}
