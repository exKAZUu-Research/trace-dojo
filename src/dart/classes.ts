import type { ClassDeclaration, ClassKind, ClassModifiers } from './ast';
import type { Compiled } from './compilerBase';
import type { Runtime } from './runtime';
import {
  asInstanceOf,
  coreTypes,
  type DartType,
  DYNAMIC,
  type FunctionType,
  type InterfaceType,
  interfaceType,
  isSubtype,
  mentionsCovariantly,
  sameType,
  substitute,
  type TypeParam,
  typeParamType,
} from './types';
import type { Arguments, Callable, DartObject, Value } from './values';

export function scopedMemberName(name: string, library: string): string {
  return name.startsWith('_') ? `${library}\0${name}` : name;
}

export function sourceMemberName(name: string): string {
  return name.slice(name.indexOf('\0') + 1);
}

/** A member as the type checker sees it, and as the runtime runs it. */
export type Member = MethodMember | GetterMember | SetterMember | FieldMember;

interface MemberBase {
  name: string;
  owner: ClassInfo;
  isStatic: boolean;
  isAbstract: boolean;
  /** The row of the declaration, for messages; undefined for library members. */
  row: number | undefined;
  forwarding?: { bind: ForwardedArgumentBinder | undefined; positionalNames: readonly string[] };
}

export type ForwardedArgumentBinder = (
  runtime: Runtime,
  receiver: Value,
  args: Arguments,
  typeArgs: readonly DartType[]
) => Arguments;

export interface MethodMember extends MemberBase {
  kind: 'method';
  type: FunctionType;
  impl: Callable | undefined;
  isOperator: boolean;
  /** For a library method a native implements, its positional parameters' names, which a dynamic call's checks name. */
  nativeParameterNames?: readonly string[];
  covariantPositional?: ReadonlySet<number>;
  covariantNamed?: ReadonlySet<string>;
  combinedFrom?: MethodMember;
}

export interface CovariantContract {
  obligation: MethodMember;
  positions: ReadonlySet<number>;
}

export interface GetterMember extends MemberBase {
  kind: 'getter';
  type: DartType;
  impl: Callable | undefined;
}

export interface SetterMember extends MemberBase {
  kind: 'setter';
  /** The type of the value the setter takes. */
  type: DartType;
  impl: Callable | undefined;
  isCovariant?: boolean;
}

export interface FieldMember extends MemberBase {
  kind: 'field';
  type: DartType;
  isFinal: boolean;
  isLate: boolean;
  isConst: boolean;
  isCovariant: boolean;
  hasInitializer: boolean;
  /** The index of an instance field among the fields of its object, or of a static field among the globals. */
  slot: number;
  /** A const static field's value, known while compiling. */
  constant?: Value;
  /** Fields have no code of their own; the runtime reads and writes their slots. */
  impl?: undefined;
  /** Marks the static fields that hold an enum's values. */
  isEnumValue?: boolean;
}

export interface ConstructorInfo {
  name: string;
  owner: ClassInfo;
  /** The parameters as a function type whose result is the class's own type. */
  type: FunctionType;
  kind: 'generative' | 'factory' | 'redirectingFactory';
  isConst: boolean;
  row: number | undefined;
  defaults?: {
    positional: (Compiled | undefined)[];
    named: Map<string, Compiled | undefined>;
  };
  /** Creates (for a generative constructor, initializes) an instance. */
  impl: ConstructorImpl | undefined;
}

/**
 * Runs a constructor: a generative one initializes `instance`, which the caller allocated, while a factory returns
 * the object it makes.
 */
export type ConstructorImpl = (
  runtime: Runtime,
  instance: DartObject | undefined,
  args: Arguments,
  typeArgs: readonly DartType[],
  callRow: number | undefined
) => Value;

