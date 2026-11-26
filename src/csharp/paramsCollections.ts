import type { TypeContext } from './binderBase';
import type { BoundArgument, BoundExpression } from './bound';
import type { MemberBinder, NonValue } from './memberBinder';
import {
  allInterfacesOf,
  type ArrayType,
  displayType,
  type MethodSymbol,
  type NamedType,
  namedType,
  type Type,
  type TypeSymbol,
} from './types';

/**
 * How a `params` parameter's type (C# 13 params collections) receives the arguments of the expanded form: an array, a
 * `ReadOnlySpan<T>` over one, a `List<T>` for the interfaces that an array implements, or a class or struct that its
 * parameterless constructor creates and `Add` fills.
 */
export type ParamsCollection =
  | { kind: 'array'; type: ArrayType; element: Type }
  | { kind: 'span'; type: NamedType; element: Type }
  | { kind: 'list'; type: NamedType; element: Type }
  | { kind: 'constructible'; type: NamedType; element: Type };

const LIST_INTERFACES = new Set([
  'System.Collections.Generic.IEnumerable`1',
  'System.Collections.Generic.IReadOnlyCollection`1',
  'System.Collections.Generic.IReadOnlyList`1',
  'System.Collections.Generic.ICollection`1',
  'System.Collections.Generic.IList`1',
]);

/** The collection that a `params` parameter of the type takes, or undefined when the type is none (CS0225). */
export function paramsCollectionOf(type: Type, objectType: Type): ParamsCollection | undefined {
  if (type.kind === 'array') return type.rank === 1 ? { kind: 'array', type, element: type.element } : undefined;
  if (type.kind !== 'named') return undefined;
  const { symbol } = type;
  if (symbol.fullName === 'System.ReadOnlySpan`1') return { kind: 'span', type, element: type.args[0] };
  if (LIST_INTERFACES.has(symbol.fullName)) return { kind: 'list', type, element: type.args[0] };
  if (symbol.kind !== 'class' && symbol.kind !== 'struct') return undefined;
  // The element type is the type's iteration type, which an implementation of `IEnumerable<T>` or `IEnumerable` gives.
  const faces = allInterfacesOf(type, () => []);
  const generic = faces.filter((face) => face.symbol.fullName === 'System.Collections.Generic.IEnumerable`1');
  if (generic.length === 1) return { kind: 'constructible', type, element: generic[0].args[0] };
  if (generic.length === 0 && faces.some((face) => face.symbol.fullName === 'System.Collections.IEnumerable'))
    return { kind: 'constructible', type, element: objectType };
  return undefined;
}

/**
 * Whether the first params collection is the better one when both candidates take the arguments in expanded form to
 * the same element types, by the rules of collection expressions: a span over an array or an interface of one, and
 * otherwise a collection that converts implicitly to the other.
 */
export function isBetterParamsCollection(
  a: ParamsCollection,
  b: ParamsCollection,
  converts: (from: Type, to: Type) => boolean
): boolean {
  if (a.kind === 'span') return b.kind !== 'span' && b.kind !== 'constructible' && converts(a.element, b.element);
  return b.kind !== 'span' && converts(a.type, b.type);
}

/**
 * The params collection of a class or struct, or the `List<T>` of an interface, that the parameterless constructor
 * creates and an `Add` call for each element fills, as the collection expression of the arguments does; the method's
 * declaring type decides which members it may use.
 */
export function createParamsCollection(
  binder: MemberBinder,
  collection: Extract<ParamsCollection, { kind: 'constructible' | 'list' }>,
  elements: BoundExpression[],
  declaringType: TypeSymbol,
  row: number
): BoundExpression {
  const type =
    collection.kind === 'list'
      ? namedType(binder.library.typeNamed('System.Collections.Generic.List', 1), [collection.element])
      : collection.type;
  const context: TypeContext = { namespace: [], usings: [], type: declaringType, methodTypeParameters: [] };
  // The parameter's declaration reports a collection that cannot be created or filled, which no call repeats.
  const saved = binder.diagnostics.length;
  const { found } = binder.lookupMember(type, 'Add', context, 0, true);
  const group: Extract<NonValue, { kind: 'methodGroup' }> = {
    kind: 'methodGroup',
    name: 'Add',
    candidates: found?.kind === 'methods' ? found.candidates.filter(({ method }) => !method.isStatic) : [],
    receiver: { kind: 'compoundOperand', type, row },
    isSimpleName: false,
    typeArgs: undefined,
    extensions: [],
    isBaseAccess: false,
    row,
  };
  const initializer = elements.map((element) => ({
    kind: 'collectionAdd' as const,
    call: binder.invokeMethodGroup(
      group,
      [{ expression: element, name: undefined, refKind: undefined, row: element.row, target: undefined }],
      { row, column: 0 }
    ),
  }));
  const creation = parameterlessCreation(binder, type, row);
  binder.diagnostics.length = saved;
  const created: BoundExpression = { kind: 'new', ...creation, objectType: type, initializer, type, row };
  return collection.kind === 'list' ? binder.convert(created, collection.type, row) : created;
}

/**
 * The constructor that `new T()` calls with the defaults of its optional parameters, or none for a struct that
 * declares no parameterless one.
 */
function parameterlessCreation(
  binder: MemberBinder,
  type: NamedType,
  row: number
): { constructor: MethodSymbol | undefined; args: BoundArgument[] } {
  const { symbol } = type;
  const declaresParameterless = symbol.constructors.some(
    (constructor) => constructor.parameters.length === 0 && constructor.declaration
  );
  if (symbol.kind === 'struct' && !declaresParameterless) return { constructor: undefined, args: [] };
  const candidates = symbol.constructors.map((method) => ({ method, owner: type }));
  const resolved = binder.resolveCall(candidates, [], undefined, row, {
    name: symbol.name,
    kind: 'constructor',
    typeName: displayType(type),
  });
  return { constructor: resolved?.candidate.method, args: resolved?.args ?? [] };
}
