import { binaryOperation, complement, convertScalar, negate } from '../c/arith';
import type { BinaryOperator } from '../c/ast';
import { fma } from '../c/library/binaryFloat';
import { commonType, promote } from '../c/types';
import { CompileError } from '../interpreter/diagnostics';
import { byteAt } from './bytes';
import { isAuto } from './compilerBase';
import { type ConversionSequence, convertArithmetic, implicitConversion, Rank, sequence } from './conversions';
import { CppRuntimeError } from './errors';
import { constantExpr, type Expr, type FunctionCandidates } from './expr';
import { checkLiteralPrefix, literalBytes, numberLiteral } from './literals';
import { makeEach, ObjectCompiler, zeroOf } from './objectCompiler';
import type { Eval, Frame } from './runtime';
import type { Entity } from './scopes';
import { fieldOf, type Syntax, tokenOf } from './syntax';
import {
  type ArithmeticType,
  BOOL,
  CHAR,
  type ClassInfo,
  classType,
  type FieldInfo,
  type FunctionInfo,
  INT,
  isArithmetic,
  isConstType,
  isCopyConstructor,
  isInteger,
  isWide,
  LONG,
  nonReference,
  NULLPTR,
  pointerTo,
  PTRDIFF_T,
  sameType,
  SIZE_T,
  sizeOf,
  type Type,
  typeName,
  unqualified,
  withConst,
} from './types';
import { ArrayStore, Box, CObject, FunctionRef, Liveness, NULL_PTR, Ptr, type Store, type Value } from './values';

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/** Compiles expressions to closures that evaluate them. */
export abstract class ExpressionCompiler extends ObjectCompiler {
  /** The storage of the string literals by their bytes, which identical literals share as clang++ merges them. */
  private readonly literalStores = new Map<string, Box>();

  compileExpression(node: Syntax): Expr {
    switch (node.type) {
      case 'number_literal': {
        // The grammar reads a sign before a number as part of the literal; C++ reads it as a unary operator.
        const sign = /^[+-]/.exec(node.text)?.[0];
        if (sign) {
          const operand = this.compileExpression({ ...node, text: node.text.slice(1).trimStart() });
          return this.unary(sign, operand, node.row);
        }
        const { type, value } = numberLiteral(node);
        const expr = constantExpr(type, value, node.row);
        if (value === 0 || value === 0n) expr.isNullConstant = isInteger(type);
        return expr;
      }
      case 'char_literal': {
        return this.charLiteral(node);
      }
      case 'string_literal':
      case 'concatenated_string': {
        return this.stringLiteral(node);
      }
      case 'true':
      case 'false': {
        return constantExpr(BOOL, node.type === 'true' ? 1 : 0, node.row);
      }
      case 'null': {
        // libc++ on macOS defines NULL as `__null`, an integer null pointer constant of type long.
        if (node.text === 'NULL') return { ...constantExpr(LONG, 0n, node.row), isNullConstant: true };
        return { type: NULLPTR, isLvalue: false, row: node.row, run: () => NULL_PTR, isNullConstant: true };
      }
      case 'identifier': {
        return this.identifier(node);
      }
      case 'qualified_identifier': {
        return this.entityExpr(this.lookupQualified(node), node, true);
      }
      case 'template_function': {
        return this.templateFunction(node);
      }
      case 'this': {
        return this.thisExpr(node.row);
      }
      case 'parenthesized_expression': {
        const inner = node.children[0];
        if (!inner) return this.error(node.row, '括弧の中に式を書いてください。');
        const expr = this.compileExpression(inner);
        return expr.functions ? expr : { ...expr };
      }
      case 'field_expression': {
        return this.fieldExpression(node);
      }
      case 'call_expression': {
        return this.callExpression(node);
      }
      case 'binary_expression': {
        return this.binaryExpression(node);
      }
      case 'unary_expression': {
        return this.unaryExpression(node);
      }
      case 'update_expression': {
        return this.updateExpression(node);
      }
      case 'pointer_expression': {
        return this.pointerExpression(node);
      }
      case 'assignment_expression': {
        return this.assignmentExpression(node);
      }
      case 'conditional_expression': {
        return this.conditionalExpression(node);
      }
      case 'comma_expression': {
        return this.commaExpression(node);
      }
      case 'subscript_expression': {
        return this.subscriptExpression(node);
      }
      case 'cast_expression': {
        const type = this.typeDescriptor(fieldOf(node, 'type') as Syntax);
        return this.explicitConversion(this.compileExpression(fieldOf(node, 'value') as Syntax), type, node.row, 'C');
      }
      case 'named_cast_expression': {
        return this.namedCast(node);
      }
      case 'sizeof_expression': {
        return this.sizeofExpression(node);
      }
      case 'new_expression': {
        return this.newExpression(node);
      }
      case 'delete_expression': {
        return this.deleteExpression(node);
      }
      case 'compound_literal_expression': {
        return this.bracedCast(node);
      }
      case 'initializer_list': {
        return this.error(node.row, '{...} は、この場所では値として使えません。');
      }
      case 'throw_statement': {
        return this.error(node.row, 'throw を式の中に書くことは、この採点環境ではできません。');
      }
      default: {
        return this.error(node.row, `${node.text} は式として使えません。`);
      }
    }
  }

  // Literals ---------------------------------------------------------------------------------------------------------

  private charLiteral(node: Syntax): Expr {
    checkLiteralPrefix(node);
    const bytes = literalBytes(node.children);
    if (bytes.length === 1) {
      const code = byteAt(bytes);
      return constantExpr(CHAR, code >= 128 ? code - 256 : code, node.row);
    }
    if ([...bytes].some((byte) => byteAt(byte) >= 128) || bytes.length > 4) {
      return this.error(
        node.row,
        `文字リテラル ${node.text} は1文字（1バイト）に収まりません。std::string か文字列リテラルを使ってください。`
      );
    }
    if (bytes.length === 0) return this.error(node.row, "空の文字リテラル '' は書けません。");
    let value = 0;
    for (const byte of bytes) value = (value << 8) | byteAt(byte);
    return constantExpr(INT, value, node.row);
  }

  private stringLiteral(node: Syntax): Expr {
    const parts = node.type === 'concatenated_string' ? node.children : [node];
    let bytes = '';
    for (const part of parts) {
      if (part.type !== 'string_literal') return this.unsupported(part.row, '生の文字列リテラル（R"(...)"）');
      checkLiteralPrefix(part);
      bytes += literalBytes(part.children);
    }
    let box = this.literalStores.get(bytes);
    if (!box) {
      const store = new ArrayStore([...bytes, '\0'].map((byte) => signedByte(byteAt(byte))));
      store.isLiteral = true;
      box = new Box(store);
      this.literalStores.set(bytes, box);
    }
    const location = new Ptr(box, 0);
    return {
      type: { kind: 'array', of: withConst(CHAR), length: bytes.length + 1 },
      isLvalue: true,
      row: node.row,
      run: () => location,
      literalBytes: bytes,
    };
  }

  // Names -----------------------------------------------------------------------------------------------------------

  private identifier(node: Syntax): Expr {
    const entity = this.findName(node.text);
    if (!entity) return this.entityExpr(this.lookupName(node.text, node.row), node, false);
    return this.entityExpr(entity, node, false);
  }