/** A class, mixin, enum, or extension type, from the program or from the libraries the interpreter defines. */
export class ClassInfo {
  readonly inheritedCovariance = new Map<MethodMember, CovariantContract>();
  readonly typeParams: TypeParam[] = [];
  superclass: InterfaceType | undefined;
  interfaces: InterfaceType[] = [];
  mixins: InterfaceType[] = [];
  /** The `on` types of a mixin, which are its superclass constraints. */
  onTypes: InterfaceType[] = [];
  readonly members = new Map<string, Member>();
  readonly setters = new Map<string, Member>();
  readonly staticMembers = new Map<string, Member>();
  readonly staticSetters = new Map<string, Member>();
  readonly constructors = new Map<string, ConstructorInfo>();
  /** The instance fields declared in this class, in declaration order. */
  readonly fields: FieldMember[] = [];
  /** The number of instance fields of an object of this class, including inherited ones. */
  fieldCount = 0;
  modifiers: ClassModifiers = { isAbstract: false, isSealed: false, isBase: false, isFinal: false, isInterface: false };
  /** The name the VM's class of these objects has, where the interpreter's class differs (`_SetIterator`). */
  vmName: string | undefined;
  /** The application of a mixin to a superclass, as `A with M` creates, whose members are copies of the mixin's. */
  mixinOf: ClassInfo | undefined;
  mixinMembersApplied = false;
  /** The type an extension type represents. */
  representationType: DartType | undefined;
  representationName: string | undefined;
  enumValues: Value[] | undefined;
  declaration: ClassDeclaration | undefined;
  /** The classes from the same library that a sealed class's subtypes must come from. */
  readonly subclasses: ClassInfo[] = [];
  private supertypePaths = new WeakMap<ClassInfo, InterfaceType | undefined>();
  private readonly implementations = new Map<string, Member | undefined>();
  private readonly setterImplementations = new Map<string, Member | undefined>();
  private readonly combinedMethods = new WeakMap<MethodMember, MethodMember>();
  private cachedDepth: number | undefined;
  /** Natives attach their state to instances of some library classes. */
  isNativeBacked = false;

  constructor(
    readonly name: string,
    readonly kind: ClassKind,
    /** `dart:core` and the like for library classes, empty for the program's own. */
    readonly library: string
  ) {}

  get isLibrary(): boolean {
    return this.library !== '';
  }

  get thisType(): InterfaceType {
    return interfaceType(
      this,
      this.typeParams.map((param) => typeParamType(param))
    );
  }

  get isAbstract(): boolean {
    return this.modifiers.isAbstract || this.modifiers.isSealed || this.kind === 'mixin';
  }

  /** The superclass, mixins, `on` types, and interfaces, in terms of this class's type parameters. */
  get directSupertypes(): InterfaceType[] {
    const result: InterfaceType[] = [];
    if (this.superclass) result.push(this.superclass);
    result.push(...this.onTypes, ...this.mixins, ...this.interfaces);
    return result;
  }

  /** The length of the longest path to `Object`, which the standard upper bound compares. */
  get depth(): number {
    if (this.cachedDepth === undefined) {
      this.cachedDepth = 0;
      const supertypes = this.directSupertypes;
      this.cachedDepth = supertypes.length === 0 ? 0 : Math.max(...supertypes.map((type) => type.cls.depth)) + 1;
    }
    return this.cachedDepth;
  }

  /** The supertype of this class's own type that is an instance of `target`, in terms of this class's parameters. */
  supertypePath(target: ClassInfo): InterfaceType | undefined {
    if (target === this) return this.thisType;
    if (this.supertypePaths.has(target)) return this.supertypePaths.get(target);
    this.supertypePaths.set(target, undefined);
    let found: InterfaceType | undefined;
    for (const supertype of this.directSupertypes) {
      const path = supertype.cls.supertypePath(target);
      if (!path) continue;
      const map = new Map(supertype.cls.typeParams.map((param, index) => [param, supertype.args[index] ?? DYNAMIC]));
      found = substitute(path, map) as InterfaceType;
      break;
    }
    this.supertypePaths.set(target, found);
    return found;
  }

  isSubclassOf(target: ClassInfo): boolean {
    return this.supertypePath(target) !== undefined;
  }

