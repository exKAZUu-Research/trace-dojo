import { typeIdentityKey } from './lambdaBinder';
import {
  arrayType,
  MethodSymbol,
  type NamedType,
  namedType,
  type ParameterSymbol,
  refKeyword,
  type Type,
  TypeParameterSymbol,
  TypeSymbol,
} from './types';

/** The bits of each parameter's ref kind in the name of a `<>F{...}` or `<>A{...}` delegate, three per parameter. */
const REF_KIND_BITS = { ref: 1, out: 2, in: 3, refReadonly: 4 } as const;

/**
 * The delegate types that the compiler makes for the natural types of lambdas and method groups that no `Func` or
 * `Action` fits: `<>F{00000001}\`2` for parameters passed by reference, and `<>f__AnonymousDelegate0\`1` for `params`
 * parameters, default values, or `scoped` parameters, which also tell the types apart.
 */
export class AnonymousDelegates {
  private readonly symbols = new Map<string, TypeSymbol>();
  private numbered = 0;

  constructor(private readonly baseType: () => NamedType) {}

  /** The delegate type of the parameters, whose default values are already bound, and of the return type. */
  typeOf(
    parameters: ParameterSymbol[],
    returnType: Type,
    isScoped: boolean,
    returnsByRef?: 'ref' | 'readonly'
  ): NamedType {
    const isAction = returnType.kind === 'void';
    // A generic delegate takes a `params` array's element type as its type argument.
    const args = parameters.map((parameter) =>
      parameter.isParams && parameter.type.kind === 'array' ? parameter.type.element : parameter.type
    );
    if (!isAction) args.push(returnType);
    const refKindsOnly = !isScoped && parameters.every((parameter) => !parameter.isParams && !hasDefault(parameter));
    if (refKindsOnly) {
      const name = `<>${isAction ? 'A' : 'F'}{${refKindBits(parameters, returnsByRef)}}`;
      return namedType(
        this.symbolOf(`${name}\`${args.length}`, name, parameters, returnType, true, returnsByRef),
        args
      );
    }
    const key = [
      ...parameters.map(parameterKey),
      isScoped ? 'scoped' : '',
      `${returnsByRef ?? ''} ${typeIdentityKey(returnType)}`,
    ].join(';');
    const symbol = this.symbolOf(key, undefined, parameters, returnType, !isScoped, returnsByRef);
    return namedType(symbol, isScoped ? [] : args);
  }

  private symbolOf(
    key: string,
    name: string | undefined,
    parameters: ParameterSymbol[],
    returnType: Type,
    isGeneric: boolean,
    returnsByRef?: 'ref' | 'readonly'
  ): TypeSymbol {
    const existing = this.symbols.get(key);
    if (existing) return existing;
    const symbol = new TypeSymbol(name ?? `<>f__AnonymousDelegate${this.numbered++}`, 'delegate', '', undefined);
    symbol.isSealed = true;
    symbol.baseType = this.baseType();
    symbol.anonymousDisplay = '<anonymous delegate>';
    const isAction = returnType.kind === 'void';
    const count = parameters.length + (isAction ? 0 : 1);
    if (isGeneric)
      symbol.typeParameters = Array.from(
        { length: count },
        (_, index) =>
          new TypeParameterSymbol(index < parameters.length ? `T${index + 1}` : 'TResult', symbol, index, undefined)
      );
    const invoke = new MethodSymbol('Invoke', symbol, 'delegateInvoke');
    invoke.access = 'public';
    invoke.parameters = parameters.map((parameter, index) => ({
      name: parameter.name,
      type: isGeneric ? genericParameterType(parameter, symbol.typeParameters[index]) : parameter.type,
      refKind: parameter.refKind,
      isRefReadonly: parameter.isRefReadonly,
      isParams: parameter.isParams,
      defaultValue: parameter.defaultValue,
      defaultSyntax: parameter.defaultSyntax,
      defaultContext: parameter.defaultContext,
      position: parameter.position,
    }));
    invoke.returnType =
      !isAction && isGeneric ? (symbol.typeParameters.at(-1) as TypeParameterSymbol).type : returnType;
    invoke.returnsByRef = returnsByRef;
    symbol.invoke = invoke;
    symbol.methods.push(invoke);
    this.symbols.set(key, symbol);
    return symbol;
  }
}

function genericParameterType(parameter: ParameterSymbol, typeParameter: TypeParameterSymbol): Type {
  return parameter.isParams && parameter.type.kind === 'array'
    ? arrayType(typeParameter.type, parameter.type.rank)
    : typeParameter.type;
}

export function hasDefault(parameter: ParameterSymbol): boolean {
  return parameter.defaultSyntax !== undefined || parameter.defaultValue !== undefined;
}

/** The ref kinds of the parameters, then of the return, in hexadecimal as the delegate's name spells them. */
function refKindBits(parameters: ParameterSymbol[], returnsByRef: 'ref' | 'readonly' | undefined): string {
  const kinds: (keyof typeof REF_KIND_BITS | undefined)[] = [
    ...parameters.map((parameter) => (parameter.isRefReadonly ? 'refReadonly' : parameter.refKind)),
    returnsByRef === 'readonly' ? 'in' : returnsByRef,
  ];
  let bits = 0n;
  for (const [index, kind] of kinds.entries()) if (kind) bits += BigInt(REF_KIND_BITS[kind]) << BigInt(3 * index);
  return bits.toString(16).padStart(8, '0');
}

function parameterKey(parameter: ParameterSymbol): string {
  const modifier = `${refKeyword(parameter) ?? ''} ${parameter.isParams ? 'params ' : ''}`;
  return `${modifier}${typeIdentityKey(parameter.type)}${defaultKey(parameter)}`;
}

function defaultKey(parameter: ParameterSymbol): string {
  if (!parameter.defaultValue) return '';
  const { value } = parameter.defaultValue;
  return ` = ${typeof value}:${String(value)}`;
}
