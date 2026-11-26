import type { Evaluator } from './evaluator';
import { MeteredText } from './meteredText';
import { environmentOf, stringOf } from './objects';
import type { Frame, NativeState } from './runtime';
import {
  type MethodSymbol,
  type NamedType,
  namedType,
  substitute,
  substitutionOf,
  type Type,
  type TypeSymbol,
} from './types';
import { CsObject, type CsStruct, type Value } from './values';

export function recordText(evaluator: Evaluator, frame: Frame, value: CsObject | CsStruct): string {
  // The text is built through a metered text, which stops at the string limit before a long member is joined in.
  const text = new MeteredText(evaluator.runtime);
  const isAnonymous = value.type.symbol.anonymousDisplay !== undefined;
  if (!isAnonymous) {
    const chain = typeChain(value.type);
    const customLevel = chain.findLastIndex((type) => ownPrintMembers(type.symbol) !== undefined);
    if (customLevel !== -1) {
      customRecordText(evaluator, frame, value, chain, customLevel, text);
      return text.toString();
    }
  }
  const members = printedMembers(value.type);
  if (!isAnonymous) text.append(value.type.symbol.name);
  text.append(isAnonymous ? '{ ' : members.length > 0 ? ' { ' : ' { }');
  for (const [index, member] of members.entries()) {
    if (index > 0) text.append(', ');
    appendMember(evaluator, frame, value, member, text);
  }
  if (isAnonymous || members.length > 0) text.append(members.length > 0 ? ' }' : '}');
  return text.toString();
}

/**
 * The text of a record of which a level declares its own `PrintMembers`, which ToString calls with a StringBuilder, and
 * whose synthesized ones below print their own members after it, as .NET's do.
 */
function customRecordText(
  evaluator: Evaluator,
  frame: Frame,
  value: CsObject | CsStruct,
  chain: NamedType[],
  customLevel: number,
  text: MeteredText
): void {
  text.append(`${value.type.symbol.name} { `);
  let printedAny = callPrintMembers(evaluator, frame, value, chain[customLevel], text);
  for (const member of chain.slice(customLevel + 1).flatMap(ownPrintedMembers)) {
    if (printedAny) text.append(', ');
    appendMember(evaluator, frame, value, member, text);
    printedAny = true;
  }
  text.append(printedAny ? ' }' : '}');
}

/** The program's own `PrintMembers(StringBuilder)` that a record type declares, if any. */
function ownPrintMembers(symbol: TypeSymbol): MethodSymbol | undefined {
  return symbol.methods.find(
    (method) =>
      method.name === 'PrintMembers' &&
      !method.isStatic &&
      method.declaration !== undefined &&
      method.parameters.length === 1 &&
      method.parameters[0].type.kind === 'named' &&
      method.parameters[0].type.symbol.fullName === 'System.Text.StringBuilder'
  );
}

/** Calls a record's own `PrintMembers` with a new StringBuilder, appending what it wrote; returns what it returned. */
function callPrintMembers(
  evaluator: Evaluator,
  frame: Frame,
  value: CsObject | CsStruct,
  owner: NamedType,
  text: MeteredText
): boolean {
  const method = ownPrintMembers(owner.symbol) as MethodSymbol;
  const builderSymbol = evaluator.runtime.library.typeNamed('System.Text.StringBuilder');
  const builder = new CsObject(namedType(builderSymbol), []);
  const constructor = builderSymbol.constructors.find((candidate) => candidate.parameters.length === 0);
  if (!constructor?.native) throw new Error('StringBuilder() has no native constructor');
  constructor.native({ frame, method: constructor, typeArgs: [], owner: undefined, row: undefined }, builder, []);
  frame.temporaries.push(builder);
  try {
    const result = evaluator.invoke(
      frame,
      method,
      value,
      [builder],
      undefined,
      environmentOf(evaluator, method, value)
    );
    text.append((builder.native as NativeState).displayText?.() ?? '');
    return result === true;
  } finally {
    frame.temporaries.pop();
  }
}

function appendMember(
  evaluator: Evaluator,
  frame: Frame,
  value: CsObject | CsStruct,
  member: PrintedMember,
  text: MeteredText
): void {
  const getter = member.getter;
  const memberValue = getter
    ? evaluator.invoke(
        frame,
        evaluator.runtime.dispatch(getter, value),
        value,
        [],
        undefined,
        environmentOf(evaluator, getter, value)
      )
    : member.read(value);
  text.append(`${member.name} = `);
  if (memberValue !== undefined) text.append(stringOf(evaluator, memberValue, member.type, frame));
}

/** The members that a record's `ToString` prints: its public instance fields and properties, base record first. */
interface PrintedMember {
  name: string;
  read: (value: CsObject | CsStruct) => Value;
  type: Type;
  /** The getter of a property without a backing field, which printing calls. */
  getter?: MethodSymbol;
}

function printedMembers(type: NamedType): PrintedMember[] {
  return typeChain(type).flatMap(ownPrintedMembers);
}

/** A type and its bases below object or ValueType, base first. */
function typeChain(type: NamedType): NamedType[] {
  const chain: NamedType[] = [];
  for (
    let current: NamedType | undefined = type;
    current && current.symbol.special !== 'object' && current.symbol.special !== 'valueType';
    current = current.symbol.baseType
      ? (substitute(current.symbol.baseType, substitutionOf(current)) as NamedType)
      : undefined
  )
    chain.unshift(current);
  return chain;
}

/** A type's own printed members in the order of their declarations. */
function ownPrintedMembers(owner: NamedType): PrintedMember[] {
  const members: (PrintedMember & { row: number; column: number })[] = [];
  const substitution = substitutionOf(owner);
  for (const field of owner.symbol.fields) {
    if (field.isStatic || field.isConst || field.access !== 'public' || field.property || field.isPrimaryParameter)
      continue;
    members.push({
      name: field.name,
      read: (value) => value.fields[field.slot],
      type: substitute(field.type, substitution),
      row: field.row,
      column: field.column,
    });
  }
  for (const property of owner.symbol.properties) {
    if (
      property.isStatic ||
      property.isIndexer ||
      property.access !== 'public' ||
      !property.getter ||
      property.isOverride
    )
      continue;
    const backing = property.backingField;
    if (backing)
      members.push({
        name: property.name,
        read: (value) => value.fields[backing.slot],
        type: substitute(property.type, substitution),
        row: property.row,
        column: property.column,
      });
    else
      members.push({
        name: property.name,
        read: () => {},
        type: substitute(property.type, substitution),
        getter: property.getter,
        row: property.row,
        column: property.column,
      });
  }
  return members.toSorted((a, b) => a.row - b.row || a.column - b.column);
}