  /** The expression a name denotes; `isQualified` for `C::name`, which never takes `this` implicitly. */
  entityExpr(entity: Entity, node: Syntax, isQualified: boolean): Expr {
    const { row } = node;
    const name = node.type === 'qualified_identifier' ? (fieldOf(node, 'name') as Syntax).text : node.text;
    switch (entity.kind) {
      case 'local': {
        const { slot, type } = entity.local;
        const constant = entity.constant;
        if (entity.isReference) {
          return { type: nonReference(type), isLvalue: true, row, run: (frame) => frame.slots[slot] as Ptr };
        }
        return {
          type,
          isLvalue: true,
          row,
          constant,
          run: (frame) => {
            const store = frame.slots[slot];
            if (!store) throw new CppRuntimeError('uninitialized');
            return new Ptr(store as Store, 0);
          },
        };
      }
      case 'global': {
        const { index, type } = entity.global;
        if (entity.isReference) {
          return {
            type: nonReference(type),
            isLvalue: true,
            row,
            run: (frame) => (frame.runtime.globals[index] as Box).value as Ptr,
          };
        }
        return {
          type,
          isLvalue: true,
          row,
          constant: entity.constant,
          run: (frame) => new Ptr(frame.runtime.globals[index], 0),
        };
      }
      case 'field': {
        if (isQualified && !this.context.cls)
          return this.error(row, `メンバ変数 ${name} を使うには、オブジェクトが要ります。`);
        const { field } = entity;
        const object = this.implicitThis(row, name);
        this.checkAccess(field.access, field.owner, this.namingClass(node, field.owner), row, name, this.context.cls);
        return this.fieldAccess(object, field, row);
      }
      case 'staticField': {
        const { field } = entity;
        this.checkAccess(field.access, field.owner, this.namingClass(node, field.owner), row, name);
        const global = field.global;
        if (!global) return this.error(row, `static のメンバ変数 ${field.owner.name}::${name} が定義されていません。`);
        return this.entityExpr({ kind: 'global', global, isReference: false, constant: field.constant }, node, true);
      }
      case 'functions': {
        const members = entity.functions.filter((fn) => fn.owner && !fn.isStatic);
        const object = members.length > 0 && !this.context.isStaticContext ? this.implicitThis(row, name) : undefined;
        const owner = entity.functions.find((fn) => fn.owner && !fn.native)?.owner;
        const namingClass = owner && this.namingClass(node, owner);
        const functions: FunctionCandidates = { name, candidates: entity.functions, object, isQualified, namingClass };
        return {
          type: { kind: 'void' },
          isLvalue: false,
          row,
          run: () => new FunctionRef(entity.functions),
          functions,
        };
      }
      case 'value': {
        return entity.make(row);
      }
      case 'class':
      case 'type':
      case 'template': {
        return this.error(row, `${node.text} は型の名前なので、値としては使えません。`);
      }
      case 'namespace': {
        return this.error(row, `${node.text} は名前空間の名前なので、値としては使えません。`);
      }
      case 'ambiguous': {
        return this.error(row, `${name} が、自分で宣言したものと std::${name} のどちらを指すのか決まりません。`);
      }
      case 'unsupported': {
        return this.unsupported(row, entity.feature);
      }
    }
  }

  /** The class a member's name was looked up in: `C` of `C::name`, else the class of the code compiled now. */
  private namingClass(node: Syntax, owner: ClassInfo): ClassInfo {
    const scope = node.type === 'qualified_identifier' ? fieldOf(node, 'scope') : undefined;
    if (!scope) return this.enclosingClass ?? owner;
    const resolved = this.resolveScope(scope);
    return resolved.kind === 'class' ? resolved.cls : owner;
  }

  private templateFunction(node: Syntax): Expr {
    const nameNode = fieldOf(node, 'name') as Syntax;
    const entity =
      nameNode.type === 'qualified_identifier'
        ? this.lookupQualified(nameNode)
        : this.lookupName(nameNode.text, node.row);
    const templateArgs = this.templateArguments(fieldOf(node, 'arguments') as Syntax);
    if (entity.kind !== 'functions') return this.error(node.row, `${nameNode.text} は関数テンプレートではありません。`);
    const expr = this.entityExpr(entity, nameNode, nameNode.type === 'qualified_identifier');
    return { ...expr, functions: { ...(expr.functions as FunctionCandidates), templateArgs } };
  }

  /** `this` as the object it points to, for a member a member function names without `this->`. */
  private implicitThis(row: number, name: string): Expr {
    if (this.context.isStaticContext || !this.context.cls) {
      return this.error(row, `static のメンバ関数（または関数）の中では、メンバ ${name} は使えません。`);
    }
    const cls = this.context.cls;
    const isConst = this.context.isConstMember;
    return {
      type: classType(cls, isConst),
      isLvalue: true,
      row,
      run: (frame) => thisLocation(frame),
    };
  }

  private thisExpr(row: number): Expr {
    if (this.context.isStaticContext || !this.context.cls) {
      return this.error(row, 'this は、static でないメンバ関数の中でしか使えません。');
    }
    const type = pointerTo(classType(this.context.cls, this.context.isConstMember));
    return { type, isLvalue: false, row, run: (frame) => thisLocation(frame) };
  }

  // Members -------------------------------------------------------------------------------------------------------

  private fieldExpression(node: Syntax): Expr {
    const isArrow = tokenOf(node, ['->', '.']) === '->';
    const argument = this.compileExpression(fieldOf(node, 'argument') as Syntax);
    const object = isArrow ? this.arrow(argument, node.row) : argument;
    const fieldNode = fieldOf(node, 'field') as Syntax;
    if (fieldNode.type === 'destructor_name') return this.unsupported(node.row, 'デストラクタの明示的な呼び出し');
    if (fieldNode.type === 'qualified_identifier') return this.qualifiedMember(object, fieldNode);
    return this.member(object, fieldNode.text, node.row);
  }

  /** The object `p->` designates: what a pointer points to, or what an iterator's `->` gives. */
  arrow(pointer: Expr, row: number): Expr {
    const type = pointer.type;
    if (type.kind === 'class' && type.cls.library?.operator) {
      const result = type.cls.library.operator(this, '->', [pointer], row);
      if (result) return result;
    }
    if (type.kind !== 'pointer' || type.to.kind !== 'class') {
      return this.error(row, `-> の左には、クラスのオブジェクトを指すポインタを書いてください（${typeName(type)}）。`);
    }
    return this.dereference(this.rvalue(pointer), row);
  }

  private qualifiedMember(object: Expr, node: Syntax): Expr {
    if (object.type.kind !== 'class') return this.error(node.row, `${typeName(object.type)} にはメンバがありません。`);
    const scope = this.resolveScope(fieldOf(node, 'scope') as Syntax);
    if (scope.kind !== 'class' || !object.type.cls.isDerivedFrom(scope.cls)) {
      return this.error(node.row, `${node.text} は ${typeName(object.type)} のメンバではありません。`);
    }
    const name = (fieldOf(node, 'name') as Syntax).text;
    const expr = this.member(object, name, node.row, scope.cls);
    return expr.functions ? { ...expr, functions: { ...expr.functions, isQualified: true } } : expr;
  }

  /**
   * The member `name` of an object, looked up in its class or in `naming`, a base of it that a qualified name names: a
   * data member as an lvalue, or member functions to call.
   */
  member(object: Expr, name: string, row: number, naming?: ClassInfo): Expr {
    const type = object.type;
    if (type.kind !== 'class') {
      return this.error(
        row,
        `${typeName(type)} 型の値にはメンバ ${name} がありません（. の左にはクラスのオブジェクトを書いてください）。`
      );
    }
    const cls = naming ?? type.cls;
    for (let owner: ClassInfo | undefined = cls; owner; owner = owner.base) {
      const field = owner.ownFields.find((candidate) => candidate.name === name);
      if (field) {
        this.checkAccess(field.access, owner, cls, row, name, type.cls);
        return this.fieldAccess(object, field, row);
      }
      const methods = owner.methods.get(name);
      if (methods) {
        return {
          type: { kind: 'void' },
          isLvalue: false,
          row,
          run: () => new FunctionRef(methods),
          functions: { name, candidates: methods, object, namingClass: cls },
        };
      }
      const constant = owner.constants.get(name);
      if (constant) return constant(row);
      const staticField = owner.staticFields.get(name);
      if (staticField) {
        this.checkAccess(staticField.access, owner, cls, row, name);
        if (!staticField.global)
          return this.error(row, `static のメンバ変数 ${owner.name}::${name} が定義されていません。`);
        const index = staticField.global.index;
        return {
          type: staticField.type,
          isLvalue: true,
          row,
          run: (frame) => new Ptr(frame.runtime.globals[index], 0),
        };
      }
    }
    if (cls.library?.constructingMembers?.includes(name)) {
      return {
        type: { kind: 'void' },
        isLvalue: false,
        row,
        run: () => {},
        functions: { name, candidates: [], object },
      };
    }
    return this.error(row, `${cls.name} に ${name} というメンバはありません。`);
  }

