import type { Expr } from './expr';
import type { LibraryTemplate } from './library/registry';
import type { Frame, LocalInfo } from './runtime';
import type { ClassInfo, FieldInfo, FunctionInfo, GlobalInfo, StaticFieldInfo, Type } from './types';
import type { Value } from './values';

/** What a name denotes. */
export type Entity =
  | { kind: 'local'; local: LocalInfo; isReference: boolean; constant?: number | bigint }
  | { kind: 'global'; global: GlobalInfo; isReference: boolean; constant?: number | bigint }
  | { kind: 'functions'; functions: FunctionInfo[] }
  | { kind: 'field'; field: FieldInfo }
  | { kind: 'staticField'; field: StaticFieldInfo }
  /** A name both the program and `using namespace std;` declare, which clang++ cannot choose between. */
  | { kind: 'ambiguous'; name: string }
  | { kind: 'class'; cls: ClassInfo }
  | { kind: 'type'; type: Type }
  | { kind: 'template'; template: LibraryTemplate }
  /** A library object or constant, such as `std::cout` or `INT_MAX`. */
  | { kind: 'value'; make: (row: number) => Expr }
  | { kind: 'namespace'; name: string }
  /** A library name the interpreter leaves out, such as `std::thread`. */
  | { kind: 'unsupported'; feature: string };

export class Scope {
  readonly names = new Map<string, Entity>();
  /** The variables declared in this block whose destruction has an effect, in declaration order. */
  readonly destructibles: { slot: number; destroy: (frame: Frame, value: Value) => void }[] = [];
  /** The slots of the variables declared in this block, which go out of scope with it. */
  readonly slots: number[] = [];
  /** The slots of the block's static variables, whose storage outlives the block. */
  readonly statics: number[] = [];
}

/** What the compiler knows about the function whose body it compiles. */
export class FunctionContext {
  readonly locals: LocalInfo[] = [];
  readonly scopes: Scope[] = [new Scope()];
  slotCount = 0;
  loopDepth = 0;
  switchDepth = 0;
  /** The local each `return` returns by name, which the result may share instead of copying it. */
  namedReturn: LocalInfo | undefined | null = undefined;

  constructor(
    readonly fn: FunctionInfo | undefined,
    readonly cls: ClassInfo | undefined,
    readonly returnType: Type
  ) {}

  get scope(): Scope {
    return this.scopes.at(-1) as Scope;
  }

  /** Whether `this` is a pointer to const, as in a const member function. */
  get isConstMember(): boolean {
    return this.fn?.isConst === true;
  }

  get isStaticContext(): boolean {
    return !this.cls || this.fn?.isStatic === true;
  }

  declareLocal(name: string, type: Type, isParameter: boolean): LocalInfo {
    const local: LocalInfo = { name, slot: this.slotCount++, type, isParameter };
    this.locals.push(local);
    this.scope.slots.push(local.slot);
    return local;
  }

  lookupLocal(name: string): Entity | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const entity = this.scopes[index].names.get(name);
      if (entity) return entity;
    }
  }
}