  conflictingSupertype(): { first: InterfaceType; second: InterfaceType } | undefined {
    const encountered = new Map<ClassInfo, InterfaceType>();
    const pending = [this.thisType];
    for (const type of pending) {
      const first = encountered.get(type.cls);
      if (first) {
        if (!(isSubtype(first, type) && isSubtype(type, first))) return { first, second: type };
        continue;
      }
      encountered.set(type.cls, type);
      const env = new Map(type.cls.typeParams.map((param, index) => [param, type.args[index] ?? DYNAMIC]));
      for (const parent of type.cls.directSupertypes) pending.push(substitute(parent, env) as InterfaceType);
    }
    return undefined;
  }

  /** The concrete member that runs for an instance of this class, searching the superclass chain. */
  implementation(name: string): Member | undefined {
    if (this.implementations.has(name)) return this.implementations.get(name);
    let found: Member | undefined;
    for (const cls of this.superclassChain()) {
      const member = cls.ownInstanceMember(name, false);
      if (member && !member.isAbstract) {
        found = member;
        break;
      }
    }
    this.implementations.set(name, found);
    return found;
  }

  setterImplementation(name: string): Member | undefined {
    if (this.setterImplementations.has(name)) return this.setterImplementations.get(name);
    let found: Member | undefined;
    for (const cls of this.superclassChain()) {
      const member = cls.ownInstanceMember(name, true);
      if (member && !member.isAbstract) {
        found = member;
        break;
      }
    }
    this.setterImplementations.set(name, found);
    return found;
  }

  forwardingDeclaration(name: string, setter: boolean): Member | undefined {
    let forwarded: Member | undefined;
    for (const cls of [...this.superclassChain()].toReversed()) {
      if (cls.isAbstract) continue;
      const handler = cls.implementation('noSuchMethod');
      if (handler?.kind !== 'method' || handler.owner === coreTypes.object) continue;
      const member = cls.interfaceMember(name, setter);
      if (!member || member.isStatic || member === forwarded) continue;
      const type = cls.thisType;
      if (!forwarded || !sameForwardingSignature(type, forwarded, member)) forwarded = member;
    }
    return forwarded;
  }

  /** This class and its superclasses, nearest first. */
  *superclassChain(): Iterable<ClassInfo> {
    yield this;
    for (let cls = this.superclass?.cls; cls; cls = cls.superclass?.cls) yield cls;
  }

  covarianceFor(method: MethodMember): CovariantContract | undefined {
    let obligation: MethodMember | undefined;
    const positions = new Set<number>();
    for (const cls of this.superclassChain()) {
      const contract = cls.inheritedCovariance.get(method);
      if (!contract) continue;
      obligation = contract.obligation;
      for (const index of contract.positions) positions.add(index);
    }
    return obligation && { obligation, positions };
  }

  /** The member a class's interface has, declared in it or inherited from a supertype, before substitution. */
  interfaceMember(name: string, setter = false): Member | undefined {
    return this.findInterfaceMember(name, setter, new Map());
  }

  private findInterfaceMember(
    name: string,
    setter: boolean,
    visited: Map<ClassInfo, Member | undefined>
  ): Member | undefined {
    if (visited.has(this)) return visited.get(this);
    const own = this.ownInstanceMember(name, setter);
    if (own) return own;
    visited.set(this, undefined);
    const candidates = new Set<Member>();
    for (const supertype of this.directSupertypes) {
      const found = supertype.cls.findInterfaceMember(name, setter, visited);
      if (found) candidates.add(found);
    }
    const resolved = this.combineInterfaceMembers([...candidates], setter);
    visited.set(this, resolved);
    return resolved;
  }

  private combineInterfaceMembers(candidates: Member[], setter: boolean): Member | undefined {
    if (candidates.length <= 1) return candidates[0];
    const context = this.thisType;
    const signatures = candidates.map((member) => ({ member, type: memberTypeIn(context, member) }));
    const winner = signatures.find(({ member, type }) =>
      signatures.every(({ member: other, type: expected }) => {
        if ((member.kind === 'method') !== (other.kind === 'method')) return false;
        return setter ? isSubtype(expected, type) : isSubtype(type, expected);
      })
    )?.member;
    if (winner?.kind !== 'method') return winner;
    return this.mergeMethodCovariance(winner, candidates);
  }