  /** The data member of an object, as an lvalue that is const when the object is. */
  fieldAccess(object: Expr, field: FieldInfo, row: number): Expr {
    const { index } = field;
    const type = isConstType(object.type) ? withConst(field.type) : field.type;
    if (field.type.kind === 'reference') {
      const objectRun = this.objectOf(object);
      return {
        type: field.type.to,
        isLvalue: true,
        row,
        run: (frame) => (objectRun(frame).read() as CObject).get(index) as unknown as Ptr,
      };
    }
    if (object.isLvalue) {
      const { run } = object;
      return {
        type,
        isLvalue: true,
        row,
        run: (frame) => {
          const target = (run(frame) as Ptr).read();
          return new Ptr(target as CObject, index);
        },
        description: field.name,
        temporaryMember: object.temporaryMember && {
          object: object.temporaryMember.object,
          path: [...object.temporaryMember.path, index],
        },
      };
    }
    // A member of a prvalue is an xvalue, which the interpreter treats as a temporary's member.
    const materialized = this.materialize(object).run;
    return {
      type,
      isLvalue: true,
      row,
      run: (frame) => new Ptr((materialized(frame) as Ptr).read() as CObject, index),
      temporaryMember: { object, path: [index] },
    };
  }

  // Operators ---------------------------------------------------------------------------------------------------------

  private binaryExpression(node: Syntax): Expr {
    const operator =
      tokenOf(node, [
        ...ARITHMETIC_OPERATORS,
        ...COMPARISONS,
        '&&',
        '||',
        '<=>',
        'and',
        'or',
        'bitand',
        'bitor',
        'xor',
        'not_eq',
      ]) ?? '';
    const normalized = ALTERNATIVE_TOKENS[operator] ?? operator;
    if (normalized === '<=>') return this.unsupported(node.row, '三方比較演算子（<=>）');
    const left = this.compileExpression(fieldOf(node, 'left') as Syntax);
    const right = this.compileExpression(fieldOf(node, 'right') as Syntax);
    return this.binary(normalized, left, right, node.row);
  }

  /** Compiles a binary operator on two compiled operands. */
  binary(operator: string, left: Expr, right: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator(operator, [left, right], row);
    if (libraryResult) return libraryResult;
    if (operator === '&&' || operator === '||') return this.logical(operator, left, right, row);
    for (const operand of [left, right]) {
      if (operand.type.kind === 'class') {
        return this.error(
          row,
          `演算子 ${operator} は ${typeName(left.type)} と ${typeName(right.type)} には使えません。`
        );
      }
      if (operand.type.kind === 'void') return this.error(row, '値を返さない関数（void）の結果は使えません。');
      if (operand.functions)
        return this.error(row, `関数 ${operand.functions.name} の後に (...) を書いて呼び出してください。`);
    }
    const leftValue = this.rvalue(left);
    const rightValue = this.rvalue(right);
    const lt = leftValue.type;
    const rt = rightValue.type;
    if (isArithmetic(lt) && isArithmetic(rt)) return this.arithmetic(operator, leftValue, rightValue, row);
    return this.pointerOperation(operator, leftValue, rightValue, row);
  }

  /** The library's operator for operands that include an object of a library class, if it has one. */
  libraryOperator(operator: string, operands: Expr[], row: number): Expr | undefined {
    for (const operand of operands) {
      const { type } = operand;
      if (type.kind === 'class' && type.cls.library?.operator) {
        const result = type.cls.library.operator(this, operator, operands, row);
        if (result) return result;
      }
    }
    return undefined;
  }

  private logical(operator: '&&' | '||', left: Expr, right: Expr, row: number): Expr {
    const a = this.condition(left, row);
    const b = this.condition(right, row);
    const run: Eval<Value> =
      operator === '&&' ? (frame) => (a(frame) && b(frame) ? 1 : 0) : (frame) => (a(frame) || b(frame) ? 1 : 0);
    const expr: Expr = { type: BOOL, isLvalue: false, row, run };
    const lc = this.rvalue(left).constant;
    const rc = this.rvalue(right).constant;
    if (lc !== undefined && rc !== undefined) {
      expr.constant = (operator === '&&' ? Number(lc) !== 0 && Number(rc) !== 0 : Number(lc) !== 0 || Number(rc) !== 0)
        ? 1
        : 0;
    }
    return expr;
  }

  /** An arithmetic operator on two arithmetic prvalues, after the usual arithmetic conversions. */
  arithmetic(operator: string, left: Expr, right: Expr, row: number): Expr {
    const lt = left.type as ArithmeticType;
    const rt = right.type as ArithmeticType;
    if (['%', '<<', '>>', '&', '|', '^'].includes(operator) && (!isInteger(lt) || !isInteger(rt))) {
      return this.error(row, `演算子 ${operator} は整数どうしでしか使えません（${typeName(lt)} と ${typeName(rt)}）。`);
    }
    if (operator === '<<' || operator === '>>') return this.shift(operator, left, right, row);
    const common = commonType(unqualified(lt) as never, unqualified(rt) as never) as ArithmeticType;
    const a = convertArithmetic(left, common);
    const b = convertArithmetic(right, common);
    const operation = binaryOperation(operator as BinaryOperator, common as never);
    const isComparison = COMPARISONS.has(operator);
    const resultType = isComparison ? BOOL : common;
    const aRun = a.run;
    const bRun = b.run;
    const expr: Expr = {
      type: resultType,
      isLvalue: false,
      row,
      run: (frame) => operation(aRun(frame) as number, bRun(frame) as number),
    };
    if (a.constant !== undefined && b.constant !== undefined) {
      try {
        const constant = operation(a.constant, b.constant);
        expr.constant = constant;
        expr.run = () => constant;
      } catch {
        // An operation that fails (such as dividing by zero) is no constant; it stops the program when it runs.
      }
      return expr;
    }
    if (common.kind === 'float') this.contract(operator, expr, a, b, common.name === 'float');
    return expr;
  }

  /**
   * Fuses a product into the addition or subtraction that uses it, as Apple clang does by default
   * (`-ffp-contract=on`): `a * b + c` rounds once, like `std::fma(a, b, c)`. When both operands are products, the
   * left one is fused. A product of constants is folded before, so it is not fused.
   */
  private contract(operator: string, expr: Expr, a: Expr, b: Expr, isFloat: boolean): void {
    if (operator === '*') {
      expr.product = { left: a.run as Eval<number>, right: b.run as Eval<number> };
      return;
    }
    if (operator !== '+' && operator !== '-') return;
    const sign = operator === '+' ? 1 : -1;
    if (a.product) {
      const { left, right } = a.product;
      const addend = b.run as Eval<number>;
      expr.run = (frame) => fma(left(frame), right(frame), sign * addend(frame), isFloat);
    } else if (b.product) {
      const { left, right } = b.product;
      const addend = a.run as Eval<number>;
      expr.run = (frame) => fma(sign * left(frame), right(frame), addend(frame), isFloat);
    }
  }

  private shift(operator: '<<' | '>>', left: Expr, right: Expr, row: number): Expr {
    const type = promote(unqualified(left.type) as never) as Extract<Type, { kind: 'int' }>;
    const a = convertArithmetic(left, type).run;
    const b = this.rvalue(right).run;
    const wide = isWide(type);
    const signed = type.name === 'int' || type.name === 'long' || type.name === 'llong';
    const bits = wide ? 64 : 32;
    const shift = (value: number | bigint, count: number | bigint): number | bigint => {
      const amount = Number(count);
      if (amount < 0 || amount >= bits) throw new CppRuntimeError('shiftCount');
      if (wide) {
        const big = value as bigint;
        const result = operator === '<<' ? big << BigInt(amount) : big >> BigInt(amount);
        return signed ? BigInt.asIntN(64, result) : BigInt.asUintN(64, result);
      }
      const small = value as number;
      if (operator === '<<') return signed ? small << amount : (small << amount) >>> 0;
      return signed ? small >> amount : small >>> amount;
    };
    const expr: Expr = { type, isLvalue: false, row, run: (frame) => shift(a(frame) as number, b(frame) as number) };
    const lc = convertArithmetic(left, type).constant;
    const rc = this.rvalue(right).constant;
    if (lc !== undefined && rc !== undefined) {
      try {
        expr.constant = shift(lc, rc);
      } catch {
        // A shift out of range is no constant.
      }
    }
    return expr;
  }

