import { constantIdentityKey, represent } from './assignability';
import type { CompositeLiteral, Expression } from './ast';
import { always, type VarEntity } from './entities';
import { mapKeyOf } from './equality';
import { describeConstant, ExpressionCompiler } from './expressionCompiler';
import type { Operand, SsaFacts, SsaFields } from './operand';
import { type Eval, type Frame, withTemporary } from './runtime';
import {
  BASIC,
  coreType,
  defaultType,
  describeType,
  isForeignUnexported,
  isInterface,
  isUntyped,
  lookupFieldOrMethod,
  type Type,
  underlying,
} from './types';
import { Cell, GoArray, GoMap, GoStruct, Pointer, Slice, type Value } from './values';

/** A field a struct literal leaves out, which holds the zero value: a constant. */
const ZERO_FIELD: SsaFacts = { ssaConstant: always };

/** Compiles composite literals: structs, arrays, slices, and maps, whose nested literals may elide their types. */
export abstract class CompositeCompiler extends ExpressionCompiler {
  // code-gauge-allow functionNcss 46 -- Compiles literal elements together with their destination type and storage lifetime.
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
    // The elements share what happens to the literal, as Go's escape analysis lets them flow where the literal goes.
    const holder = this.hiddenVariable();
    let operand: Operand;
    switch (under.kind) {
      case 'struct': {
        operand = this.structLiteral(expression, literalType, under, holder);
        break;
      }
      case 'array': {
        operand = this.arrayLiteral(expression, literalType, under, holder);
        break;
      }
      case 'slice': {
        const outer = this.inAllocatedSlice;
        this.inAllocatedSlice = true;
        try {
          operand = this.arrayLiteral(expression, literalType, under, holder);
        } finally {
          this.inAllocatedSlice = outer;
        }
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
    const holds = holder.escapeSources !== undefined || holder.temporaries !== undefined;
    const backingVars = holds ? [holder] : undefined;
    if (!pointerElided) return { ...operand, backingVars, createsObject: true };
    const read = operand.eval;
    return {
      mode: 'value',
      type,
      span: expression,
      backingVars,
      createsObject: true,
      eval: (frame) => new Pointer(new Cell(read(frame)), 'v'),
    };
  }

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

  /**
   * An element of a composite literal, whose own literal may elide its type; `holder` stands for the literal, or is
   * absent for an element that escapes, as a map's does.
   */
  private element(
    expression: Expression,
    type: Type,
    context: string,
    holder?: VarEntity,
    onFacts?: (facts: SsaFacts) => void
  ): Eval {
    if (expression.kind === 'composite' && !expression.type) {
      const literal = this.composite(expression, type);
      onFacts?.(literal);
      return this.assign(literal, type, context, holder);
    }
    if (
      expression.kind === 'unary' &&
      expression.operator === '&' &&
      expression.operand.kind === 'composite' &&
      !expression.operand.type
    ) {
      const pointer = underlying(type);
      if (pointer.kind === 'pointer') {
        const literal = this.composite(expression.operand, pointer.element);
        if (holder) this.recordLocalEscapeAlias(literal, holder);
        else this.escapeOperand(literal);
        const read = literal.eval;
        return (frame) => new Pointer(new Cell(read(frame)), 'v');
      }
    }
    const operand = this.expression(expression);
    onFacts?.(operand);
    return this.assign(operand, type, context, holder);
  }

  private structLiteral(
    expression: CompositeLiteral,
    type: Type,
    struct: Extract<Type, { kind: 'struct' }>,
    holder: VarEntity
  ): Operand {
    const { fields } = struct;
    const entries: { path: number[]; value: Eval }[] = [];
    const seenPaths: number[][] = [];
    const lookupTarget = type.kind === 'typeParam' ? struct : type;
    const keyed = expression.elements.some((element) => element.key);
    const fieldFacts: SsaFields = fields.map(() => ZERO_FIELD);
    const constantAt = (path: number[]): ((facts: SsaFacts) => void) => {
      if (path.length > 0) fieldFacts[path[0]] = undefined;
      return ({ ssaConstant, ssaFields }) => {
        if (path.length === 1) fieldFacts[path[0]] = { ssaConstant, ssaFields };
      };
    };
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
        const selection = lookupFieldOrMethod(lookupTarget, element.key.name);
        if (selection.kind === 'ambiguous') {
          this.error(element.key, `${element.key.name} は埋め込んだ複数の型にあるので、どれか決められません。`);
          this.expression(element.value);
          continue;
        }
        if (selection.kind !== 'field') {
          this.error(element.key, `${describeType(type)} 型には ${element.key.name} というフィールドがありません。`);
          this.expression(element.value);
          continue;
        }
        if (isForeignUnexported(element.key.name, selection.pkg)) {
          this.error(
            element.key,
            `${element.key.name} は ${selection.pkg} パッケージの外から使えないフィールドです（大文字で始まる名前だけを使えます）。`
          );
          this.expression(element.value);
          continue;
        }
        if (selection.indirect) {
          this.error(
            element.key,
            `ポインタで埋め込んだフィールドを通るので、複合リテラルでは ${element.key.name} を直接指定できません。`
          );
          this.expression(element.value);
          continue;
        }
        const conflict = seenPaths.find((previous) => pathsOverlap(previous, selection.path));
        if (conflict) {
          this.error(
            element,
            conflict.length === selection.path.length
              ? `フィールド ${element.key.name} に2回値を書いています。`
              : '埋め込んだ構造体のフィールドと昇格したフィールドを同じリテラルで同時には指定できません。'
          );
        } else {
          seenPaths.push(selection.path);
        }
        entries.push({
          path: selection.path,
          value: this.element(element.value, selection.type, 'フィールド', holder, constantAt(selection.path)),
        });
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
        const fieldName = fields[index].name;
        if (type.kind === 'named' && isForeignUnexported(fieldName, type.pkg)) {
          this.error(
            element,
            `${fieldName} は ${type.pkg} パッケージの外から使えないフィールドなので、値を書けません。`
          );
        }
        // Go evaluates the value of a blank field for its effects but leaves the field zero.
        const path = fields[index].name === '_' ? [] : [index];
        const value = this.element(element.value, fields[index].type, 'フィールド', holder, constantAt(path));
        entries.push({ path, value });
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
      ssaFields: fieldFacts,
      eval: (frame) => {
        frame.runtime.allocate(fields.length);
        const evaluated = Array.from<Value>({ length: fields.length });
        const filled = new Set<number>();
        frame.temporaries.push(evaluated);
        try {
          for (const { path, value } of entries) {
            const fieldValue = value(frame);
            if (path.length === 0) continue;
            const root = path[0];
            if (path.length === 1) {
              evaluated[root] = fieldValue;
              filled.add(root);
              continue;
            }
            if (!filled.has(root)) {
              evaluated[root] = zeros[root]();
              filled.add(root);
            }
            let current = evaluated[root] as GoStruct;
            for (let step = 1; step < path.length - 1; step++) {
              current = current.fields[path[step]] as GoStruct;
            }
            current.fields[path.at(-1) as number] = fieldValue;
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

  // code-gauge-allow functionCognitiveComplexity 27 -- Compiles literal elements together with their destination type and storage lifetime.
  // code-gauge-allow functionNcss 50 -- Compiles literal elements together with their destination type and storage lifetime.
  private arrayLiteral(
    expression: CompositeLiteral,
    type: Type,
    under: Extract<Type, { kind: 'array' | 'slice' }>,
    holder: VarEntity
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
        if ('error' in represent({ kind: 'int', value: key.value }, BASIC.int)) {
          this.error(element.key, `定数 ${key.value} は int 型に収まりません。`);
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
        this.element(element.value, under.element, '要素', holder);
        next++;
        continue;
      }
      if (seen.has(next)) this.error(element, `添字 ${next} に2回値を書いています。`);
      seen.add(next);
      entries.push({ index: next, value: this.element(element.value, under.element, '要素', holder) });
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

  // code-gauge-allow functionCognitiveComplexity 27 -- Compiles literal elements together with their destination type and storage lifetime.
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
            const evaluatedValue = withTemporary(frame, keyValue, () => value(frame));
            map.entries.set(keyOf(keyValue), { key: keyValue, value: evaluatedValue });
          }
        } finally {
          frame.temporaries.pop();
        }
        return map;
      },
    };
  }
}

function pathsOverlap(a: readonly number[], b: readonly number[]): boolean {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}
