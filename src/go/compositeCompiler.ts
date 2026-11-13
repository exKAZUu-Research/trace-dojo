import { constantIdentityKey, represent } from './assignability';
import type { CompositeLiteral, Expression } from './ast';
import { mapKeyOf } from './equality';
import { describeConstant, ExpressionCompiler } from './expressionCompiler';
import type { Operand } from './operand';
import type { Eval, Frame } from './runtime';
import { BASIC, coreType, defaultType, describeType, isInterface, isUntyped, type Type, underlying } from './types';
import { Cell, GoArray, GoMap, GoStruct, Pointer, Slice, type Value } from './values';

/** Compiles composite literals: structs, arrays, slices, and maps, whose nested literals may elide their types. */
export abstract class CompositeCompiler extends ExpressionCompiler {
  protected composite(expression: CompositeLiteral, elided: Type | undefined): Operand {
    let type = elided;
    if (expression.type) type = this.resolveType(expression.type);
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

  // code-gauge-allow functionCognitiveComplexity 30 -- Keyed and unkeyed struct literals with Go's checks and evaluation order.
  private structLiteral(expression: CompositeLiteral, type: Type, struct: Extract<Type, { kind: 'struct' }>): Operand {
    const { fields } = struct;
    const entries: { index: number; value: Eval }[] = [];
    const seen = new Set<number>();
    const keyed = expression.elements.some((element) => element.key);
    if (keyed) {
      for (const element of expression.elements) {
        if (element.key?.kind !== 'name') {
          this.error(
            element,
            '構造体のリテラルでは、すべての要素を フィールド名: 値 の形にするか、すべてを値だけにしてください。'
          );
          if (element.key) this.expression(element.key);
          this.expression(element.value);
          continue;
        }
        const index = fields.findIndex((field) => field.name === (element.key as { name: string }).name);
        if (index === -1) {
          this.error(element.key, `${describeType(type)} 型には ${element.key.name} というフィールドがありません。`);
          this.expression(element.value);
          continue;
        }
        if (seen.has(index)) this.error(element, `フィールド ${element.key.name} に2回値を書いています。`);
        seen.add(index);
        entries.push({ index, value: this.element(element.value, fields[index].type, 'フィールド') });
      }
    } else if (expression.elements.length > 0) {
      let reportedExcess = false;
      for (const [index, element] of expression.elements.entries()) {
        if (index >= fields.length) {
          if (!reportedExcess) {
            this.error(element, `${describeType(type)} 型のフィールドより多くの値を書いています。`);
            reportedExcess = true;
          }
          this.expression(element.value);
          continue;
        }
        entries.push({ index, value: this.element(element.value, fields[index].type, 'フィールド') });
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
        const evaluated = Array.from<Value>({ length: fields.length });
        const filled = new Set<number>();
        frame.temporaries.push(evaluated);
        try {
          for (const { index, value } of entries) {
            evaluated[index] = value(frame);
            filled.add(index);
          }
        } finally {
          frame.temporaries.pop();
        }
        for (let index = 0; index < fields.length; index++) {
          if (!filled.has(index)) evaluated[index] = zeros[index]();
        }
        return new GoStruct(evaluated);
      },
    };
  }

  // code-gauge-allow functionCognitiveComplexity 25 -- Keyed and unkeyed array/slice literals with constant bounds checks.
  private arrayLiteral(
    expression: CompositeLiteral,
    type: Type,
    under: Extract<Type, { kind: 'array' | 'slice' }>
  ): Operand {
    const entries: { index: number; value: Eval }[] = [];
    let next = 0;
    let length = 0;
    const seen = new Set<number>();
    let reportedOutOfRange = false;
    for (const element of expression.elements) {
      if (element.key) {
        const key = this.constantExpression(element.key);
        if (key.value === undefined || key.value < 0n) {
          this.error(element.key, '配列やスライスのリテラルのキーには、0 以上の整数の定数を書いてください。');
          this.expression(element.value);
          continue;
        }
        next = Number(key.value);
      }
      if (under.kind === 'array' && next >= under.length) {
        if (!reportedOutOfRange) {
          this.error(element, `添字 ${next} は配列の範囲の外です（長さは ${under.length} です）。`);
          reportedOutOfRange = true;
        }
        this.element(element.value, under.element, '要素');
        next++;
        continue;
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
    const constantKeys = new Set<string>();
    const keyOf = mapKeyOf(under.key);
    for (const element of expression.elements) {
      if (!element.key) {
        this.error(element, 'map のリテラルでは、要素を キー: 値 の形で書いてください。');
        this.element(element.value, under.value, 'map の値');
        continue;
      }
      const keyOperand =
        element.key.kind === 'composite' && !element.key.type ? undefined : this.expression(element.key);
      if (keyOperand?.mode === 'constant' && keyOperand.constant) {
        const concreteType = isInterface(under.key)
          ? isUntyped(keyOperand.type)
            ? defaultType(keyOperand.type)
            : keyOperand.type
          : under.key;
        const representation = represent(keyOperand.constant, concreteType);
        if ('constant' in representation) {
          const constantKey = constantIdentityKey(representation.constant, concreteType);
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
