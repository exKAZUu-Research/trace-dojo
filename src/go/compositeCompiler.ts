import { constantValue, represent } from './assignability';
import type { CompositeLiteral, Expression } from './ast';
import { mapKeyOf } from './equality';
import { describeConstant, ExpressionCompiler } from './expressionCompiler';
import type { Operand } from './operand';
import { type Eval, evaluateAll, type Frame } from './runtime';
import { BASIC, coreType, defaultType, describeType, isInterface, type Type, typeString, underlying } from './types';
import { Cell, GoArray, GoMap, GoStruct, Pointer, Slice, type Value } from './values';

/** Compiles composite literals: structs, arrays, slices, and maps, whose nested literals may elide their types. */
export abstract class CompositeCompiler extends ExpressionCompiler {
  protected composite(expression: CompositeLiteral, elided: Type | undefined): Operand {
    let type = elided;
    if (expression.type?.kind === 'array' && expression.type.length === undefined) {
      type = this.implicitLengthArray(expression, expression.type.element);
    } else if (expression.type) type = this.resolveType(expression.type);
    if (!type) {
      this.error(expression, '複合リテラルには型を書いてください。');
      return this.invalid(expression);
    }
    if (type === BASIC.invalid) return this.invalid(expression);
    let pointerElided = false;
    let literalType = type;
    if (!expression.type && underlying(type).kind === 'pointer') {
      // `[]*T{{...}}` elides `&T`.
      literalType = (underlying(type) as { element: Type }).element;
      pointerElided = true;
    }
    const under = coreType(literalType) ?? underlying(literalType);
    let operand: Operand;
    switch (under.kind) {
      case 'struct': {
        operand = this.structLiteral(expression, literalType, under);
        break;
      }
      case 'array':
      case 'slice': {
        operand = this.arrayLiteral(expression, literalType, under);
        break;
      }
      case 'map': {
        operand = this.mapLiteral(expression, literalType, under);
        break;
      }
      default: {
        this.error(expression, `${describeType(literalType)} 型には複合リテラルを書けません。`);
        return this.invalid(expression);
      }
    }
    if (!pointerElided) return { ...operand, createsObject: true };
    const read = operand.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      createsObject: true,
      eval: (frame) => new Pointer(new Cell(read(frame)), 'v'),
    };
  }

  /** `[...]T{...}`: an array as long as the highest index of its elements plus one. */
  private implicitLengthArray(expression: CompositeLiteral, elementSyntax: CompositeLiteral['type'] & object): Type {
    const element = this.resolveType(elementSyntax);
    let length = 0;
    let next = 0;
    for (const item of expression.elements) {
      if (item.key) {
        const { value } = this.constantExpression(item.key);
        if (value === undefined) return BASIC.invalid;
        next = Number(value);
      }
      next++;
      length = Math.max(length, next);
    }
    if (element === BASIC.invalid) return BASIC.invalid;
    return { kind: 'array', element, length };
  }

  /** An element of a composite literal, whose own literal may elide its type. */
  private element(expression: Expression, type: Type, context: string): Eval {
    if (expression.kind === 'composite' && !expression.type)
      return this.assign(this.composite(expression, type), type, context);
    if (
      expression.kind === 'unary' &&
      expression.operator === '&' &&
      expression.operand.kind === 'composite' &&
      !expression.operand.type
    ) {
      const pointer = underlying(type);
      if (pointer.kind === 'pointer') {
        const literal = this.composite(expression.operand, pointer.element);
        const read = literal.eval;
        return (frame) => new Pointer(new Cell(read(frame)), 'v');
      }
    }
    return this.assign(this.expression(expression), type, context);
  }

  private structLiteral(expression: CompositeLiteral, type: Type, struct: Extract<Type, { kind: 'struct' }>): Operand {
    const { fields } = struct;
    const values = Array.from<Eval | undefined>({ length: fields.length });
    const keyed = expression.elements.some((element) => element.key);
    if (keyed) {
      for (const element of expression.elements) {
        if (element.key?.kind !== 'name') {
          this.error(
            element,
            '構造体のリテラルでは、すべての要素を フィールド名: 値 の形にするか、すべてを値だけにしてください。'
          );
          continue;
        }
        const index = fields.findIndex((field) => field.name === (element.key as { name: string }).name);
        if (index === -1) {
          this.error(element.key, `${describeType(type)} 型には ${element.key.name} というフィールドがありません。`);
          continue;
        }
        if (values[index]) this.error(element, `フィールド ${element.key.name} に2回値を書いています。`);
        values[index] = this.element(element.value, fields[index].type, 'フィールド');
      }
    } else if (expression.elements.length > 0) {
      for (const [index, element] of expression.elements.entries()) {
        if (index >= fields.length) {
          this.error(element, `${describeType(type)} 型のフィールドより多くの値を書いています。`);
          break;
        }
        values[index] = this.element(element.value, fields[index].type, 'フィールド');
      }
      if (expression.elements.length < fields.length) {
        this.error({ row: expression.endRow, column: 0 }, `${describeType(type)} 型のフィールドの値が足りません。`);
      }
    }
    const zeros = fields.map((field) => this.zeroOf(field.type));
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => {
        frame.runtime.allocate(fields.length);
        const evaluated = evaluateAll(
          frame,
          values.map((value, index) => value ?? zeros[index])
        );
        return new GoStruct(evaluated);
      },
    };
  }

  private arrayLiteral(
    expression: CompositeLiteral,
    type: Type,
    under: Extract<Type, { kind: 'array' | 'slice' }>
  ): Operand {
    const entries: { index: number; value: Eval }[] = [];
    let next = 0;
    let length = 0;
    const seen = new Set<number>();
    for (const element of expression.elements) {
      if (element.key) {
        const key = this.constantExpression(element.key);
        if (key.value === undefined || key.value < 0n) {
          this.error(element.key, '配列やスライスのリテラルのキーには、0 以上の整数の定数を書いてください。');
          continue;
        }
        next = Number(key.value);
      }
      if (under.kind === 'array' && next >= under.length) {
        this.error(element, `添字 ${next} は配列の範囲の外です（長さは ${under.length} です）。`);
        break;
      }
      if (seen.has(next)) this.error(element, `添字 ${next} に2回値を書いています。`);
      seen.add(next);
      entries.push({ index: next, value: this.element(element.value, under.element, '要素') });
      next++;
      length = Math.max(length, next);
    }
    const zero = this.zeroOf(under.element);
    const size = under.kind === 'array' ? under.length : length;
    const build = (frame: Frame): Value[] => {
      frame.runtime.allocate(size);
      const values = Array.from<Value>({ length: size });
      const filled = new Set<number>();
      // The elements computed so far stay reachable while later ones run.
      frame.temporaries.push(values);
      try {
        for (const { index, value } of entries) {
          values[index] = value(frame);
          filled.add(index);
        }
      } finally {
        frame.temporaries.pop();
      }
      for (let index = 0; index < size; index++) if (!filled.has(index)) values[index] = zero();
      return values;
    };
    if (under.kind === 'array')
      return { mode: 'value', type, span: expression, eval: (frame) => new GoArray(build(frame)) };
    return { mode: 'value', type, span: expression, eval: (frame) => new Slice(build(frame), 0, size, size) };
  }

  private mapLiteral(expression: CompositeLiteral, type: Type, under: Extract<Type, { kind: 'map' }>): Operand {
    const entries: { key: Eval; value: Eval }[] = [];
    const constantKeys = new Set<unknown>();
    const keyOf = mapKeyOf(under.key);
    for (const element of expression.elements) {
      if (!element.key) {
        this.error(element, 'map のリテラルでは、要素を キー: 値 の形で書いてください。');
        continue;
      }
      const keyOperand =
        element.key.kind === 'composite' && !element.key.type ? undefined : this.expression(element.key);
      if (keyOperand?.mode === 'constant' && keyOperand.constant) {
        const representation = represent(
          keyOperand.constant,
          isInterface(under.key) ? defaultType(keyOperand.type) : under.key
        );
        if ('constant' in representation) {
          const constantKey = `${typeString(defaultType(keyOperand.type))}:${String(constantValue(representation.constant, under.key))}`;
          if (constantKeys.has(constantKey))
            this.error(element.key, `map のリテラルにキー ${describeConstant(keyOperand.constant)} が2回あります。`);
          constantKeys.add(constantKey);
        }
      }
      entries.push({
        key: keyOperand
          ? this.assign(keyOperand, under.key, 'map のキー')
          : this.element(element.key, under.key, 'map のキー'),
        value: this.element(element.value, under.value, 'map の値'),
      });
    }
    return {
      mode: 'value',
      type,
      span: expression,
      eval: (frame) => {
        const map = new GoMap(keyOf);
        frame.runtime.allocate(entries.length * 2);
        frame.temporaries.push(map);
        try {
          for (const { key, value } of entries) {
            const keyValue = key(frame);
            map.entries.set(keyOf(keyValue), { key: keyValue, value: value(frame) });
          }
        } finally {
          frame.temporaries.pop();
        }
        return map;
      },
    };
  }
}
