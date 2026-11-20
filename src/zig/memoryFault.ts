import type { Slots, Value } from './values';

export class MemoryFault extends Error {
  constructor() {
    super('Segmentation fault');
    this.name = 'MemoryFault';
  }
}

const inaccessible: Value[] = [];
Object.freeze(inaccessible);

export const UNDEFINED_MEMORY: Slots = Object.freeze({
  slots: new Proxy(inaccessible, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) throw new MemoryFault();
      return Reflect.get(target, key, receiver);
    },
    set: () => {
      throw new MemoryFault();
    },
    defineProperty: () => {
      throw new MemoryFault();
    },
    deleteProperty: () => {
      throw new MemoryFault();
    },
  }),
});
