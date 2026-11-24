import type { CompilerBase } from './compilerBase';
import { constantExpr } from './expr';
import type { Entity } from './scopes';
import { fieldOf, hasToken, type Syntax } from './syntax';
import { EnumInfo, intMax, intMin, type IntName, isInteger, type Type } from './types';

/** The integer types an enumeration without a fixed type may take, the first that holds every enumerator. */
const IMPLICIT_UNDERLYING: readonly IntName[] = ['int', 'uint', 'long', 'ulong'];

/** Defines an enumeration or names a declared one, for an `enum_specifier`. */
export function enumSpecifierType(compiler: CompilerBase, node: Syntax): Type {
  const nameNode = fieldOf(node, 'name');
  const body = fieldOf(node, 'body');
  const baseNode = fieldOf(node, 'base');
  const isScoped = hasToken(node, 'class') || hasToken(node, 'struct');
  if (!nameNode) {
    if (!body) return compiler.error(node.row, '列挙の名前を書いてください。');
    if (isScoped) return compiler.error(node.row, 'enum class には名前を書いてください。');
  }
  const name = nameNode?.text;
  const existing = name === undefined ? undefined : compiler.findDeclaredHere(name);
  if (existing) {
    if (existing.kind !== 'type' || existing.type.kind !== 'int' || !existing.type.enumeration)
      return compiler.error(node.row, `${name} はすでに別のものとして宣言されています。`);
    const info = existing.type.enumeration;
    if (body && info.isComplete) return compiler.error(node.row, `列挙 ${name} はすでに定義されています。`);
    if (!body) return existing.type;
    defineEnumerators(compiler, info, body);
    return existing.type;
  }
  if (name === undefined && !body) return compiler.error(node.row, '列挙の名前を書いてください。');
  let underlying: IntName = 'int';
  if (baseNode) {
    const base = compiler.resolveTypeSpecifier(baseNode);
    if (!isInteger(base) || base.enumeration)
      return compiler.error(baseNode.row, `列挙の基になる型 ${baseNode.text} は整数型でなければなりません。`);
    underlying = base.name;
  }
  if (!body && !isScoped && !baseNode)
    return compiler.error(node.row, `列挙 ${name} を使う前に、列挙子を定義してください。`);
  const info = new EnumInfo(name ?? '(名前のない列挙)', isScoped, underlying, isScoped || baseNode !== undefined);
  const type: Extract<Type, { kind: 'int' }> = { kind: 'int', name: underlying, enumeration: info };
  if (name !== undefined) compiler.declareHere(name, { kind: 'type', type }, node.row);
  if (!body) {
    info.isComplete = true;
    return type;
  }
  defineEnumerators(compiler, info, body);
  // The enumerators decide the underlying type of an enumeration without a fixed one.
  type.name = info.underlying;
  return type;
}

function defineEnumerators(compiler: CompilerBase, info: EnumInfo, body: Syntax): void {
  let next: bigint = 0n;
  let previous: Syntax | undefined;
  const values: [string, bigint, number][] = [];
  compiler.withNames((declare) => {
    for (const enumerator of body.children) {
      if (enumerator.type !== 'enumerator') continue;
      const enumeratorName = (fieldOf(enumerator, 'name') as Syntax).text;
      const valueNode = fieldOf(enumerator, 'value');
      let value = next;
      if (valueNode) {
        const expr = compiler.rvalue(compiler.compileExpression(valueNode));
        const constant = compiler.constantValueOf(expr);
        if (!isInteger(expr.type) || expr.type.enumeration?.isScoped || constant === undefined)
          return compiler.error(valueNode.row, `列挙子 ${enumeratorName} の値には、整数の定数式を書いてください。`);
        value = BigInt(constant);
      } else if (previous && info.hasFixedType && value > intMax(info.underlying)) {
        compiler.error(enumerator.row, `列挙子 ${enumeratorName} の値が ${info.name} の範囲を超えました。`);
      }
      if (info.hasFixedType && (value > intMax(info.underlying) || value < intMin(info.underlying)))
        compiler.error(enumerator.row, `列挙子 ${enumeratorName} の値 ${value} は、基になる型の範囲に収まりません。`);
      if (values.some(([other]) => other === enumeratorName))
        compiler.error(enumerator.row, `列挙子 ${enumeratorName} はすでに宣言されています。`);
      values.push([enumeratorName, value, enumerator.row]);
      // Inside the body, an enumerator has the type of its value until the enumeration is complete.
      const type: Type = { kind: 'int', name: info.hasFixedType ? info.underlying : fittingType([value]) };
      declare(enumeratorName, constantValue(type, value));
      next = value + 1n;
      previous = enumerator;
    }
  });
  if (!info.hasFixedType) info.underlying = fittingType(values.map(([, value]) => value));
  const type: Type = { kind: 'int', name: info.underlying, enumeration: info };
  for (const [enumeratorName, value, row] of values) {
    const constant = toConstant(info.underlying, value);
    info.enumerators.set(enumeratorName, constant);
    if (!info.isScoped) compiler.declareHere(enumeratorName, constantValue(type, value), row);
  }
  info.isComplete = true;
}

function fittingType(values: readonly bigint[]): IntName {
  const name = IMPLICIT_UNDERLYING.find((candidate) =>
    values.every((value) => value >= intMin(candidate) && value <= intMax(candidate))
  );
  return name ?? 'ulong';
}

function toConstant(name: IntName, value: bigint): number | bigint {
  return name === 'long' || name === 'ulong' || name === 'llong' || name === 'ullong' ? value : Number(value);
}

function constantValue(type: Extract<Type, { kind: 'int' }>, value: bigint): Extract<Entity, { kind: 'value' }> {
  const constant = toConstant(type.name, value);
  return { kind: 'value', make: (row: number) => constantExpr(type, constant, row) };
}

/** The enumerator of a scoped enumeration that `E::name` names. */
export function enumeratorEntity(info: EnumInfo, name: string): Entity | undefined {
  const value = info.enumerators.get(name);
  if (value === undefined) return;
  return constantValue({ kind: 'int', name: info.underlying, enumeration: info }, BigInt(value));
}
