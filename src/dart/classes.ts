import type { ClassDeclaration, ClassKind, ClassModifiers } from './ast';
import type { Runtime } from './runtime';
import {
  type DartType,
  DYNAMIC,
  type FunctionType,
  type InterfaceType,
  interfaceType,
  substitute,
  type TypeParam,
  typeParamType,
} from './types';
import type { Arguments, Callable, DartObject, Value } from './values';

/** A member as the type checker sees it, and as the runtime runs it. */
export type Member = MethodMember | GetterMember | SetterMember | FieldMember;

interface MemberBase {
  name: string;
  owner: ClassInfo;
  isStatic: boolean;
  isAbstract: boolean;
  /** The row of the declaration, for messages; undefined for library members. */
  row: number | undefined;
}

export interface MethodMember extends MemberBase {
  kind: 'method';
  type: FunctionType;
  impl: Callable | undefined;
  isOperator: boolean;
  /** For a library method a native implements, its positional parameters' names, which a dynamic call's checks name. */
  nativeParameterNames?: readonly string[];
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
  /** The type an extension type represents. */
  representationType: DartType | undefined;
  representationName: string | undefined;
  enumValues: Value[] | undefined;
  declaration: ClassDeclaration | undefined;
  /** The classes from the same library that a sealed class's subtypes must come from. */
  readonly subclasses: ClassInfo[] = [];
  private readonly supertypePaths = new Map<ClassInfo, InterfaceType | undefined>();
  private readonly implementations = new Map<string, Member | undefined>();
  private readonly setterImplementations = new Map<string, Member | undefined>();
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

  /** The concrete member that runs for an instance of this class, searching the superclass chain. */
  implementation(name: string): Member | undefined {
    if (this.implementations.has(name)) return this.implementations.get(name);
    let found: Member | undefined;
    for (const cls of this.superclassChain()) {
      const member = cls.members.get(name);
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
      const member = cls.setters.get(name);
      if (member && !member.isAbstract) {
        found = member;
        break;
      }
    }
    this.setterImplementations.set(name, found);
    return found;
  }

  /** This class and its superclasses, nearest first. */
  *superclassChain(): Iterable<ClassInfo> {
    yield this;
    for (let cls = this.superclass?.cls; cls; cls = cls.superclass?.cls) yield cls;
  }

  /** The member a class's interface has, declared in it or inherited from a supertype, before substitution. */
  interfaceMember(name: string, setter = false): Member | undefined {
    return this.findInterfaceMember(name, setter, new Set());
  }

  private findInterfaceMember(name: string, setter: boolean, visited: Set<ClassInfo>): Member | undefined {
    if (visited.has(this)) return undefined;
    visited.add(this);
    const own = (setter ? this.setters : this.members).get(name);
    if (own) return own;
    for (const supertype of this.directSupertypes) {
      const found = supertype.cls.findInterfaceMember(name, setter, visited);
      if (found) return found;
    }
    return undefined;
  }

  /** The names of every instance member the interface has, for checks such as missing implementations. */
  interfaceMemberNames(): Set<string> {
    const names = new Set<string>();
    const visit = (cls: ClassInfo, seen: Set<ClassInfo>): void => {
      if (seen.has(cls)) return;
      seen.add(cls);
      for (const name of cls.members.keys()) names.add(name);
      for (const name of cls.setters.keys()) names.add(`${name}=`);
      for (const supertype of cls.directSupertypes) visit(supertype.cls, seen);
    };
    visit(this, new Set());
    return names;
  }

  /** Forgets cached lookups, after members are added to a class that has already been searched. */
  resetCaches(): void {
    this.implementations.clear();
    this.setterImplementations.clear();
    this.supertypePaths.clear();
    this.cachedDepth = undefined;
  }
}