  private pointerOperation(operator: string, left: Expr, right: Expr, row: number): Expr {
    const lt = left.type;
    const rt = right.type;
    if ((operator === '+' || operator === '-') && lt.kind === 'pointer' && isInteger(rt)) {
      return this.pointerOffset(left, right, operator === '+' ? 1 : -1, row);
    }
    if (operator === '+' && isInteger(lt) && rt.kind === 'pointer') return this.pointerOffset(right, left, 1, row);
    if (operator === '-' && lt.kind === 'pointer' && rt.kind === 'pointer') {
      if (!sameType(unqualified(lt.to), unqualified(rt.to), false)) {
        return this.error(row, `違う型を指すポインタ（${typeName(lt)} と ${typeName(rt)}）の差は求められません。`);
      }
      const a = left.run;
      const b = right.run;
      return {
        type: PTRDIFF_T,
        isLvalue: false,
        row,
        run: (frame) => {
          const p = a(frame) as Ptr;
          const q = b(frame) as Ptr;
          if (p.store !== q.store) throw new CppRuntimeError('pointerDifference');
          return BigInt(p.index - q.index);
        },
      };
    }
    if (COMPARISONS.has(operator) && (isPointerLike(lt) || isPointerLike(rt))) {
      const comparable =
        (isPointerLike(lt) && isPointerLike(rt) && this.pointersComparable(lt, rt)) ||
        (isPointerLike(lt) && right.isNullConstant) ||
        (isPointerLike(rt) && left.isNullConstant);
      if (!comparable) return this.error(row, `${typeName(lt)} と ${typeName(rt)} は比べられません。`);
      if (operator !== '==' && operator !== '!=' && (left.isNullConstant || right.isNullConstant)) {
        return this.error(row, `ポインタと nullptr の大小は比べられません。`);
      }
      const a = left.run;
      const b = right.run;
      return {
        type: BOOL,
        isLvalue: false,
        row,
        run: (frame) => comparePointers(operator, asPointer(a(frame)), asPointer(b(frame))),
      };
    }
    return this.error(row, `演算子 ${operator} は ${typeName(lt)} と ${typeName(rt)} には使えません。`);
  }

  private pointersComparable(a: Type, b: Type): boolean {
    if (a.kind === 'nullptr' || b.kind === 'nullptr') return true;
    if (a.kind !== 'pointer' || b.kind !== 'pointer') return false;
    if (a.to.kind === 'void' || b.to.kind === 'void') return true;
    if (sameType(unqualified(a.to), unqualified(b.to), false)) return true;
    return (
      a.to.kind === 'class' &&
      b.to.kind === 'class' &&
      (a.to.cls.isDerivedFrom(b.to.cls) || b.to.cls.isDerivedFrom(a.to.cls))
    );
  }

  /** A pointer moved by a number of elements, which must stay within its array or one past its end. */
  pointerOffset(pointer: Expr, offset: Expr, sign: 1 | -1, row: number): Expr {
    const type = pointer.type as Extract<Type, { kind: 'pointer' }>;
    if (type.to.kind === 'void') return this.error(row, 'void * のポインタは足し引きできません。');
    const p = pointer.run;
    const n = convertArithmetic(this.rvalue(offset), LONG).run;
    return {
      type,
      isLvalue: false,
      row,
      run: (frame) => (p(frame) as Ptr).offset(sign * Number(n(frame))),
    };
  }

  private unaryExpression(node: Syntax): Expr {
    const operator = tokenOf(node, ['-', '+', '!', '~', 'not', 'compl']) ?? '';
    const operand = this.compileExpression(fieldOf(node, 'argument') as Syntax);
    return this.unary(ALTERNATIVE_TOKENS[operator] ?? operator, operand, node.row);
  }

  unary(operator: string, operand: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator(operator, [operand], row);
    if (libraryResult) return libraryResult;
    if (operator === '!') {
      const condition = this.condition(operand, row);
      const expr: Expr = { type: BOOL, isLvalue: false, row, run: (frame) => (condition(frame) ? 0 : 1) };
      const constant = this.rvalue(operand).constant;
      if (constant !== undefined) expr.constant = Number(constant) === 0 ? 1 : 0;
      return expr;
    }
    const value = this.rvalue(operand);
    const type = value.type;
    if (operator === '+' && type.kind === 'pointer') return value;
    if (!isArithmetic(type) || (operator === '~' && !isInteger(type))) {
      return this.error(row, `演算子 ${operator} は ${typeName(type)} には使えません。`);
    }
    const promoted = isInteger(type)
      ? (promote(unqualified(type) as never) as ArithmeticType)
      : (unqualified(type) as ArithmeticType);
    const converted = convertArithmetic(value, promoted);
    if (operator === '+') return { ...converted, isLvalue: false };
    const operation = operator === '-' ? negate(promoted as never) : complement(promoted as never);
    const run = converted.run;
    const expr: Expr = { type: promoted, isLvalue: false, row, run: (frame) => operation(run(frame) as number) };
    // A negated product still fuses into an addition (`-(a * b) + c`).
    if (operator === '-' && converted.product && converted.constant === undefined) {
      const { left, right } = converted.product;
      expr.product = { left: (frame) => -left(frame), right };
    }
    if (converted.constant !== undefined) {
      try {
        expr.constant = operation(converted.constant);
      } catch {
        // Overflow is no constant.
      }
    }
    return expr;
  }

  private updateExpression(node: Syntax): Expr {
    const operator = tokenOf(node, ['++', '--']) as '++' | '--';
    const argumentNode = fieldOf(node, 'argument') as Syntax;
    const isPrefix = node.all[0]?.type === operator;
    const target = this.compileExpression(argumentNode);
    return this.increment(target, operator, isPrefix, node.row);
  }

