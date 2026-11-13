import { utf8Encode } from '../literals';
import { dynamicMethod } from '../methods';
import { currentRuntime } from '../native';
import {
  type InterfaceType,
  isExported,
  missingMethod,
  type NamedType,
  pointerTo,
  type StructType,
  type Type,
  typeString,
  underlying,
} from '../types';
import { Cell, Complex, GoArray, GoStruct, Iface, Pointer, type Value } from '../values';
import { type Kind, typeKind } from './templateReflect';

/** reflect's kind of a type, as `reflect.Type.Kind` names it. */
export function kindOf(type: Type): Kind {
  return typeKind(type);
}

/** The bit size of an integer or float type, as `reflect.Type.Bits`. */
export function bitsOf(type: Type): number {
  const under = underlying(type);
  if (under.kind !== 'basic') return 64;
  const match = /\d+$/.exec(under.basic);
  if (under.basic.startsWith('complex')) return Number(match?.[0] ?? 128);
  return match ? Number(match[0]) : 64;
}

/** `reflect.Type.Name`: a defined type's name with its type arguments, or '' for other types. */
export function typeName(type: Type): string {
  if (type.kind === 'basic') return type.basic === 'uint8' || type.basic === 'int32' ? type.basic : type.name;
  if (type.kind !== 'named') return '';
  if (!type.typeArgs) return type.name;
  return `${type.name}[${type.typeArgs.map((arg) => typeString(arg)).join(',')}]`;
}

/** The zero value of a type, as a new variable of it holds. */
export function zeroValue(type: Type): Value {
  const under = underlying(type);
  switch (under.kind) {
    case 'basic': {
      const name = under.basic;
      if (name === 'string') return '';
      if (name === 'bool') return false;
      if (name.startsWith('float')) return 0;
      if (name.startsWith('complex')) return new Complex(0, 0);
      return 0n;
    }
    case 'struct': {
      currentRuntime().allocate(under.fields.length);
      return new GoStruct(under.fields.map((field) => zeroValue(field.type)));
    }
    case 'array': {
      currentRuntime().allocate(under.length);
      return new GoArray(Array.from({ length: under.length }, () => zeroValue(under.element)));
    }
    default: {
      return undefined;
    }
  }
}

/** A new variable of the type holding its zero value, as `reflect.New` makes. */
export function newVariable(type: Type, value: Value = zeroValue(type)): Pointer {
  currentRuntime().allocate(1);
  return new Pointer(new Cell(value), 'v');
}

/** Whether values of the type have all methods of the interface. */
export function implementsInterface(type: Type, iface: NamedType | InterfaceType): boolean {
  const target = iface.kind === 'named' ? (iface.underlying as InterfaceType) : iface;
  return missingMethod(type, target) === undefined;
}

/** How a type implements an interface: by its values, only through pointers to it, or not at all. */
export function implementsVia(type: Type, iface: NamedType): 'value' | 'pointer' | undefined {
  if (implementsInterface(type, iface)) return 'value';
  if (kindOf(type) !== 'pointer' && kindOf(type) !== 'interface' && implementsInterface(pointerTo(type), iface)) {
    return 'pointer';
  }
  return undefined;
}

/** Calls a method of the variable at `pointer`, of type `type`, as `pointer.Method(args...)` does. */
export function callPointerMethod(type: Type, pointer: Pointer, name: string, args: Value[]): Value | Value[] {
  const call = dynamicMethod(pointerTo(type), name);
  if (!call) throw new Error(`Missing method ${name}`);
  return call(pointer, args);
}

/** Calls a method of a value of `type`, as `value.Method(args...)` does. */
export function callValueMethod(type: Type, value: Value, name: string, args: Value[]): Value | Value[] {
  const call = dynamicMethod(type, name);
  if (!call) throw new Error(`Missing method ${name}`);
  return call(value, args);
}

/** The struct type under a type, when it is one. */
export function structOf(type: Type): StructType | undefined {
  const under = underlying(type);
  return under.kind === 'struct' ? under : undefined;
}

/** The name of a struct field as Go spells it in UTF-8. */
export function fieldName(name: string): string {
  return utf8Encode(name);
}

export function exported(name: string): boolean {
  return isExported(name);
}

/** An interface value holding a copy of `value`, or nil for a nil interface. */
export function boxValue(type: Type, value: Value): Value {
  return kindOf(type) === 'interface' ? value : new Iface(type, value);
}
