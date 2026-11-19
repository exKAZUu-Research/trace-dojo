import type { ConstantLocation, Expr } from './expr';
import type { LibraryTemplate } from './library/registry';
import type { Frame, LocalInfo } from './runtime';
import type { ClassInfo, FieldInfo, FunctionInfo, GlobalInfo, StaticFieldInfo, Type } from './types';
import type { Value } from './values';

export interface ConstantReference {
  value?: number | bigint;
  foldedValue?: number | bigint;
  constantLocation?: ConstantLocation;
}

/** What a name denotes. */
export type Entity =
  | {
      kind: 'local';
      local: LocalInfo;
      isReference: boolean;
      isConstexpr?: boolean;
      constant?: number | bigint;
      foldedValue?: number | bigint;
      constantReference?: ConstantReference;
      staticStorage?: GlobalInfo;
    }
  | { kind: 'global'; global: GlobalInfo; isReference: boolean; constant?: number | bigint }
  | { kind: 'functions'; functions: FunctionInfo[] }
  | { kind: 'field'; field: FieldInfo }
  | { kind: 'staticField'; field: StaticFieldInfo }
  /** A name both the program and `using namespace std;` declare, which clang++ cannot choose between. */
  | { kind: 'ambiguous'; name: string }
  | { kind: 'class'; cls: ClassInfo }
  | { kind: 'hiddenClass'; cls: ClassInfo }
  | { kind: 'type'; type: Type }
  | { kind: 'template'; template: LibraryTemplate }
  /** A library object or constant, such as `std::cout` or `INT_MAX`. */
  | { kind: 'value'; make: (row: number) => Expr }
  | { kind: 'namespace'; name: string }
  /** A library name the interpreter leaves out, such as `std::thread`. */
  | { kind: 'unsupported'; feature: string };

export class Scope {
  readonly names = new Map<string, Entity>();
  usesStd = false;
  /** The variables declared in this block whose destruction has an effect, by slot. */
  readonly destructibles = new Map<number, (frame: Frame, value: Value) => void>();
  /** The slots of the variables declared in this block, which go out of scope with it. */
  readonly slots: number[] = [];
  /** The slots of the block's static variables, whose storage outlives the block. */
  readonly statics: number[] = [];
  /** The variables declared in this block that a `return` may still return without copying (clang's return slots). */
  readonly returnSlots = new Set<LocalInfo>();
  /**
   * The variable the `return` statements compiled in this block return without copying; false when one of them
   * must copy, and undefined before any.
   */
  namedReturn: LocalInfo | false | undefined;

  constructor(readonly conflictingDeclarations?: ReadonlyMap<string, Entity>) {}
}

/** What the compiler knows about the function whose body it compiles. */
export class FunctionContext {
  readonly locals: LocalInfo[] = [];
  readonly scopes: Scope[] = [new Scope()];
  slotCount = 0;
  loopDepth = 0;
  switchDepth = 0;
  /** The locals that a `return` returns without copying, which the result shares (NRVO). */
  readonly namedReturns = new Set<LocalInfo>();

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
    if (!isParameter && type.kind !== 'reference') this.scope.returnSlots.add(local);
    return local;
  }

  /**
   * Notes a `return` statement, which returns `local` by name or else another value, choosing the variables whose
   * returns skip the copy as clang++ does at every optimization level (its `Scope::updateNRVOCandidate`): a
   * variable qualifies while no `return` in the scopes it is visible in returns something else.
   */
  noteReturn(local: LocalInfo | undefined): void {
    let canSkipCopy = false;
    for (const scope of this.scopes) {
      const hasSlot = local !== undefined && scope.returnSlots.has(local);
      scope.returnSlots.clear();
      if (hasSlot) {
        scope.returnSlots.add(local);
        canSkipCopy = true;
      }
    }
    this.scope.namedReturn = canSkipCopy ? local : false;
  }

  /** Ends a block scope, passing what its `return` statements return on to the enclosing one (`Scope::applyNRVO`). */
  popScope(): void {
    const scope = this.scopes.pop() as Scope;
    this.applyNamedReturn(scope);
    if (scope.namedReturn !== undefined) this.scope.namedReturn = scope.namedReturn;
  }

  /** Ends the outermost scope of a function's body. */
  endBody(): void {
    this.applyNamedReturn(this.scopes[0]);
  }

  private applyNamedReturn(scope: Scope): void {
    const local = scope.namedReturn;
    if (local && scope.slots.includes(local.slot)) this.namedReturns.add(local);
  }

  lookupLocal(name: string, accept?: (entity: Entity) => boolean): Entity | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const entity = this.scopes[index].names.get(name);
      if (entity && (!accept || accept(entity))) return entity;
    }
  }
}