  increment(target: Expr, operator: '++' | '--', isPrefix: boolean, row: number): Expr {
    const libraryResult = this.libraryOperator(isPrefix ? operator : `x${operator}`, [target], row);
    if (libraryResult) return libraryResult;
    this.checkAssignable(target, row, operator);
    const type = target.type;
    const delta = operator === '++' ? 1 : -1;
    let step: (value: Value) => Value;
    if (type.kind === 'pointer') {
      step = (value) => (value as Ptr).offset(delta);
    } else if (isArithmetic(type)) {
      if (type.kind === 'int' && type.name === 'bool')
        return this.error(row, `bool の変数には ${operator} を使えません（C++17 から）。`);
      const common = commonType(unqualified(type) as never, INT as never) as ArithmeticType;
      const add = binaryOperation('+', common as never);
      const one = common.kind === 'int' && isWide(common) ? BigInt(delta) : delta;
      const target_ = unqualified(type);
      step = (value) =>
        convertScalar(
          add(convertScalar(value as number, target_ as never, common as never), one),
          common as never,
          target_ as never
        );
    } else {
      return this.error(row, `${typeName(type)} には ${operator} を使えません。`);
    }
    const location = target.run;
    if (isPrefix) {
      return {
        type,
        isLvalue: true,
        row,
        run: (frame) => {
          const place = location(frame) as Ptr;
          place.write(step(place.read()));
          return place;
        },
      };
    }
    return {
      type: unqualified(type),
      isLvalue: false,
      row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        const old = place.read();
        place.write(step(old));
        return old;
      },
    };
  }

  private pointerExpression(node: Syntax): Expr {
    const operator = tokenOf(node, ['*', '&']);
    const operand = this.compileExpression(fieldOf(node, 'argument') as Syntax);
    if (operator === '&') return this.addressOf(operand, node.row);
    return this.dereferenceOperator(operand, node.row);
  }

  dereferenceOperator(operand: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator('*', [operand], row);
    if (libraryResult) return libraryResult;
    const value = this.rvalue(operand);
    if (value.type.kind !== 'pointer')
      return this.error(row, `* はポインタにしか使えません（${typeName(value.type)}）。`);
    return this.dereference(value, row);
  }

  /** The object a pointer prvalue points to, as an lvalue. */
  dereference(pointer: Expr, row: number): Expr {
    const type = (pointer.type as Extract<Type, { kind: 'pointer' }>).to;
    if (type.kind === 'void') return this.error(row, 'void * のポインタの指す先は読めません。');
    const run = pointer.run;
    return {
      type,
      isLvalue: true,
      row,
      run: (frame) => {
        const location = run(frame) as Ptr;
        location.target();
        return location;
      },
    };
  }

  addressOf(operand: Expr, row: number): Expr {
    if (operand.functions) return this.unsupported(row, '関数ポインタ');
    if (!operand.isLvalue) return this.error(row, '& は、変数などの場所を持つ値（左辺値）にしか使えません。');
    if (operand.type.kind === 'class' && operand.type.cls.library?.operator) {
      const result = operand.type.cls.library.operator(this, '&', [operand], row);
      if (result) return result;
    }
    return { type: pointerTo(operand.type), isLvalue: false, row, run: operand.run };
  }

  private assignmentExpression(node: Syntax): Expr {
    const operator =
      tokenOf(node, ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', 'and_eq', 'or_eq', 'xor_eq']) ??
      '=';
    const normalized = ALTERNATIVE_TOKENS[operator] ?? operator;
    const target = this.compileExpression(fieldOf(node, 'left') as Syntax);
    const rightNode = fieldOf(node, 'right') as Syntax;
    if (rightNode.type === 'initializer_list') {
      const isStringAppend =
        normalized === '+=' && target.type.kind === 'class' && target.type.cls.library?.kind === 'string';
      if (normalized !== '=' && !isStringAppend)
        return this.error(node.row, `${normalized} の右に {...} は書けません。`);
      return this.assignList(normalized, target, rightNode);
    }
    const source = this.compileExpression(rightNode);
    return this.assign(normalized, target, source, node.row);
  }

  /** Compiles `target = source` or a compound assignment. */
  assign(operator: string, target: Expr, source: Expr, row: number): Expr {
    if (target.type.kind === 'class') {
      const libraryResult = this.libraryOperator(operator, [target, source], row);
      if (libraryResult) return libraryResult;
      if (operator !== '=') return this.error(row, `演算子 ${operator} は ${typeName(target.type)} には使えません。`);
      return this.assignObject(target, source, row);
    }
    this.checkAssignable(target, row, operator);
    const location = target.run;
    if (operator === '=') {
      if (target.type.kind === 'array') return this.error(row, '配列にはまとめて代入できません。');
      const value = this.convert(source, unqualified(target.type), row).run;
      // C++17 sequences the right operand of an assignment before the left one.
      return {
        type: target.type,
        isLvalue: true,
        row,
        run: (frame) => {
          const result = value(frame);
          const place = location(frame) as Ptr;
          place.write(result as Value);
          return place;
        },
      };
    }
    const binaryOperator = operator.slice(0, -1);
    const current: Expr = {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) => frame.pending.at(-1) as unknown as Ptr,
    };
    // C++17 sequences the right operand of a compound assignment before the left one, too; an object of class
    // type stays where it is for its conversion function.
    const right = source.type.kind === 'class' ? undefined : this.rvalue(source);
    const operand: Expr = right ? { ...right, run: (frame) => frame.pending.at(-2) as Value } : source;
    const combined = this.binary(binaryOperator, current, operand, row);
    const value = this.convert(combined, unqualified(target.type), row).run;
    const evaluateRight = right?.run;
    return {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const mark = frame.pending.length;
        let place: Ptr;
        let result: Value | Ptr;
        try {
          frame.pending.push(evaluateRight ? (evaluateRight(frame) as Value) : undefined);
          place = location(frame) as Ptr;
          frame.pending.push(place);
          result = value(frame);
        } finally {
          frame.pending.length = mark;
        }
        place.write(result as Value);
        return place;
      },
    };
  }

  private assignObject(target: Expr, source: Expr, row: number): Expr {
    this.checkAssignable(target, row, '=');
    const cls = (target.type as Extract<Type, { kind: 'class' }>).cls;
    if (cls.isNoncopyable || cls.isAssignmentDeleted)
      return this.error(row, `${cls.name} のオブジェクトには代入できません（代入演算子が削除されています）。`);
    const value = this.convert(source, { kind: 'reference', to: classType(cls, true) }, row).run;
    const location = target.run;
    return {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        const object = place.read();
        const from = (value(frame) as Ptr).read();
        const replacement = cls.operations?.assign(frame, object, from);
        if (replacement !== undefined) place.write(replacement);
        return place;
      },
    };
  }

  private assignList(operator: string, target: Expr, list: Syntax): Expr {
    const type = unqualified(target.type);
    if (type.kind === 'array') return this.error(list.row, '配列にはまとめて代入できません。');
    const value = this.listInitializer(type, list, list.row);
    const source: Expr = { type, isLvalue: false, row: list.row, run: value, isTemporaryObject: type.kind === 'class' };
    return this.assign(operator, target, source, list.row);
  }

  /** Stops at an assignment to something that cannot be assigned: a const object, or a value without storage. */
  checkAssignable(target: Expr, row: number, operator: string): void {
    if (!target.isLvalue)
      return this.error(row, `${operator} の左には、変数などの代入できるもの（左辺値）を書いてください。`);
    if (isConstType(target.type)) {
      const what = target.description ? `const のメンバ ${target.description}` : 'const の変数（または const の値）';
      this.error(row, `${what}には代入できません。`);
    }
  }

  private conditionalExpression(node: Syntax): Expr {
    const condition = this.condition(this.compileExpression(fieldOf(node, 'condition') as Syntax), node.row);
    const consequenceNode = fieldOf(node, 'consequence');
    if (!consequenceNode) return this.unsupported(node.row, '条件演算子の省略形（x ?: y）');
    const a = this.compileExpression(consequenceNode);
    const b = this.compileExpression(fieldOf(node, 'alternative') as Syntax);
    const { left, right, type, isLvalue } = this.conditionalOperands(a, b, node.row);
    return {
      type,
      isLvalue,
      row: node.row,
      run: (frame) => (condition(frame) ? left.run(frame) : right.run(frame)),
      isTemporaryObject: !isLvalue && type.kind === 'class',
    };
  }

  private conditionalOperands(
    a: Expr,
    b: Expr,
    row: number
  ): { left: Expr; right: Expr; type: Type; isLvalue: boolean } {
    if (a.isLvalue && b.isLvalue && sameType(a.type, b.type))
      return { left: a, right: b, type: a.type, isLvalue: true };
    if (a.type.kind === 'void' && b.type.kind === 'void') return { left: a, right: b, type: a.type, isLvalue: false };
    const av = this.rvalue(a);
    const bv = this.rvalue(b);
    // Operands of the same type keep it, without the usual arithmetic conversions (C++20 [expr.cond]).
    if (av.type.kind !== 'class' && sameType(av.type, bv.type, false))
      return { left: av, right: bv, type: unqualified(av.type), isLvalue: false };
    if (isArithmetic(av.type) && isArithmetic(bv.type)) {
      const common = commonType(unqualified(av.type) as never, unqualified(bv.type) as never) as ArithmeticType;
      return {
        left: convertArithmetic(av, common),
        right: convertArithmetic(bv, common),
        type: common,
        isLvalue: false,
      };
    }
    if (av.type.kind === 'class' && bv.type.kind === 'class' && av.type.cls === bv.type.cls) {
      const type = classType(av.type.cls);
      return { left: this.convert(a, type, row), right: this.convert(b, type, row), type, isLvalue: false };
    }
    for (const [x, y] of [
      [av, bv],
      [bv, av],
    ] as const) {
      if (x.type.kind === 'pointer' && (y.isNullConstant || y.type.kind === 'pointer')) {
        const type = x.type;
        const ok = y.isNullConstant || sameType(unqualified((y.type as typeof type).to), unqualified(type.to), false);
        if (ok) {
          const left = x === av ? av : this.convert(av, type, row);
          const right = x === bv ? bv : this.convert(bv, type, row);
          return { left, right, type, isLvalue: false };
        }
      }
    }
    if (av.type.kind === 'class' || bv.type.kind === 'class') {
      for (const target of [av.type, bv.type]) {
        if (target.kind !== 'class') continue;
        try {
          return {
            left: this.convert(a, target, row),
            right: this.convert(b, target, row),
            type: target,
            isLvalue: false,
          };
        } catch {
          // Try converting to the other operand's type.
        }
      }
    }
    return this.error(row, `条件演算子の2つの値の型（${typeName(a.type)} と ${typeName(b.type)}）が合いません。`);
  }

  private commaExpression(node: Syntax): Expr {
    const left = this.compileExpression(fieldOf(node, 'left') as Syntax);
    const right = this.compileExpression(fieldOf(node, 'right') as Syntax);
    const first = left.run;
    const second = right.run;
    return { ...right, constant: undefined, run: (frame) => (first(frame), second(frame)) };
  }

  private subscriptExpression(node: Syntax): Expr {
    const array = this.compileExpression(fieldOf(node, 'argument') as Syntax);
    const indices = (fieldOf(node, 'indices') as Syntax).children;
    if (indices.length !== 1) return this.error(node.row, '[] の中には式を1つだけ書いてください。');
    if (indices[0].type === 'initializer_list') return this.error(node.row, '[] の中に {...} は書けません。');
    const index = this.compileExpression(indices[0]);
    return this.subscript(array, index, node.row);
  }

  subscript(array: Expr, index: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator('[]', [array, index], row);
    if (libraryResult) return libraryResult;
    let pointer = this.rvalue(array);
    let offset = this.rvalue(index);
    if (isInteger(pointer.type) && offset.type.kind === 'pointer') [pointer, offset] = [offset, pointer];
    if (pointer.type.kind !== 'pointer') {
      return this.error(row, `[] は配列やポインタ、std::vector などにしか使えません（${typeName(array.type)}）。`);
    }
    if (!isInteger(offset.type))
      return this.error(row, `配列の添字には整数を書いてください（${typeName(offset.type)}）。`);
    const p = pointer.run;
    const n = convertArithmetic(offset, LONG).run;
    const type = (pointer.type as Extract<Type, { kind: 'pointer' }>).to;
    return {
      type,
      isLvalue: true,
      row,
      run: (frame) => {
        const base = p(frame) as Ptr;
        const at = base.index + Number(n(frame));
        const store = base.target();
        if (at < 0 || at >= store.length) throw new CppRuntimeError('outOfBounds');
        return new Ptr(store, at);
      },
    };
  }

  // Conversions -----------------------------------------------------------------------------------------------------

  /** Converts a value to `bool` as a condition does (contextual conversion). */
  condition(expr: Expr, row: number): Eval<boolean> {
    const value = this.rvalue(expr);
    const type = value.type;
    const run = value.run;
    if (isArithmetic(type))
      return (frame) => {
        const v = run(frame);
        return v !== 0 && v !== 0n;
      };
    if (type.kind === 'pointer' || type.kind === 'nullptr') return (frame) => !(run(frame) as Ptr).isNull;
    if (type.kind === 'class' && type.cls.library?.operator) {
      const result = type.cls.library.operator(this, 'bool', [expr], row);
      if (result) {
        const test = result.run;
        return (frame) => test(frame) !== 0;
      }
    }
    if (type.kind === 'void') return this.error(row, '値を返さない関数（void）の結果は条件に使えません。');
    if (expr.functions) return this.error(row, `関数 ${expr.functions.name} の後に (...) を書いて呼び出してください。`);
    return this.error(row, `${typeName(type)} 型の値は条件に使えません。`);
  }

  /** An explicit conversion: `static_cast`, a C-style cast (`kind` 'C'), or a functional cast `T(x)`. */
  explicitConversion(expr: Expr, type: Type, row: number, kind: 'static' | 'C'): Expr {
    if (type.kind === 'void') {
      const run = expr.run;
      return { type, isLvalue: false, row, run: (frame) => (run(frame), undefined), onlyCalls: expr.onlyCalls };
    }
    if (type.kind === 'reference') return this.convert(expr, type, row);
    const value = this.rvalue(expr);
    if (isArithmetic(type) && isArithmetic(value.type))
      return convertArithmetic(value, unqualified(type) as ArithmeticType);
    if (type.kind === 'pointer' && value.type.kind === 'pointer') {
      const from = value.type.to;
      const to = type.to;
      const related =
        sameType(unqualified(from), unqualified(to), false) ||
        to.kind === 'void' ||
        from.kind === 'void' ||
        (from.kind === 'class' &&
          to.kind === 'class' &&
          (from.cls.isDerivedFrom(to.cls) || to.cls.isDerivedFrom(from.cls)));
      if (!related)
        return this.unsupported(
          row,
          kind === 'C' ? '関係のない型のポインタへのキャスト（reinterpret_cast にあたる）' : 'reinterpret_cast'
        );
      if (isConstType(from) && !isConstType(to)) return this.unsupported(row, 'const を外すキャスト（const_cast）');
      return { ...value, type };
    }
    if (
      isArithmetic(type) &&
      (value.type.kind === 'pointer' || value.type.kind === 'nullptr') &&
      !(type.kind === 'int' && type.name === 'bool')
    ) {
      return this.unsupported(row, 'ポインタから整数へのキャスト（reinterpret_cast にあたる）');
    }
    if (type.kind === 'pointer' && isInteger(value.type) && !value.isNullConstant) {
      return this.unsupported(row, '整数からポインタへのキャスト（reinterpret_cast にあたる）');
    }
    if (
      type.kind === 'class' &&
      expr.type.kind === 'class' &&
      type.cls !== expr.type.cls &&
      type.cls.isDerivedFrom(expr.type.cls)
    ) {
      return this.error(row, `${typeName(expr.type)} を ${typeName(type)} には変換できません。`);
    }
    if (type.kind === 'class') return this.constructObject(type.cls, [expr], row, false);
    return this.convert(expr, unqualified(type), row);
  }

  private namedCast(node: Syntax): Expr {
    const keyword = node.all.find((child) => !child.isNamed && child.type.endsWith('_cast'))?.type;
    if (keyword !== 'static_cast') return this.unsupported(node.row, keyword ?? 'キャスト');
    const type = this.typeDescriptor(fieldOf(node, 'type') as Syntax);
    return this.explicitConversion(this.compileExpression(fieldOf(node, 'value') as Syntax), type, node.row, 'static');
  }

  private sizeofExpression(node: Syntax): Expr {
    if (node.all.some((child) => child.type === '...')) return this.unsupported(node.row, 'sizeof...');
    const typeNode = fieldOf(node, 'type');
    let type: Type;
    if (typeNode) type = this.typeDescriptor(typeNode);
    else {
      const value = fieldOf(node, 'value') as Syntax;
      type = this.typeOfUnevaluated(value);
    }
    if (type.kind === 'function') return this.error(node.row, '関数には sizeof を使えません。');
    if (type.kind === 'array' && type.length === undefined)
      return this.error(node.row, '大きさの決まっていない配列には sizeof を使えません。');
    return constantExpr(SIZE_T, BigInt(sizeOf(type)), node.row);
  }

  /** The type of an expression that is not evaluated, as the operand of `sizeof`. */
  private typeOfUnevaluated(node: Syntax): Type {
    const target = node.type === 'parenthesized_expression' && node.children[0] ? node.children[0] : node;
    if (target.type === 'identifier' || target.type === 'type_identifier') {
      const entity = this.findName(target.text);
      if (entity?.kind === 'class') return classType(entity.cls);
      if (entity?.kind === 'type') return entity.type;
    }
    return this.compileExpression(node).type;
  }

  /** `T{...}`, a braced functional cast, which list-initializes a prvalue. */
  private bracedCast(node: Syntax): Expr {
    const typeNode = fieldOf(node, 'type') as Syntax;
    if (typeNode.type === 'type_descriptor') return this.unsupported(node.row, '複合リテラル（(型){...}）');
    const type = this.resolveTypeSpecifier(typeNode);
    const run = this.listInitializer(type, fieldOf(node, 'value') as Syntax, node.row);
    return {
      type,
      isLvalue: false,
      row: node.row,
      run,
      onlyCalls: type.kind === 'class',
      isTemporaryObject: type.kind === 'class',
    };
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  private callExpression(node: Syntax): Expr {
    const functionNode = fieldOf(node, 'function') as Syntax;
    const argsNode = fieldOf(node, 'arguments') as Syntax;
    const argNodes = argsNode.children;
    const typeTarget = this.callTypeTarget(functionNode);
    if (typeTarget) {
      if (argNodes.length === 1 && typeTarget.kind !== 'class') {
        return this.explicitConversion(this.compileExpression(argNodes[0]), typeTarget, node.row, 'C');
      }
      if (typeTarget.kind !== 'class') {
        if (argNodes.length === 0) return this.valueInitialized(typeTarget, node.row);
        return this.error(node.row, `${typeName(typeTarget)}(...) には値を1つだけ書いてください。`);
      }
      const args = argNodes.map((arg) => this.argument(arg));
      return this.constructObject(typeTarget.cls, args, node.row, false);
    }
    const callee = this.compileExpression(functionNode);
    const args = argNodes.map((arg) => this.argument(arg));
    return this.callWith(callee, args, node.row, functionNode.type === 'identifier');
  }

  /** The type a call's function names, when the call is a functional cast `T(...)` rather than a function call. */
  private callTypeTarget(node: Syntax): Type | undefined {
    if (node.type === 'primitive_type' || node.type === 'sized_type_specifier' || node.type === 'template_type') {
      return this.resolveTypeSpecifier(node);
    }
    if (node.type === 'template_function') {
      const name = fieldOf(node, 'name') as Syntax;
      const entity = name.type === 'qualified_identifier' ? this.lookupQualified(name) : this.findName(name.text);
      if (entity?.kind === 'template') {
        const args = this.templateArguments(fieldOf(node, 'arguments') as Syntax);
        return entity.template.instantiate(args, node.row);
      }
      return undefined;
    }
    if (node.type !== 'identifier' && node.type !== 'qualified_identifier' && node.type !== 'type_identifier')
      return undefined;
    const entity = node.type === 'qualified_identifier' ? this.lookupQualified(node) : this.findName(node.text);
    if (entity?.kind === 'class') return classType(entity.cls);
    if (entity?.kind === 'type') return entity.type;
    if (entity?.kind === 'template') {
      const nameNode = node.type === 'qualified_identifier' ? fieldOf(node, 'name') : undefined;
      const argumentList = nameNode ? fieldOf(nameNode, 'arguments') : undefined;
      if (argumentList) return entity.template.instantiate(this.templateArguments(argumentList), node.row);
      return this.error(node.row, `${node.text} には <...> でテンプレート引数を書いてください。`);
    }
    return undefined;
  }

  /** An argument of a call, which may be a braced list only for parameters whose type the call decides. */
  argument(node: Syntax): Expr {
    if (node.type === 'initializer_list') {
      return { type: { kind: 'void' }, isLvalue: false, row: node.row, run: () => {}, braced: node };
    }
    return this.compileExpression(node);
  }

  /** Calls what an expression denotes: functions, or a library function object. */
  callWith(callee: Expr, args: Expr[], row: number, isUnqualifiedName = false): Expr {
    const candidates = callee.functions;
    const object = candidates?.object;
    if (candidates && object?.type.kind === 'class' && object.type.cls.library?.memberCall && !candidates.isQualified) {
      const result = object.type.cls.library.memberCall(this, object, candidates.name, args, row);
      if (result) return result;
    }
    if (!candidates) {
      if (callee.type.kind === 'class' && callee.type.cls.library?.call) {
        const result = callee.type.cls.library.call(this, callee, args, row);
        if (result) return result;
      }
      return this.error(row, `${typeName(callee.type)} 型の値は関数として呼び出せません。`);
    }
    let functions = candidates.candidates;
    if (isUnqualifiedName && !candidates.object)
      functions = this.withArgumentDependentLookup(candidates.name, functions, args);
    const resolved = this.resolve(`関数 ${candidates.name}`, functions, args, object, row, candidates.templateArgs);
    if (resolved.fn.owner && !resolved.fn.isStatic && !object) {
      return this.error(row, `メンバ関数 ${resolved.fn.displayName} を呼ぶには、オブジェクトが要ります。`);
    }
    const { owner } = resolved.fn;
    if (owner && !resolved.fn.native && candidates.namingClass) {
      const objectClass = !resolved.fn.isStatic && object?.type.kind === 'class' ? object.type.cls : undefined;
      this.checkAccess(resolved.fn.access, owner, candidates.namingClass, row, resolved.fn.name, objectClass);
    }
    if (resolved.fn.isPure && candidates.isQualified) {
      return this.error(row, `純粋仮想関数 ${resolved.fn.displayName} は、名前を指定して呼び出せません。`);
    }
    this.checkDefined(resolved.fn, row);
    return this.callExpr(resolved, args, object, row, candidates.isQualified === true);
  }

  /** Adds the library's functions an unqualified call finds through its arguments' types (C++20 [basic.lookup.argdep]). */
  protected abstract withArgumentDependentLookup(name: string, functions: FunctionInfo[], args: Expr[]): FunctionInfo[];

  /** Records that a call uses a function, which the program must define (else the linker rejects it). */
  protected abstract checkDefined(fn: FunctionInfo, row: number): void;

  bracedConversion(list: Syntax, to: Type): ConversionSequence | undefined {
    if (to.kind === 'reference' && !isConstType(to.to)) return undefined;
    const type = unqualified(nonReference(to));
    let run: Eval<Value>;
    try {
      run = this.listInitializer(type, list, list.row);
    } catch (error) {
      if (error instanceof CompileError) return undefined;
      throw error;
    }
    let rank: Rank = type.kind === 'class' ? Rank.UserDefined : Rank.Exact;
    if (type.kind !== 'class' && list.children.length === 1 && list.children[0].type !== 'initializer_list') {
      rank = implicitConversion(this, this.compileExpression(list.children[0]), type)?.rank ?? Rank.Conversion;
    }
    const value: Expr = { type, isLvalue: false, row: list.row, run, isTemporaryObject: type.kind === 'class' };
    return sequence(rank, () => (to.kind === 'reference' ? this.materialize(value) : value));
  }

  /** A prvalue object of a class made from constructor arguments, or by aggregate initialization when braced. */
  constructObject(cls: ClassInfo, args: Expr[], row: number, isBraced: boolean): Expr {
    if (args.length === 1 && args[0].type.kind === 'class' && args[0].type.cls.isDerivedFrom(cls) && !isBraced) {
      const source = args[0];
      if (source.type.kind === 'class' && source.type.cls === cls && source.isTemporaryObject) return source;
      if (cls.constructors.every((ctor) => ctor.native !== undefined || !isCopyConstructor(ctor, cls)))
        return this.copyObject(source, cls);
    }
    if (cls.constructors.length === 0 && !cls.library) {
      if (args.length === 0) return this.defaultConstructed(cls, row, true);
      return this.error(
        row,
        `${cls.name} には、引数（${args.map((arg) => typeName(arg.type)).join(', ')}）をとるコンストラクタがありません。`
      );
    }
    const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, args, undefined, row);
    if (!resolved.fn.native) this.checkAccess(resolved.fn.access, cls, cls, row, `${cls.name} のコンストラクタ`);
    return this.constructWith(cls, resolved, args, row);
  }

  /** A default-initialized object of a class: its default constructor's, or an implicit one's. */
  abstract defaultConstructed(cls: ClassInfo, row: number, isValueInitialized: boolean): Expr;

  /** A value-initialized prvalue of a type, as `T()` makes. */
  valueInitialized(type: Type, row: number): Expr {
    if (type.kind === 'class') return this.defaultConstructed(type.cls, row, true);
    if (type.kind === 'void') return { type, isLvalue: false, row, run: () => {} };
    const zero = zeroOf(type);
    return {
      type: unqualified(type),
      isLvalue: false,
      row,
      run: () => zero,
      constant: typeof zero === 'object' ? undefined : (zero as number),
    };
  }

  /** Compiles a braced initializer list for an object of a type, as list-initialization does. */
  abstract listInitializer(type: Type, list: Syntax, row: number): Eval<Value>;

  // new and delete ---------------------------------------------------------------------------------------------------

  private newExpression(node: Syntax): Expr {
    if (fieldOf(node, 'placement')) return this.unsupported(node.row, '配置 new（new (場所) 型）');
    let baseType = this.resolveTypeSpecifier(fieldOf(node, 'type') as Syntax);
    let declarator = fieldOf(node, 'declarator');
    for (; declarator?.type === 'abstract_pointer_declarator'; declarator = fieldOf(declarator, 'declarator'))
      baseType = pointerTo(baseType);
    const argsNode = fieldOf(node, 'arguments');
    if (declarator) {
      const lengths: Syntax[] = [];
      for (
        let current: Syntax | undefined = declarator;
        current;
        current = current.children.find((child) => child.type === 'new_declarator')
      ) {
        lengths.push(fieldOf(current, 'length') as Syntax);
      }
      let elementType = baseType;
      for (const length of lengths.slice(1).toReversed())
        elementType = { kind: 'array', of: elementType, length: this.arrayLength(length) };
      return this.newArray(elementType, lengths[0], argsNode, node.row);
    }
    if (baseType.kind === 'void') return this.error(node.row, 'void のオブジェクトは new で作れません。');
    const type = unqualified(baseType);
    let value: Eval<Value>;
    if (!argsNode) value = this.defaultInitializer(type, node.row);
    else if (argsNode.type === 'initializer_list') value = this.listInitializer(type, argsNode, node.row);
    else {
      const args = argsNode.children.map((arg) => this.argument(arg));
      if (type.kind === 'class') value = this.constructObject(type.cls, args, node.row, false).run as Eval<Value>;
      else if (args.length === 0) value = this.valueInitialized(type, node.row).run as Eval<Value>;
      else if (args.length === 1) value = this.convert(args[0], type, node.row).run as Eval<Value>;
      else return this.error(node.row, `new ${typeName(type)}(...) には値を1つだけ書いてください。`);
    }
    return {
      type: pointerTo(baseType),
      isLvalue: false,
      row: node.row,
      onlyCalls: type.kind === 'class',
      run: (frame) => {
        frame.runtime.reserve(type.kind === 'class' ? Math.max(type.cls.fields.length, 1) : 1);
        const box = new Box(value(frame));
        box.allocation = 'new';
        return new Ptr(box, 0);
      },
    };
  }

  private newArray(elementType: Type, lengthNode: Syntax, argsNode: Syntax | undefined, row: number): Expr {
    const lengthExpr = this.rvalue(this.compileExpression(lengthNode));
    if (!isInteger(lengthExpr.type))
      return this.error(row, `new[] の要素の数には整数を書いてください（${typeName(lengthExpr.type)}）。`);
    const length = convertArithmetic(lengthExpr, LONG).run;
    // C++20 initializes the elements from parentheses as from braces, except for narrowing (C++20 [dcl.init.general]).
    const initial = (argsNode?.children ?? []).map((child) =>
      argsNode?.type === 'initializer_list'
        ? this.elementInitializer(elementType, child)
        : this.copyInitializer(elementType, this.compileExpression(child), child.row, false)
    );
    // The elements without initializers need a default constructor only when some may exist.
    const hasRest = lengthExpr.constant === undefined || Number(lengthExpr.constant) > initial.length;
    const rest = hasRest
      ? argsNode
        ? (this.valueInitialized(elementType, row).run as Eval<Value>)
        : this.defaultInitializer(elementType, row)
      : undefined;
    const destroy = this.destroyerOf(elementType);
    return {
      type: pointerTo(elementType),
      isLvalue: false,
      row,
      run: (frame) => {
        const count = Number(length(frame));
        if (count < 0 || count < initial.length) throw new CppRuntimeError('badLength');
        frame.runtime.reserve(count);
        const make = (index: number): Value =>
          index < initial.length ? initial[index](frame) : (rest as Eval<Value>)(frame);
        const store = new ArrayStore(makeEach(frame, count, make, () => destroy));
        store.allocation = 'newArray';
        return new Ptr(store, 0);
      },
    };
  }

  /** The value of one element of a braced list, which may itself be a braced list. */
  elementInitializer(type: Type, node: Syntax): Eval<Value> {
    if (node.type === 'initializer_list') return this.listInitializer(type, node, node.row);
    return this.copyInitializer(type, this.compileExpression(node), node.row, true);
  }

  /** The value copy-initialization gives an object of a type; `isList` checks for narrowing conversions. */
  abstract copyInitializer(type: Type, expr: Expr, row: number, isList: boolean): Eval<Value>;

  /** The value default-initialization gives an object of a type. */
  abstract defaultInitializer(type: Type, row: number): Eval<Value>;

  private deleteExpression(node: Syntax): Expr {
    const isArray = node.all.some((child) => child.type === '[');
    const operand = this.rvalue(this.compileExpression(node.children[0]));
    if (operand.type.kind !== 'pointer')
      return this.error(node.row, `delete にはポインタを書いてください（${typeName(operand.type)}）。`);
    const pointee = operand.type.to;
    const cls = pointee.kind === 'class' ? pointee.cls : undefined;
    const destroyStatic = this.destroyerOf(pointee, node.row);
    const hasVirtualDestructor = cls?.destructor?.isVirtual === true;
    const run = operand.run;
    const exec = (frame: Frame): Value => {
      const pointer = run(frame) as Ptr;
      if (pointer.isNull) return undefined;
      const store = pointer.store as Store;
      if (store.liveness === Liveness.Deleted) throw new CppRuntimeError('doubleDelete');
      store.checkAlive();
      if (store.allocation !== (isArray ? 'newArray' : 'new') || pointer.index !== 0)
        throw new CppRuntimeError('invalidDelete');
      if (isArray) {
        const values = (store as ArrayStore).values;
        if (destroyStatic) for (let index = values.length - 1; index >= 0; index--) destroyStatic(frame, values[index]);
      } else {
        const object = (store as Box).value;
        const destroy =
          hasVirtualDestructor && object instanceof CObject ? object.cls.operations?.destroy : destroyStatic;
        destroy?.(frame, object);
      }
      store.liveness = Liveness.Deleted;
      return undefined;
    };
    return { type: { kind: 'void' }, isLvalue: false, row: node.row, run: exec, onlyCalls: true };
  }

  /** The type of an `auto` variable, deduced from its initializer as a function template parameter would be. */
  deduceAuto(declared: Type, init: Expr, row: number): Type {
    if (!isAuto(declared)) return declared;
    if (init.functions) return this.unsupported(row, '関数ポインタ');
    if (init.type.kind === 'void')
      return this.error(row, 'auto の変数の初期値に、値を返さない関数（void）の結果は使えません。');
    const decayed = init.type.kind === 'array' ? pointerTo(init.type.of) : unqualified(init.type);
    return isConstType(declared) ? withConst(decayed) : decayed;
  }

  /** The type `auto&` or `const auto&` refers to. */
  deduceAutoReference(declared: Type, init: Expr): Type {
    if (!isAuto(declared)) return declared;
    return isConstType(declared) ? withConst(unqualified(init.type)) : init.type;
  }
}