  private mergeMethodCovariance(member: MethodMember, candidates: Member[]): MethodMember {
    const methods = candidates.filter((candidate) => candidate.kind === 'method');
    const positions = new Set(methods.flatMap((method) => [...(method.covariantPositional ?? [])]));
    const names = new Set(methods.flatMap((method) => [...(method.covariantNamed ?? [])]));
    const covariantPositional = positions.size > 0 ? positions : undefined;
    const covariantNamed = names.size > 0 ? names : undefined;
    if (sameSet(covariantPositional, member.covariantPositional) && sameSet(covariantNamed, member.covariantNamed))
      return member;
    const existing = this.combinedMethods.get(member);
    if (
      existing &&
      sameSet(covariantPositional, existing.covariantPositional) &&
      sameSet(covariantNamed, existing.covariantNamed)
    )
      return existing;
    const merged = { ...member, combinedFrom: member.combinedFrom ?? member, covariantPositional, covariantNamed };
    this.combinedMethods.set(member, merged);
    return merged;
  }

  private ownInstanceMember(key: string, setter: boolean): Member | undefined {
    const name = sourceMemberName(key);
    const library = (this.mixinOf ?? this).library;
    if (scopedMemberName(name, library) !== key) return undefined;
    return (setter ? this.setters : this.members).get(name);
  }

  /** The names of every instance member the interface has, for checks such as missing implementations. */
  interfaceMemberNames(setter: boolean): Set<string> {
    const names = new Set<string>();
    const visit = (cls: ClassInfo, seen: Set<ClassInfo>): void => {
      if (seen.has(cls)) return;
      seen.add(cls);
      const library = (cls.mixinOf ?? cls).library;
      const members = setter ? cls.setters : cls.members;
      for (const name of members.keys()) names.add(scopedMemberName(name, library));
      for (const supertype of cls.directSupertypes) visit(supertype.cls, seen);
    };
    visit(this, new Set());
    return names;
  }

  /** Forgets cached lookups, after members are added to a class that has already been searched. */
  resetCaches(): void {
    this.implementations.clear();
    this.setterImplementations.clear();
    this.supertypePaths = new WeakMap();
    this.cachedDepth = undefined;
  }
}

export function memberTypeIn(type: InterfaceType, member: Member): DartType {
  if (member.owner.typeParams.length === 0) return member.type;
  const owner = asInstanceOf(type, member.owner);
  const env = new Map(member.owner.typeParams.map((param, index) => [param, owner?.args[index] ?? DYNAMIC]));
  return substitute(member.type, env);
}

export function covariantSetter(cls: ClassInfo, name: string, type: DartType, explicit: boolean): boolean {
  if (explicit || mentionsCovariantly(type, new Set(cls.typeParams))) return true;
  const key = scopedMemberName(name, (cls.mixinOf ?? cls).library);
  return cls.directSupertypes.some(({ cls: parent }) => {
    const inherited = parent.interfaceMember(key, true);
    if (inherited?.kind === 'setter') {
      return inherited.isCovariant === true || mentionsCovariantly(inherited.type, new Set(inherited.owner.typeParams));
    }
    return inherited?.kind === 'field' && covariantSetter(inherited.owner, name, inherited.type, inherited.isCovariant);
  });
}

function sameForwardingSignature(type: InterfaceType, inherited: Member, declared: Member): boolean {
  if (!sameType(memberTypeIn(type, inherited), memberTypeIn(type, declared))) return false;
  if (inherited.kind !== 'method' || declared.kind !== 'method') return true;
  if ((inherited.combinedFrom ?? inherited) === (declared.combinedFrom ?? declared)) return true;
  return (
    sameSet(inherited.covariantPositional, declared.covariantPositional) &&
    sameSet(inherited.covariantNamed, declared.covariantNamed)
  );
}

function sameSet<T>(left: ReadonlySet<T> | undefined, right: ReadonlySet<T> | undefined): boolean {
  if (!left || !right) return left === right;
  return left.size === right.size && left.isSubsetOf(right);
}