const isPointerLike = (type: Type): boolean => type.kind === 'pointer' || type.kind === 'nullptr';

const asPointer = (value: unknown): Ptr => (value instanceof Ptr ? value : NULL_PTR);

const ALTERNATIVE_TOKENS: Record<string, string> = {
  and: '&&',
  or: '||',
  not: '!',
  bitand: '&',
  bitor: '|',
  xor: '^',
  compl: '~',
  not_eq: '!=',
  and_eq: '&=',
  or_eq: '|=',
  xor_eq: '^=',
};

function signedByte(code: number): number {
  return code >= 128 ? code - 256 : code;
}

/** The location of the object a member function runs for. */
function thisLocation(frame: Frame): Ptr {
  return frame.self as Ptr;
}

function comparePointers(operator: string, a: Ptr, b: Ptr): number {
  if (operator === '==') return a.equals(b) ? 1 : 0;
  if (operator === '!=') return a.equals(b) ? 0 : 1;
  if (a.store !== b.store) throw new CppRuntimeError('pointerComparison');
  switch (operator) {
    case '<': {
      return a.index < b.index ? 1 : 0;
    }
    case '<=': {
      return a.index <= b.index ? 1 : 0;
    }
    case '>': {
      return a.index > b.index ? 1 : 0;
    }
    default: {
      return a.index >= b.index ? 1 : 0;
    }
  }
}
