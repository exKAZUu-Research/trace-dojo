import { binaryOperation, complement, negate } from '../c/arith';
import type { BinaryOperator } from '../c/ast';
import { fma as binaryFma } from '../c/library/binaryFloat';
import { commonType, promote } from '../c/types';
import { CompileError } from '../interpreter/diagnostics';
import { arithmeticOperation, convertNumeric, type NumericValue } from './arithmetic';
import { byteAt } from './bytes';
import { hasAuto, isAuto } from './compilerBase';
import {
  classLocation,
  type ConversionSequence,
  convertArithmetic,
  implicitConversion,
  Rank,
  scalarValue,
  sequence,
} from './conversions';
import { CppRuntimeError } from './errors';
import {
  constantExpr,
  constantLocationOf,
  type Expr,
  type FunctionCandidates,
  hasConstantObject,
  type Initializer,
  mapMemberConstants,
  type MemberConstant,
  memberConstantOf,
  NO_CONSTANT_MEMBERS,
  offsetConstantLocation,
} from './expr';
import { type FloatingValue, fusedNaN, negateFloat } from './floatSign';
import { moveValue } from './library/elements';
import { throwLibrary } from './library/support';
import { checkLiteralPrefix, literalBytes, numberLiteral } from './literals';
import { constructArray, initializeAt, ObjectCompiler, zeroOf } from './objectCompiler';
import { erasePointee, recoverPointee } from './pointerCasts';
import { type Eval, type Frame, holdAll } from './runtime';
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
  type GlobalInfo,
  INT,
  isArithmetic,
  isConstType,
  isCopyConstructor,
  isInteger,
  isReferenceRelated,
  isWide,
  LONG,
  nonReference,
  NULLPTR,
  pointerTo,
  PTRDIFF_T,
  sameType,
  SIZE_T,
  sizeOf,
  type StaticFieldInfo,
  type Type,
  typeName,
  unqualified,
  withConst,
} from './types';
import {
  ArrayStore,
  Box,
  CObject,
  endLifetime,
  FunctionRef,
  holdValues,
  Liveness,
  NULL_PTR,
  Ptr,
  Store,
  type Value,
} from './values';

const RELATIONAL_OPERATORS = ['<', '<=', '>', '>='];
const COMPARISONS = new Set(['==', '!=', ...RELATIONAL_OPERATORS]);
const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

type FloatingFactors = [FloatingValue, FloatingValue];

/** Compiles expressions to closures that evaluate them. */
export abstract class ExpressionCompiler extends ObjectCompiler {
  protected isUnevaluated = false;
  /** The storage of the string literals by their bytes, which identical literals share as clang++ merges them. */
  private readonly literalStores = new Map<string, Box>();
  // A replacement evaluator must explicitly preserve factor evaluation, including any new side effects.
  private readonly floatingProducts = new WeakMap<Expr['run'], Eval<FloatingFactors>>();

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
        if (node.text === 'NULL')
          return this.library.isHeaderMacro('NULL')
            ? { ...constantExpr(LONG, 0n, node.row), isNullConstant: true }
            : this.identifier(node);
        return { type: NULLPTR, isLvalue: false, row: node.row, run: () => NULL_PTR, isNullConstant: true };
      }
      case 'identifier':
      case 'type_identifier': {
        return this.identifier(node);
      }
      case 'qualified_identifier': {
        const expr = this.entityExpr(this.lookupQualified(node), node, true);
        // `std::min<long long>` names a function template with its template arguments.
        const name = fieldOf(node, 'name') as Syntax;
        if (name.type !== 'template_function' || !expr.functions) return expr;
        const templateArgs = this.templateArguments(fieldOf(name, 'arguments') as Syntax);
        return { ...expr, functions: { ...expr.functions, templateArgs } };
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
      const store = new ArrayStore(
        [...bytes, '\0'].map((byte) => signedByte(byteAt(byte))),
        CHAR
      );
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
      staticAddress: true,
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
          const reference = entity.constantReference;
          return {
            type: nonReference(type),
            isLvalue: true,
            row,
            constant: reference?.value,
            foldedValue: reference?.foldedValue,
            constantReferenceBinding: reference !== undefined,
            constantLocation: reference?.constantLocation,
            run: (frame) => frame.slots[slot] as Ptr,
          };
        }
        if (entity.staticStorage) return this.staticStorageExpr(entity.staticStorage, row, constant);
        return {
          type,
          isLvalue: true,
          row,
          ...arithmeticVariableValue(type, constant, entity.foldedValue, entity.isConstexpr),
          constantDesignation: true,
          run: (frame) => {
            const store = frame.slots[slot];
            if (!store) throw new CppRuntimeError('uninitialized');
            return new Ptr(store as Store, 0);
          },
        };
      }
      case 'global': {
        return this.staticStorageExpr(entity.global, row, entity.constant);
      }
      case 'field': {
        const { field } = entity;
        if (this.isUnevaluated && this.context.isStaticContext) {
          this.checkAccess(field.access, field.owner, this.namingClass(node, field.owner), row, name);
          return { type: nonReference(field.type), isLvalue: true, row, run: () => {} };
        }
        if (isQualified && !this.context.cls)
          return this.error(row, `メンバ変数 ${name} を使うには、オブジェクトが要ります。`);
        const object = this.implicitThis(row, name);
        this.checkAccess(field.access, field.owner, this.namingClass(node, field.owner), row, name, this.context.cls);
        return this.fieldAccess(object, field, row);
      }
      case 'staticField': {
        const { field } = entity;
        this.checkAccess(field.access, field.owner, this.namingClass(node, field.owner), row, name);
        return this.staticMemberExpr(field, row);
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
      case 'hiddenClass':
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
      isThis: true,
      row,
      run: (frame) => thisLocation(frame),
    };
  }

  private thisExpr(row: number): Expr {
    if (this.context.isStaticContext || !this.context.cls) {
      return this.error(row, 'this は、static でないメンバ関数の中でしか使えません。');
    }
    const type = pointerTo(classType(this.context.cls, this.context.isConstMember));
    return { type, isLvalue: false, isThis: true, row, run: (frame) => thisLocation(frame) };
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
    if (!type.cls.isComplete && type.cls.library)
      return this.error(row, `クラス ${type.cls.name} はまだ定義されていません。`);
    this.checkLibraryLayout(type, row);
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
      if (constant) {
        const value = constant(row);
        const evaluateObject = this.materialize(object).run;
        return {
          ...value,
          constant: undefined,
          run: (frame) => {
            evaluateObject(frame);
            return value.run(frame);
          },
        };
      }
      const staticField = owner.staticFields.get(name);
      if (staticField) {
        this.checkAccess(staticField.access, owner, cls, row, name);
        return this.staticMemberExpr(staticField, row, object);
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

  private staticMemberExpr(field: StaticFieldInfo, row: number, object?: Expr): Expr {
    const { global, constant } = field;
    if (!global)
      return this.error(row, `static のメンバ変数 ${field.owner.name}::${field.name} が定義されていません。`);
    return this.staticStorageExpr(global, row, constant, object, () => this.requireStaticDefinition(global, row));
  }

  private staticStorageExpr(
    global: GlobalInfo,
    row: number,
    constant: number | bigint | undefined,
    object?: Expr,
    requireDefinition?: () => void
  ): Expr {
    const { type, index, constantLocation } = global;
    const isReference = type.kind === 'reference';
    const known = isReference ? global.referentConstant : constant;
    const foldedValue = global.foldedValue;
    const evaluateObject = object ? this.materialize(object).run : undefined;
    const locate = (frame: Frame): Ptr => {
      evaluateObject?.(frame);
      const box = frame.runtime.globals[index] as Box;
      return isReference ? (box.get(0) as Ptr) : new Ptr(box, 0);
    };
    return {
      type: nonReference(type),
      isLvalue: true,
      row,
      ...(isConstantObject(object) ? arithmeticVariableValue(type, known, foldedValue, global.isConstexpr) : undefined),
      staticAddress: !evaluateObject && (!isReference || global.hasStaticReferenceBinding),
      constantInitialization:
        !evaluateObject && (isReference ? hasConstantObject(constantLocation) : global.hasConstantObjectValue),
      constantLocation: evaluateObject ? undefined : constantLocation,
      constantPointerValue: !evaluateObject && global.isConstexprPointer,
      constantPointee: evaluateObject ? undefined : global.constantPointee,
      readConstant:
        evaluateObject && (known !== undefined || foldedValue !== undefined) && !Number.isNaN(known ?? foldedValue)
          ? (frame) => {
              evaluateObject(frame);
              return known ?? foldedValue;
            }
          : undefined,
      get run() {
        requireDefinition?.();
        return locate;
      },
    };
  }

  protected abstract requireStaticDefinition(global: GlobalInfo, row: number): void;

  /** The data member of an object, as an lvalue that is const when the object is. */
  fieldAccess(object: Expr, field: FieldInfo, row: number): Expr {
    const { index } = field;
    const type = isConstType(object.type) ? withConst(field.type) : field.type;
    if (field.type.kind === 'reference') {
      const objectRun = this.objectOf(object);
      return {
        type: field.type.to,
        isLvalue: true,
        memberConstant: object.isThis && isArithmetic(field.type.to) ? (members) => members.get(field) : undefined,
        row,
        run: (frame) => (objectRun(frame).read() as CObject).get(index) as unknown as Ptr,
      };
    }
    const cls = object.type.kind === 'class' ? object.type.cls : field.owner;
    const locate = (location: Ptr): Ptr => new Ptr(location.read() as CObject, index, { location, cls });
    if (object.isLvalue) {
      const { run, temporaryBinding } = object;
      return {
        type,
        isLvalue: true,
        isXvalue: object.isXvalue,
        staticAddress: object.staticAddress,
        constantInitialization: object.constantInitialization,
        constantDesignation: object.constantDesignation,
        memberConstant: object.isThis && isArithmetic(type) ? (members) => members.get(field) : undefined,
        row,
        run: (frame) => locate(run(frame) as Ptr),
        description: field.name,
        temporaryBinding: temporaryBinding && ((frame, retain) => locate(temporaryBinding(frame, retain))),
      };
    }
    const materialized = this.temporaryLocation(object);
    return {
      type,
      isLvalue: true,
      isXvalue: true,
      row,
      run: (frame) => locate(materialized(frame)),
      temporaryBinding: (frame, retain) => locate(materialized(frame, retain)),
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
    const leftNode = fieldOf(node, 'left') as Syntax;
    const left = this.compileExpression(leftNode);
    const right = this.compileExpression(fieldOf(node, 'right') as Syntax);
    if (RELATIONAL_OPERATORS.includes(normalized))
      this.checkChainedComparison(normalized, leftNode, left, right, node.row);
    return this.binary(normalized, left, right, node.row);
  }

  /** Rejects `a < b < c` as clang++ does, which makes its -Wparentheses warning for it an error. */
  private checkChainedComparison(operator: string, leftNode: Syntax, left: Expr, right: Expr, row: number): void {
    const isBuiltinComparison =
      leftNode.type === 'binary_expression' &&
      tokenOf(leftNode, RELATIONAL_OPERATORS) !== undefined &&
      left.type.kind === 'int' &&
      left.type.name === 'bool';
    if (isBuiltinComparison && right.type.kind !== 'class') {
      this.error(
        row,
        `比較を連ねた ${leftNode.text} ${operator} ... は、数学の式とは違い、${leftNode.text} の結果（bool）と比べます。&& で2つの比較をつないでください。`
      );
    }
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
    const stop = operator === '||';
    const run: Eval<Value> = (frame) => (a(frame) === stop ? Number(stop) : Number(b(frame)));
    const av = this.rvalue(left);
    const bv = this.rvalue(right);
    const constant = logicalConstant(stop, av, bv);
    const isMemberDependent = (av.memberConstant ?? bv.memberConstant) !== undefined;
    return {
      type: BOOL,
      isLvalue: false,
      row,
      run,
      constant: isMemberDependent ? undefined : constant?.(NO_CONSTANT_MEMBERS),
      memberConstant: isMemberDependent ? constant : undefined,
    };
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
    const evaluate = arithmeticOperation(operator as BinaryOperator, common);
    const aRun = a.run;
    const bRun = b.run;
    const expr: Expr = {
      type: resultType,
      isLvalue: false,
      row,
      run: (frame) =>
        frame.unsequencedOperands(aRun, bRun, (first, second) =>
          evaluate(first as NumericValue, second as NumericValue)
        ),
      memberConstant: mapMemberConstants([a, b], ([first, second]) => operation(first, second)),
    };
    const knownA = a.constant ?? a.foldedValue;
    const knownB = b.constant ?? b.foldedValue;
    if (knownA !== undefined && knownB !== undefined) {
      try {
        const constant = operation(knownA, knownB);
        if (a.constant !== undefined && b.constant !== undefined) expr.constant = constant;
        else expr.foldedValue = constant;
        if (!Number.isNaN(knownA) && !Number.isNaN(knownB)) expr.run = () => constant;
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
      this.floatingProducts.set(expr.run, (frame) =>
        frame.unsequencedOperands(a.run, b.run, (first, second) => [first as FloatingValue, second as FloatingValue])
      );
      return;
    }
    if (operator !== '+' && operator !== '-') return;
    const sign = operator === '+' ? 1 : -1;
    const first = this.floatingProducts.get(a.run);
    const second = this.floatingProducts.get(b.run);
    if (first) {
      const addend = b.run as Eval<FloatingValue>;
      expr.run = (frame) =>
        frame.unsequencedOperands(first, addend, (factors, value) => {
          const [left, right] = factors as FloatingFactors;
          return fma(left, right, sign === 1 ? (value as FloatingValue) : negateFloat(value as FloatingValue), isFloat);
        });
    } else if (second) {
      const addend = a.run as Eval<FloatingValue>;
      expr.run = (frame) =>
        frame.unsequencedOperands(addend, second, (value, factors) => {
          const [left, right] = factors as FloatingFactors;
          return fma(sign === 1 ? left : negateFloat(left), right, value as FloatingValue, isFloat);
        });
    }
  }

  private shift(operator: '<<' | '>>', left: Expr, right: Expr, row: number): Expr {
    const type = promote(unqualified(left.type) as never) as Extract<Type, { kind: 'int' }>;
    const a = convertArithmetic(left, type);
    const b = this.rvalue(right);
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
    const expr: Expr = {
      type,
      isLvalue: false,
      row,
      run: (frame) => shift(a.run(frame) as number, b.run(frame) as number),
      memberConstant: mapMemberConstants([a, b], ([value, count]) => shift(value, count)),
    };
    const lc = a.constant;
    const rc = b.constant;
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
      this.checkPointerArithmetic(lt, row);
      this.checkPointerArithmetic(rt, row);
      if (!sameType(unqualified(lt.to), unqualified(rt.to), false)) {
        return this.error(row, `違う型を指すポインタ（${typeName(lt)} と ${typeName(rt)}）の差は求められません。`);
      }
      const a = left.run;
      const b = right.run;
      return {
        type: PTRDIFF_T,
        isLvalue: false,
        row,
        run: (frame) =>
          frame.unsequencedOperands(a, b, (first, second) => {
            const p = first as Ptr;
            const q = second as Ptr;
            if (!p.sharesRange(q)) throw new CppRuntimeError('pointerDifference');
            return BigInt(p.index - q.index);
          }),
      };
    }
    if (COMPARISONS.has(operator) && (isPointerLike(lt) || isPointerLike(rt)))
      return this.pointerComparison(operator, left, right, row);
    return this.error(row, `演算子 ${operator} は ${typeName(lt)} と ${typeName(rt)} には使えません。`);
  }

  private pointerComparison(operator: string, left: Expr, right: Expr, row: number): Expr {
    const leftNull = left.type.kind === 'nullptr' || left.isNullConstant;
    const rightNull = right.type.kind === 'nullptr' || right.isNullConstant;
    const common = commonPointerType(left, right);
    if (!common && !(leftNull && rightNull))
      return this.error(row, `${typeName(left.type)} と ${typeName(right.type)} は比べられません。`);
    if (operator !== '==' && operator !== '!=' && (leftNull || rightNull)) {
      return this.error(row, `ポインタと nullptr の大小は比べられません。`);
    }
    const a = (common ? this.convert(left, common, row) : left).run;
    const b = (common ? this.convert(right, common, row) : right).run;
    return {
      type: BOOL,
      isLvalue: false,
      row,
      run: (frame) => frame.unsequencedOperands(a, b, (p, q) => comparePointers(operator, asPointer(p), asPointer(q))),
    };
  }

  /** A pointer moved by a number of elements, which must stay within its array or one past its end. */
  pointerOffset(pointer: Expr, offset: Expr, sign: 1 | -1, row: number): Expr {
    const type = pointer.type as Extract<Type, { kind: 'pointer' }>;
    this.checkPointerArithmetic(type, row);
    const p = pointer.run;
    const displacement = this.rvalue(offset);
    const n = displacement.run;
    return {
      type,
      isLvalue: false,
      staticAddress: pointer.staticAddress && displacement.constant !== undefined,
      constantPointee: offsetConstantLocation(pointer.constantPointee, displacement.constant, sign),
      row,
      run: (frame) =>
        frame.unsequencedOperands(p, n, (location, distance) => {
          const delta = distance as number | bigint;
          return (location as Ptr).offset(sign === 1 ? delta : -delta);
        }),
    };
  }

  private checkPointerArithmetic(type: Extract<Type, { kind: 'pointer' }>, row: number): void {
    let { to } = type;
    while (to.kind === 'array' && to.length !== undefined) to = to.of;
    if (
      to.kind === 'void' ||
      to.kind === 'function' ||
      to.kind === 'array' ||
      (to.kind === 'class' && !to.cls.isComplete)
    )
      this.error(row, `${typeName(type)} のポインタは足し引きできません。`);
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
      const value = this.rvalue(operand);
      expr.memberConstant = mapMemberConstants([value], ([scalar]) => (Number(scalar) === 0 ? 1 : 0));
      const constant = value.constant;
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
    const expr: Expr = {
      type: promoted,
      isLvalue: false,
      row,
      run:
        promoted.kind === 'float'
          ? (frame) => negateFloat(run(frame) as FloatingValue)
          : (frame) => operation(run(frame) as number),
      memberConstant: mapMemberConstants([converted], ([scalar]) => operation(scalar)),
    };
    // A negated product still fuses into an addition (`-(a * b) + c`).
    const factors = this.floatingProducts.get(run);
    if (operator === '-' && factors) {
      this.floatingProducts.set(expr.run, (frame) => {
        const [left, right] = factors(frame);
        return [negateFloat(left), right];
      });
    }
    const known = converted.constant ?? converted.foldedValue;
    if (known !== undefined) {
      try {
        const constant = operation(known);
        if (converted.constant !== undefined) expr.constant = constant;
        else expr.foldedValue = constant;
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

  // code-gauge-allow functionNcss 34 -- The result category and shared update depend on the same operand.
  increment(target: Expr, operator: '++' | '--', isPrefix: boolean, row: number): Expr {
    const libraryResult = this.libraryOperator(isPrefix ? operator : `x${operator}`, [target], row);
    if (libraryResult) return libraryResult;
    this.checkAssignable(target, row, operator);
    const type = target.type;
    const delta = operator === '++' ? 1 : -1;
    let step: (value: Value) => Value;
    if (type.kind === 'pointer') {
      this.checkPointerArithmetic(type, row);
      step = (value) => (value as Ptr).offset(delta);
    } else if (isArithmetic(type)) {
      if (type.kind === 'int' && type.name === 'bool')
        return this.error(row, `bool の変数には ${operator} を使えません（C++17 から）。`);
      const common = commonType(unqualified(type) as never, INT as never) as ArithmeticType;
      const add = arithmeticOperation('+', common);
      const one = common.kind === 'int' && isWide(common) ? BigInt(delta) : delta;
      const target_ = unqualified(type);
      step = (value) =>
        convertNumeric(add(convertNumeric(value as NumericValue, target_, common), one), common, target_);
    } else {
      return this.error(row, `${typeName(type)} には ${operator} を使えません。`);
    }
    const location = target.run;
    const size = sizeOf(type);
    if (isPrefix) {
      return {
        type,
        isLvalue: true,
        row,
        run: (frame) => {
          const place = location(frame) as Ptr;
          frame.writeScalar(place, size, step(frame.readScalar(place, size)));
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
        const old = frame.readScalar(place, size);
        frame.writeScalar(place, size, step(old));
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
      staticAddress: pointer.staticAddress,
      constantInitialization: hasConstantObject(pointer.constantPointee),
      constantLocation: pointer.constantPointee,
      isThis: pointer.isThis,
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
    if (!operand.isLvalue || operand.isXvalue)
      return this.error(row, '& は、変数などの場所を持つ値（左辺値）にしか使えません。');
    if (operand.type.kind === 'class' && operand.type.cls.library?.operator) {
      const result = operand.type.cls.library.operator(this, '&', [operand], row);
      if (result) return result;
    }
    return {
      type: pointerTo(operand.type),
      isLvalue: false,
      row,
      staticAddress: operand.staticAddress,
      constantPointee: constantLocationOf(operand),
      run: operand.run,
    };
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
  // code-gauge-allow functionNcss 36 -- Both assignments share storage tracking and preserve C++ operand order.
  assign(operator: string, target: Expr, source: Expr, row: number): Expr {
    if (target.type.kind === 'class') {
      const libraryResult = this.libraryOperator(operator, [target, source], row);
      if (libraryResult) return libraryResult;
      if (operator !== '=') return this.error(row, `演算子 ${operator} は ${typeName(target.type)} には使えません。`);
      return this.assignObject(target, source, row);
    }
    this.checkAssignable(target, row, operator);
    const location = target.run;
    const size = sizeOf(target.type);
    if (operator === '=') {
      if (target.type.kind === 'array') return this.error(row, '配列にはまとめて代入できません。');
      const value = this.convert(source, unqualified(target.type), row).run;
      // C++17 sequences the right operand of an assignment before the left one.
      return {
        type: target.type,
        isLvalue: true,
        row,
        run: (frame) =>
          holdAll(frame, [value, location], ([result, destination]) => {
            const place = destination as Ptr;
            frame.writeScalar(place, size, result as Value);
            return place;
          }),
      };
    }
    const binaryOperator = operator.slice(0, -1);
    const current: Expr = {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) => frame.pending.at(-1) as unknown as Ptr,
    };
    const right = scalarValue(this, source);
    const operand: Expr = { ...right, run: (frame) => frame.pending.at(-2) as Value };
    const factors = right.type.kind === 'float' ? this.floatingProducts.get(right.run) : undefined;
    if (factors && right.type.kind === 'float') {
      const multiply = arithmeticOperation('*', right.type);
      operand.run = (frame) => multiply(...compoundAssignmentFactors(frame));
      this.floatingProducts.set(operand.run, compoundAssignmentFactors);
    }
    const combined = this.binary(binaryOperator, current, operand, row);
    const value = this.convert(combined, unqualified(target.type), row).run;
    return {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) => {
        const evaluated = factors?.(frame).map((factor) => () => factor) ?? [right.run];
        return holdAll(frame, [...evaluated, location], (values) => {
          const place = values.at(-1) as Ptr;
          holdValues(frame, values as Value[], () => frame.writeScalar(place, size, value(frame) as Value));
          return place;
        });
      },
    };
  }

  private assignObject(target: Expr, source: Expr, row: number): Expr {
    this.checkAssignable(target, row, '=');
    const cls = (target.type as Extract<Type, { kind: 'class' }>).cls;
    if (cls.isAssignmentDeleted)
      return this.error(row, `${cls.name} のオブジェクトには代入できません（代入演算子が削除されています）。`);
    const bound = this.convert(source, { kind: 'reference', to: classType(cls, true) }, row);
    const moves = bound.isXvalue && !isConstType(bound.type);
    this.requireObjectUse(target.type, moves ? 'move-assign' : 'assign', row);
    const location = target.run;
    return {
      type: target.type,
      isLvalue: true,
      row,
      run: (frame) =>
        holdAll(frame, [bound.run, location], ([right, left]) => {
          const place = left as Ptr;
          const object = place.read();
          const from = (right as Ptr).read();
          const replacement = moves
            ? moveValue(frame, target.type, object, from)
            : cls.operations?.assign(frame, object, from);
          if (replacement !== undefined) place.write(replacement);
          return place;
        }),
    };
  }

  private assignList(operator: string, target: Expr, list: Syntax): Expr {
    const type = unqualified(target.type);
    if (type.kind === 'array') return this.error(list.row, '配列にはまとめて代入できません。');
    const value = this.listInitializer(type, list, list.row);
    const source: Expr = {
      type,
      isLvalue: false,
      row: list.row,
      run: value as Eval<Value>,
      isTemporaryObject: type.kind === 'class',
      isAssignmentList: true,
    };
    return this.assign(operator, target, source, list.row);
  }

  /** Stops at an assignment to something that cannot be assigned: a const object, or a value without storage. */
  checkAssignable(target: Expr, row: number, operator: string): void {
    if (!target.isLvalue || (target.isXvalue && target.type.kind !== 'class'))
      return this.error(row, `${operator} の左には、変数などの代入できるもの（左辺値）を書いてください。`);
    if (isConstType(target.type)) {
      const what = target.description ? `const のメンバ ${target.description}` : 'const の変数（または const の値）';
      this.error(row, `${what}には代入できません。`);
    }
  }

  private conditionalExpression(node: Syntax): Expr {
    const test = this.compileExpression(fieldOf(node, 'condition') as Syntax);
    const condition = this.condition(test, node.row);
    const consequenceNode = fieldOf(node, 'consequence');
    if (!consequenceNode) return this.unsupported(node.row, '条件演算子の省略形（x ?: y）');
    const a = this.compileExpression(consequenceNode);
    const b = this.compileExpression(fieldOf(node, 'alternative') as Syntax);
    const { left, right, type, isLvalue } = this.conditionalOperands(a, b, node.row);
    const scalar = this.rvalue(test);
    const known = scalar.constant;
    const chosen = known === undefined ? undefined : known === 0 || known === 0n ? right : left;
    const memberCondition = scalar.memberConstant;
    const leftConstant = memberConstantOf(left);
    const rightConstant = memberConstantOf(right);
    const choose = (frame: Frame): Expr => (condition(frame) ? left : right);
    return {
      type,
      isLvalue,
      isXvalue: isLvalue && left.isXvalue,
      row: node.row,
      constant: chosen?.constant,
      foldedValue: chosen?.foldedValue,
      memberConstant: memberCondition
        ? (members) => {
            const value = memberCondition(members);
            if (value === undefined) return;
            return (Number(value) !== 0 ? leftConstant : rightConstant)?.(members);
          }
        : chosen?.memberConstant,
      constantInitialization: chosen?.constantInitialization,
      constantLocation: chosen?.constantLocation,
      constantPointee: chosen?.constantPointee,
      constantStringLength: chosen?.constantStringLength,
      staticAddress: chosen?.staticAddress,
      constantDesignation: chosen?.constantDesignation,
      constantReferenceBinding: chosen?.constantReferenceBinding,
      constantPointerValue: chosen?.constantPointerValue,
      run: (...args) => choose(args[0]).run(...args),
      temporaryBinding:
        isLvalue && (left.temporaryBinding || right.temporaryBinding)
          ? (frame, retain) => {
              const branch = choose(frame);
              return branch.temporaryBinding ? branch.temporaryBinding(frame, retain) : (branch.run(frame) as Ptr);
            }
          : undefined,
      isTemporaryObject: !isLvalue && type.kind === 'class',
    };
  }

  private conditionalOperands(
    a: Expr,
    b: Expr,
    row: number
  ): { left: Expr; right: Expr; type: Type; isLvalue: boolean } {
    const glvalue = this.conditionalGlvalueType(a, b, row);
    if (glvalue) {
      const withBaseLocation = (expr: Expr): Expr =>
        glvalue.kind === 'class' && expr.type.kind === 'class' && glvalue.cls !== expr.type.cls
          ? classLocation(expr, glvalue.cls)
          : expr;
      return { left: withBaseLocation(a), right: withBaseLocation(b), type: glvalue, isLvalue: true };
    }
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
    const pointer = commonPointerType(av, bv);
    if (pointer) {
      return {
        left: this.convert(av, pointer, row),
        right: this.convert(bv, pointer, row),
        type: pointer,
        isLvalue: false,
      };
    }
    if (av.type.kind === 'class' || bv.type.kind === 'class') {
      const toLeft = implicitConversion(this, b, av.type);
      const toRight = implicitConversion(this, a, bv.type);
      if (toLeft && toRight)
        return this.error(row, '条件演算子の2つの値が互いの型に変換できるため、結果の型が決まりません。');
      if (toLeft)
        return { left: this.convert(a, av.type, row), right: toLeft.apply(b), type: av.type, isLvalue: false };
      if (toRight)
        return { left: toRight.apply(a), right: this.convert(b, bv.type, row), type: bv.type, isLvalue: false };
    }
    return this.error(row, `条件演算子の2つの値の型（${typeName(a.type)} と ${typeName(b.type)}）が合いません。`);
  }

  private conditionalGlvalueType(a: Expr, b: Expr, row: number): Type | undefined {
    if (!a.isLvalue || !b.isLvalue || Boolean(a.isXvalue) !== Boolean(b.isXvalue)) return undefined;
    if (sameType(a.type, b.type, false)) return isConstType(b.type) ? withConst(a.type) : a.type;
    if (a.type.kind !== 'class' || b.type.kind !== 'class') return undefined;
    const [derived, base] = a.type.cls.isDerivedFrom(b.type.cls) ? [a.type, b.type] : [b.type, a.type];
    if (!derived.cls.isDerivedFrom(base.cls)) return undefined;
    if (isConstType(derived) && !isConstType(base))
      return this.error(row, `条件演算子の2つの値の型（${typeName(a.type)} と ${typeName(b.type)}）が合いません。`);
    this.checkBaseConversion(derived.cls, base.cls, row);
    return base;
  }

  private commaExpression(node: Syntax): Expr {
    const left = this.compileExpression(fieldOf(node, 'left') as Syntax);
    const right = this.compileExpression(fieldOf(node, 'right') as Syntax);
    const { run: second, temporaryBinding } = right;
    const value = this.rvalue(left);
    const hasConstantLeft = value.constant !== undefined;
    const first = hasConstantLeft ? undefined : this.discardedValue(left);
    const expr: Expr = {
      ...right,
      constant: hasConstantLeft ? right.constant : undefined,
      foldedValue: hasConstantLeft ? right.foldedValue : undefined,
      memberConstant: hasConstantLeft
        ? right.memberConstant
        : mapMemberConstants([value, right], ([, result]) => result),
      isThis: hasConstantLeft && right.isThis,
      isNullConstant: undefined,
      literalBytes: undefined,
      constantInitialization: hasConstantLeft ? right.constantInitialization : undefined,
      constantLocation: hasConstantLeft ? right.constantLocation : undefined,
      constantPointee: hasConstantLeft ? right.constantPointee : undefined,
      constantStringLength: hasConstantLeft ? right.constantStringLength : undefined,
      staticAddress: hasConstantLeft ? right.staticAddress : undefined,
      constantDesignation: hasConstantLeft ? right.constantDesignation : undefined,
      constantReferenceBinding: hasConstantLeft ? right.constantReferenceBinding : undefined,
      constantPointerValue: hasConstantLeft ? right.constantPointerValue : undefined,
      temporaryBinding:
        temporaryBinding &&
        ((frame, retain) => {
          first?.(frame);
          return temporaryBinding(frame, retain);
        }),
      run: (...args) => {
        first?.(args[0]);
        return second(...args);
      },
    };
    const factors = this.floatingProducts.get(second);
    if (factors) {
      this.floatingProducts.set(expr.run, (frame) => {
        first?.(frame);
        return factors(frame);
      });
    }
    return expr;
  }

  discardedValue(expr: Expr): Expr['run'] {
    return expr.isTemporaryObject && expr.type.kind === 'class' ? this.materialize(expr).run : expr.run;
  }

  private subscriptExpression(node: Syntax): Expr {
    const array = this.compileExpression(fieldOf(node, 'argument') as Syntax);
    const indices = (fieldOf(node, 'indices') as Syntax).children;
    if (indices.length !== 1) return this.error(node.row, '[] の中には式を1つだけ書いてください。');
    const index = this.argument(indices[0]);
    return this.subscript(array, index, node.row);
  }

  subscript(array: Expr, index: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator('[]', [array, index], row);
    if (libraryResult) return libraryResult;
    if (index.braced) return this.error(row, 'この型の [] の中に {...} は書けません。');
    const left = this.rvalue(array);
    const right = this.rvalue(index);
    const reversed = isInteger(left.type) && right.type.kind === 'pointer';
    const pointer = reversed ? right : left;
    const offset = reversed ? left : right;
    if (pointer.type.kind !== 'pointer') {
      return this.error(row, `[] は配列やポインタ、std::vector などにしか使えません（${typeName(array.type)}）。`);
    }
    if (!isInteger(offset.type))
      return this.error(row, `配列の添字には整数を書いてください（${typeName(offset.type)}）。`);
    const p = pointer.run;
    const type = (pointer.type as Extract<Type, { kind: 'pointer' }>).to;
    const constantLocation = offsetConstantLocation(pointer.constantPointee, offset.constant);
    const original = reversed ? index : array;
    const temporaryArray = original.type.kind === 'array' ? original.temporaryBinding : undefined;
    const locate = (frame: Frame, pointerAt: Eval<Ptr>): Ptr =>
      holdAll(frame, reversed ? [offset.run, pointerAt] : [pointerAt, offset.run], ([first, second]) => {
        const [location, position] = reversed ? [second, first] : [first, second];
        return (location as Ptr).offset(position as number | bigint);
      });
    return {
      type,
      isLvalue: true,
      isXvalue: original.type.kind === 'array' && original.isXvalue,
      staticAddress: pointer.staticAddress && offset.constant !== undefined,
      constantDesignation:
        original.type.kind === 'array' && original.constantDesignation && designatesElement(original.type, offset),
      constantInitialization: hasConstantObject(constantLocation),
      constantLocation,
      row,
      run: (frame) => locate(frame, p as Eval<Ptr>),
      temporaryBinding:
        temporaryArray &&
        ((frame, retain) => locate(frame, (f) => new Ptr(temporaryArray(f, retain).read() as ArrayStore, 0))),
    };
  }

  subscriptObject(
    object: Expr,
    index: Expr['run'],
    locate: (frame: Frame, receiver: Value, index: unknown) => Ptr
  ): Eval<Ptr> {
    const receiver = this.objectOf(object);
    return (frame) =>
      holdAll(frame, [receiver, index], ([location, operand]) => locate(frame, (location as Ptr).read(), operand));
  }

  compareObjects(
    left: Expr,
    right: Expr,
    compare: (first: Value, second: Value, frame: Frame) => boolean
  ): Eval<number> {
    const first = this.objectOf(left);
    const second = this.objectOf(right);
    return (frame) =>
      frame.unsequencedOperands(first, second, (a, b) =>
        compare((a as Ptr).read(), (b as Ptr).read(), frame) ? 1 : 0
      );
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
    const libraryBool = this.libraryBool(expr, row);
    if (libraryBool) {
      const test = libraryBool.run;
      return (frame) => test(frame) !== 0;
    }
    if (type.kind === 'void') return this.error(row, '値を返さない関数（void）の結果は条件に使えません。');
    if (expr.functions) return this.error(row, `関数 ${expr.functions.name} の後に (...) を書いて呼び出してください。`);
    return this.error(row, `${typeName(type)} 型の値は条件に使えません。`);
  }

  /** A library class's conversion to `bool`, such as a stream's `explicit operator bool`, when `to` is `bool`. */
  private libraryBool(expr: Expr, row: number, to: Type = BOOL): Expr | undefined {
    if (expr.type.kind !== 'class' || !sameType(to, BOOL, false)) return undefined;
    return expr.type.cls.library?.operator?.(this, 'bool', [expr], row);
  }

  /** An explicit conversion: `static_cast`, a C-style cast (`kind` 'C'), or a functional cast `T(x)`. */
  explicitConversion(expr: Expr, type: Type, row: number, kind: 'static' | 'C'): Expr {
    if (type.kind === 'void') {
      const run = this.discardedValue(expr);
      return { type, isLvalue: false, row, run: (frame) => (run(frame), undefined), onlyCalls: expr.onlyCalls };
    }
    if (type.kind === 'reference') return this.castReference(expr, type, row, kind);
    const direct = this.directInitializerArgument(type, expr);
    if (direct !== expr) return direct;
    const explicitBool = this.libraryBool(expr, row, type);
    if (explicitBool) return explicitBool;
    const value = this.rvalue(expr);
    if (isArithmetic(type) && isArithmetic(value.type))
      return convertArithmetic(value, unqualified(type) as ArithmeticType);
    if (type.kind === 'pointer' && value.type.kind === 'pointer')
      return this.castPointer(value, value.type.to, type, row, kind);
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

  directInitializerArgument(type: Type, expr: Expr): Expr {
    if (type.kind !== 'int' || type.name !== 'bool' || expr.type.kind !== 'nullptr') return expr;
    const value = this.rvalue(expr);
    return {
      type: BOOL,
      row: expr.row,
      isLvalue: false,
      onlyCalls: expr.onlyCalls,
      constant: this.isConstantInitializer(value) ? 0 : undefined,
      run: (frame) => {
        value.run(frame);
        return 0;
      },
    };
  }

  private castReference(
    expr: Expr,
    type: Extract<Type, { kind: 'reference' }>,
    row: number,
    kind: 'static' | 'C'
  ): Expr {
    const { type: from } = expr;
    const { to } = type;
    if (
      expr.isLvalue &&
      !expr.isXvalue &&
      from.kind === 'class' &&
      to.kind === 'class' &&
      (to.cls.isDerivedFrom(from.cls) || from.cls.isDerivedFrom(to.cls)) &&
      (!isConstType(from) || isConstType(to))
    ) {
      return this.castClassLocation(expr, to, from.cls, to.cls, row, kind);
    }
    const converted = this.convert(expr, type, row);
    return { ...converted, type: to, isLvalue: true, isXvalue: false };
  }

  private castPointer(
    value: Expr,
    from: Type,
    type: Extract<Type, { kind: 'pointer' }>,
    row: number,
    kind: 'static' | 'C'
  ): Expr {
    const { to } = type;
    const related =
      sameType(from, to, false) ||
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
    if (from.kind === 'class' && to.kind === 'class')
      return this.castClassLocation(value, type, from.cls, to.cls, row, kind);
    const run = value.run;
    if (from.kind === 'void' && to.kind !== 'void')
      return { ...value, type, run: (frame) => recoverPointee(run(frame) as Ptr, to) };
    if (to.kind === 'void' && from.kind !== 'void')
      return { ...value, type, run: (frame) => erasePointee(run(frame) as Ptr, from) };
    return { ...value, type };
  }

  private castClassLocation(
    expr: Expr,
    type: Type,
    from: ClassInfo,
    to: ClassInfo,
    row: number,
    kind: 'static' | 'C'
  ): Expr {
    if (from === to) return { ...expr, type };
    const downcast = to.isDerivedFrom(from);
    if (kind === 'static') this.checkBaseConversion(downcast ? to : from, downcast ? from : to, row);
    if (!downcast) return { ...classLocation(expr, to), type };
    const virtualBase = virtualBaseBetween(to, from);
    if (virtualBase)
      return this.error(
        row,
        `${from.name} から ${to.name} へは、仮想基底クラス ${virtualBase.name} を経由するのでキャストできません。`
      );
    const { run, temporaryBinding } = expr;
    const checked = (location: Ptr): Ptr => (location.isNull ? location : downcastLocation(location, to));
    return {
      ...expr,
      type,
      run: (frame) => checked(run(frame) as Ptr),
      temporaryBinding: temporaryBinding && ((frame, retain) => checked(temporaryBinding(frame, retain))),
    };
  }

  private namedCast(node: Syntax): Expr {
    const keyword = node.all.find((child) => !child.isNamed && child.type.endsWith('_cast'))?.type;
    if (keyword !== 'static_cast') return this.unsupported(node.row, keyword ?? 'キャスト');
    const type = this.typeDescriptor(fieldOf(node, 'type') as Syntax);
    return this.explicitConversion(this.compileExpression(fieldOf(node, 'value') as Syntax), type, node.row, 'static');
  }

  private sizeofExpression(node: Syntax): Expr {
    if (node.all.some((child) => child.type === '...')) return this.unsupported(node.row, 'sizeof...');
    const type = this.sizeofOperandType(node);
    if (type.kind === 'function') return this.error(node.row, '関数には sizeof を使えません。');
    if (type.kind === 'void') return this.error(node.row, 'void 型には sizeof を使えません。');
    if (type.kind === 'array' && type.length === undefined)
      return this.error(node.row, '大きさの決まっていない配列には sizeof を使えません。');
    let element: Type = type;
    while (element.kind === 'array') element = element.of;
    if (element.kind === 'class' && !element.cls.isComplete)
      return this.error(node.row, `クラス ${element.cls.name} はまだ定義されていません。`);
    this.checkLibraryLayout(element, node.row);
    return constantExpr(SIZE_T, BigInt(sizeOf(type)), node.row);
  }

  private sizeofOperandType(node: Syntax): Type {
    const previous = this.isUnevaluated;
    this.isUnevaluated = true;
    try {
      const typeNode = fieldOf(node, 'type');
      if (typeNode) {
        const named = fieldOf(typeNode, 'type');
        if (named?.type === 'qualified_identifier' && !fieldOf(typeNode, 'declarator')) {
          const entity = this.lookupQualified(named);
          if (entity.kind !== 'type' && entity.kind !== 'class' && entity.kind !== 'template')
            return this.entityExpr(entity, named, true).type;
        }
        return this.typeDescriptor(typeNode);
      }
      const value = fieldOf(node, 'value') as Syntax;
      const target = value.type === 'parenthesized_expression' ? value.children[0] : undefined;
      const type = target && this.expressionAsType(target);
      if (type) return type;
      return this.compileExpression(value).type;
    } finally {
      this.isUnevaluated = previous;
    }
  }

  /** `T{...}`, a braced functional cast, which list-initializes a prvalue. */
  private bracedCast(node: Syntax): Expr {
    const typeNode = fieldOf(node, 'type') as Syntax;
    if (typeNode.type === 'type_descriptor') return this.unsupported(node.row, '複合リテラル（(型){...}）');
    const type = this.resolveTypeSpecifier(typeNode);
    const list = fieldOf(node, 'value') as Syntax;
    const value = this.listValue(type, list, true, node.row);
    const object = { ...value, onlyCalls: type.kind === 'class' };
    return list.children.length === 0 ? constantFunctor(type, object) : object;
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  private callExpression(node: Syntax): Expr {
    const functionNode = fieldOf(node, 'function') as Syntax;
    const argsNode = fieldOf(node, 'arguments') as Syntax;
    const argNodes = argsNode.children;
    const isUnqualified = functionNode.type === 'identifier';
    if (isUnqualified && this.library.isFunctionMacro(functionNode.text))
      return this.unsupported(functionNode.row, `マクロ（${functionNode.text}）`);
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
    if (isUnqualified && !this.findName(functionNode.text)) {
      const args = argNodes.map((arg) => this.argument(arg));
      const functions = this.withArgumentDependentLookup(functionNode.text, [], args);
      if (functions.length > 0) {
        const callee = this.entityExpr({ kind: 'functions', functions }, functionNode, false);
        return this.callWith(callee, args, node.row);
      }
      this.lookupName(functionNode.text, functionNode.row);
    }
    const callee = this.compileExpression(functionNode);
    const args = argNodes.map((arg) => this.argument(arg));
    return this.callWith(callee, args, node.row, isUnqualified);
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
        return this.instantiateTemplate(entity.template, fieldOf(node, 'arguments') as Syntax, node.row);
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
      if (argumentList) return this.instantiateTemplate(entity.template, argumentList, node.row);
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
    // A virtual call never reaches a pure virtual function, but a qualified call needs its definition.
    if (!resolved.fn.isPure || candidates.isQualified) this.checkDefined(resolved.fn, row);
    return this.callExpr(resolved, args, object, row, candidates.isQualified === true);
  }

  callCallback(candidates: FunctionCandidates, args: Expr[], row: number): Expr {
    const resolved = this.resolve('関数', candidates.candidates, args, undefined, row, candidates.templateArgs, true);
    const { fn } = resolved;
    if (fn.owner) {
      if (!fn.isStatic) return this.error(row, `メンバ関数 ${fn.displayName} は、関数として渡せません。`);
      if (!fn.native) this.checkAccess(fn.access, fn.owner, candidates.namingClass ?? fn.owner, row, fn.name);
    }
    this.checkDefined(fn, row);
    return this.withLibraryAccess(() => this.callExpr(resolved, args, undefined, row));
  }

  /** Adds the library's functions an unqualified call finds through its arguments' types (C++20 [basic.lookup.argdep]). */
  protected abstract withArgumentDependentLookup(name: string, functions: FunctionInfo[], args: Expr[]): FunctionInfo[];

  bracedConversion(list: Syntax, to: Type): ConversionSequence | undefined {
    const arg = this.singleListExpression(list);
    if (to.kind === 'reference' && arg && isReferenceRelated(arg.type, to.to)) {
      const binding = implicitConversion(this, arg, to, false);
      if (binding) return { ...binding, apply: () => binding.apply(arg) };
    }
    if (to.kind === 'reference' && !isConstType(to.to)) return undefined;
    const type = unqualified(nonReference(to));
    let value: Expr;
    try {
      value = this.listValue(type, list);
    } catch (error) {
      if (error instanceof CompileError) return undefined;
      throw error;
    }
    let rank: Rank = type.kind === 'class' ? Rank.UserDefined : Rank.Exact;
    if (type.kind !== 'class' && arg) rank = implicitConversion(this, arg, type)?.rank ?? Rank.Conversion;
    return sequence(rank, () => (to.kind === 'reference' ? this.materialize(value) : value));
  }

  protected listReferenceValue(list: Syntax, referent: Type, direct: boolean): Expr | undefined {
    const target = this.singleListExpression(list);
    if (target && isReferenceRelated(target.type, referent)) return target;
    if (isConstType(referent)) return this.listValue(unqualified(referent), list, direct);
  }

  private singleListExpression(list: Syntax): Expr | undefined {
    const [first, ...rest] = list.children;
    if (first && rest.length === 0 && first.type !== 'initializer_list') return this.compileExpression(first);
  }

  private listValue(type: Type, list: Syntax, direct = false, row = list.row): Expr {
    const initialize = this.listInitializer(type, list, row, direct);
    const run: Expr['run'] =
      type.kind === 'class' || type.kind === 'array'
        ? (frame, zeroInitialize, destination, referenceLifetime) =>
            initialize(frame, destination, zeroInitialize, referenceLifetime)
        : (initialize as Eval<Value>);
    return {
      type,
      isLvalue: false,
      row,
      run,
      constantInitialization: initialize.isConstant,
      constantStringLength: initialize.constantStringLength,
      isTemporaryObject: type.kind === 'class',
    };
  }

  /** A prvalue object of a class made from constructor arguments, or by aggregate initialization when braced. */
  constructObject(cls: ClassInfo, args: Expr[], row: number, isBraced: boolean): Expr {
    if (args.length === 0 || args[0].braced?.children.length === 0)
      return constantFunctor(classType(cls), this.constructArguments(cls, args, row, isBraced));
    return this.constructArguments(cls, args, row, isBraced);
  }

  private constructArguments(cls: ClassInfo, args: Expr[], row: number, isBraced: boolean): Expr {
    if (!cls.isComplete && cls.library) return this.error(row, `クラス ${cls.name} はまだ定義されていません。`);
    if (args.length === 0 && cls.library?.defaultInitializer) return this.defaultConstructed(cls, row, true);
    const list = args.length === 1 ? args[0].braced : undefined;
    if (list && cls.library) {
      const initialize = cls.library.listInitializer;
      if (!initialize) {
        const matching = this.matchingOverloads(cls.constructors, args);
        const resolved = this.chooseOverload(`${cls.name} のコンストラクタ`, matching, row);
        if (resolved) return this.constructWith(cls, resolved, args, row);
      }
      if (!initialize) return this.listValue(classType(cls), list);
      const run = initialize(this, list.children, row);
      if (run)
        return {
          type: classType(cls),
          isLvalue: false,
          isTemporaryObject: true,
          row,
          run: (frame, zeroInitialize, destination, referenceLifetime) =>
            run(frame, destination, zeroInitialize, referenceLifetime),
          constantInitialization: run.isConstant,
          constantStringLength: run.constantStringLength,
        };
    }
    if (args.length === 1 && args[0].type.kind === 'class' && args[0].type.cls.isDerivedFrom(cls) && !isBraced) {
      const source = args[0];
      if (source.type.kind === 'class' && source.type.cls === cls && source.isTemporaryObject) return source;
      if (cls.constructors.every((ctor) => ctor.native !== undefined || !isCopyConstructor(ctor, cls)))
        return this.copyObject(source, cls);
    }
    if (cls.constructors.length === 0 && !cls.library) {
      if (args.length === 0) return this.defaultConstructed(cls, row, true);
      const aggregate = this.parenthesizedAggregate(cls, args, row);
      if (aggregate) return aggregate;
      return this.error(
        row,
        `${cls.name} には、引数（${args.map((arg) => typeName(arg.type)).join(', ')}）をとるコンストラクタがありません。`
      );
    }
    const resolved = this.resolve(`${cls.name} のコンストラクタ`, cls.constructors, args, undefined, row);
    return this.constructWith(cls, resolved, args, row);
  }

  /** A default-initialized object of a class: its default constructor's, or an implicit one's. */
  abstract defaultConstructed(cls: ClassInfo, row: number, isValueInitialized: boolean): Expr;

  protected abstract parenthesizedAggregate(cls: ClassInfo, args: Expr[], row: number): Expr | undefined;

  /** A value-initialized prvalue of a type, as `T()` makes. */
  valueInitialized(type: Type, row: number): Expr {
    if (type.kind === 'reference') return this.error(row, '参照には初期値を書いてください。');
    if (type.kind === 'class') return this.defaultConstructed(type.cls, row, true);
    if (type.kind === 'array') {
      const initialize = this.valueInitialized(type.of, row).run;
      const destroy = this.destroyerOf(type.of);
      const count = type.length ?? 0;
      return {
        type,
        isLvalue: false,
        row,
        run: (frame) =>
          constructArray(
            frame,
            count,
            type.of,
            (elementFrame, target) => initialize(elementFrame, false, target instanceof CObject ? target : undefined),
            destroy
          ),
      };
    }
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
  abstract listInitializer(type: Type, list: Syntax, row: number, direct?: boolean): Initializer;

  protected abstract initializeList(type: Type, elements: readonly Syntax[], row: number): Initializer;

  protected abstract bracedArrayInitializers(element: Type, list: Syntax): Initializer[];

  // new and delete ---------------------------------------------------------------------------------------------------

  private newExpression(node: Syntax): Expr {
    if (fieldOf(node, 'placement')) return this.unsupported(node.row, '配置 new（new (場所) 型）');
    let baseType = this.specifiedType(node, true);
    let declarator = fieldOf(node, 'declarator');
    for (; declarator?.type === 'abstract_pointer_declarator'; declarator = fieldOf(declarator, 'declarator'))
      baseType = pointerTo(baseType, this.hasSpecifier(declarator, 'const'));
    const argsNode = fieldOf(node, 'arguments');
    if (hasAuto(baseType)) {
      if (declarator || argsNode?.children.length !== 1)
        return this.error(node.row, 'new の auto 型には、初期値を1つ書いてください。');
      baseType = this.deduceAuto(baseType, this.compileExpression(argsNode.children[0]), node.row);
    }
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
    let initialize: Initializer;
    if (!argsNode) initialize = this.defaultInitializer(baseType, node.row);
    else if (argsNode.type === 'initializer_list') {
      initialize = this.listInitializer(type, argsNode, node.row, true);
    } else {
      const args = argsNode.children.map((arg) => this.argument(arg));
      if (type.kind === 'class')
        initialize = this.copyInitializer(type, this.constructObject(type.cls, args, node.row, false), node.row, false);
      else if (args.length === 0) initialize = this.valueInitialized(type, node.row).run as Eval<Value>;
      else if (args.length === 1)
        initialize = this.convert(this.directInitializerArgument(type, args[0]), type, node.row).run as Eval<Value>;
      else return this.error(node.row, `new ${typeName(type)}(...) には値を1つだけ書いてください。`);
    }
    return {
      type: pointerTo(baseType),
      isLvalue: false,
      row: node.row,
      onlyCalls: type.kind === 'class',
      run: (frame) => {
        if (type.kind !== 'class' || type.cls.library || type.cls.fields.length === 0) frame.runtime.reserve(1);
        const box = new Box();
        box.allocation = 'new';
        const location = box.location(0);
        return holdValues(frame, [box], () => {
          try {
            initializeAt(frame, type, location, box.value, (target) =>
              initialize(frame, target, false, 'full-expression')
            );
            return location;
          } catch (error) {
            endLifetime(box, Liveness.Deleted);
            throw error;
          }
        });
      },
    };
  }

  private newArray(elementType: Type, lengthNode: Syntax, argsNode: Syntax | undefined, row: number): Expr {
    this.checkAllocatedElement(elementType, row);
    const lengthExpr = this.rvalue(this.compileExpression(lengthNode));
    if (!isInteger(lengthExpr.type))
      return this.error(row, `new[] の要素の数には整数を書いてください（${typeName(lengthExpr.type)}）。`);
    const length = convertArithmetic(lengthExpr, LONG).run;
    // C++20 initializes the elements from parentheses as from braces, except for narrowing (C++20 [dcl.init.general]).
    const initial =
      argsNode?.type === 'initializer_list'
        ? this.bracedArrayInitializers(elementType, argsNode)
        : (argsNode?.children ?? []).map((child) =>
            this.copyInitializer(elementType, this.compileExpression(child), child.row, false)
          );
    if (lengthExpr.constant !== undefined && Number(lengthExpr.constant) < initial.length)
      return this.error(row, 'new[] の要素の数が足りません。');
    const badAlloc = this.library.exception('bad_alloc');
    // The elements without initializers need a default constructor when some may exist, and an unbraced allocation of
    // no elements still needs one (clang++ checks `new X[0]` and `new X[0]()` but not `new X[0]{}`).
    const hasRest =
      lengthExpr.constant === undefined ||
      Number(lengthExpr.constant) > initial.length ||
      (argsNode?.type !== 'initializer_list' && initial.length === 0);
    const valueInitialize =
      hasRest && argsNode?.type === 'argument_list' ? this.valueInitialized(elementType, row).run : undefined;
    const rest: Initializer | undefined = hasRest
      ? argsNode?.type === 'initializer_list'
        ? this.initializeList(elementType, [], row)
        : valueInitialize
          ? (frame, target) => valueInitialize(frame, false, target instanceof CObject ? target : undefined)
          : this.defaultInitializer(elementType, row)
      : undefined;
    const destroy = this.destroyerOf(elementType, row);
    return {
      type: pointerTo(elementType),
      isLvalue: false,
      row,
      run: (frame) => {
        const count = Number(length(frame));
        if (count < initial.length) return throwLibrary(frame, badAlloc, 'std::bad_alloc');
        const store = constructArray(
          frame,
          count,
          elementType,
          (elementFrame, target, index) =>
            (initial[index] ?? (rest as Initializer))(elementFrame, target, false, 'full-expression'),
          destroy
        );
        store.allocation = 'newArray';
        store.allocatedElementType = elementType;
        return new Ptr(store, 0);
      },
    };
  }

  private checkAllocatedElement(elementType: Type, row: number): void {
    let element = elementType;
    while (element.kind === 'array') element = element.of;
    if (element.kind === 'void') this.error(row, 'void のオブジェクトは new で作れません。');
    if (element.kind !== 'class') return;
    if (!element.cls.isComplete) this.error(row, `クラス ${element.cls.name} はまだ定義されていません。`);
    if (element.cls.isAbstract)
      this.error(row, `${element.cls.name} は抽象クラス（純粋仮想関数があるクラス）なので、オブジェクトを作れません。`);
  }

  /** The value of one element of a braced list, which may itself be a braced list. */
  elementInitializer(type: Type, node: Syntax): Initializer {
    if (node.type === 'initializer_list') return this.listInitializer(type, node, node.row);
    return this.copyInitializer(type, this.compileExpression(node), node.row, true);
  }

  /** The value copy-initialization gives an object of a type; `isList` checks for narrowing conversions. */
  abstract copyInitializer(type: Type, expr: Expr, row: number, isList: boolean): Initializer;

  /** The value default-initialization gives an object of a type. */
  abstract defaultInitializer(type: Type, row: number): Initializer;

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
      const source = run(frame) as Ptr;
      if (source.isNull) return undefined;
      if (pointee.kind === 'void' || pointee.kind === 'function') throw new CppRuntimeError('invalidDelete');
      const pointer = source.allocationLocation();
      if (pointer.store?.liveness === Liveness.Deleted) throw new CppRuntimeError('doubleDelete');
      const store = pointer.target();
      if (store.allocation !== (isArray ? 'newArray' : 'new') || pointer.index !== 0)
        throw new CppRuntimeError('invalidDelete');
      holdValues(frame, [store], () => {
        if (isArray) {
          destroyAllocatedArray(frame, store as ArrayStore, pointee, destroyStatic);
        } else {
          const object = (store as Box).value;
          if (cls && object instanceof CObject && object.cls !== cls && !hasVirtualDestructor)
            throw new CppRuntimeError('invalidDelete');
          const destroy =
            hasVirtualDestructor && object instanceof CObject ? object.cls.operations?.destroy : destroyStatic;
          destroy?.(frame, object);
        }
        endLifetime(store, Liveness.Deleted);
      });
      return;
    };
    return { type: { kind: 'void' }, isLvalue: false, row: node.row, run: exec, onlyCalls: true };
  }

  /** The type of an `auto` variable, deduced from its initializer as a function template parameter would be. */
  deduceAuto(declared: Type, init: Expr, row: number): Type {
    if (!hasAuto(declared)) return declared;
    if (init.functions) return this.unsupported(row, '関数ポインタ');
    if (init.type.kind === 'void')
      return this.error(row, 'auto の変数の初期値に、値を返さない関数（void）の結果は使えません。');
    const decayed = init.type.kind === 'array' ? pointerTo(init.type.of) : unqualified(init.type);
    return this.deduceAutoPattern(declared, decayed, row);
  }

  /** The type `auto&` or `const auto&` refers to. */
  deduceAutoReference(declared: Type, init: Expr): Type {
    return this.deduceAutoPattern(declared, init.type, init.row);
  }

  private deduceAutoPattern(declared: Type, actual: Type, row: number): Type {
    const isConst = isConstType(declared) || isConstType(actual);
    if (isAuto(declared)) return withConst(actual, isConst);
    if (declared.kind !== 'pointer') return declared;
    if (actual.kind !== 'pointer')
      return this.error(row, `auto* の初期値にポインタを書いてください（${typeName(actual)}）。`);
    return pointerTo(this.deduceAutoPattern(declared.to, actual.to, row), isConst);
  }
}

function fma(a: FloatingValue, b: FloatingValue, c: FloatingValue, isFloat: boolean): FloatingValue {
  return fusedNaN(a, b, c) ?? binaryFma(Number(a), Number(b), Number(c), isFloat);
}

function arithmeticVariableValue(
  type: Type,
  value: number | bigint | undefined,
  foldedValue: number | bigint | undefined,
  isConstexpr: boolean | undefined
): Pick<Expr, 'constant' | 'foldedValue'> {
  return type.kind === 'float' && !isConstexpr
    ? { foldedValue: value ?? foldedValue }
    : { constant: value, foldedValue };
}

function compoundAssignmentFactors(frame: Frame): FloatingFactors {
  return [frame.pending.at(-3) as FloatingValue, frame.pending.at(-2) as FloatingValue];
}

function commonPointerType(left: Expr, right: Expr): Type | undefined {
  const a = left.type;
  const b = right.type;
  if (a.kind === 'pointer' && (b.kind === 'nullptr' || right.isNullConstant)) return a;
  if (b.kind === 'pointer' && (a.kind === 'nullptr' || left.isNullConstant)) return b;
  if (a.kind !== 'pointer' || b.kind !== 'pointer') return;
  const x = a.to;
  const y = b.to;
  const isConst = isConstType(x) || isConstType(y);
  const combined = combinedPointee(x, y);
  if (combined) return pointerTo(combined);
  if (x.kind === 'void') return pointerTo(withConst(x, isConst));
  if (y.kind === 'void') return pointerTo(withConst(y, isConst));
  if (x.kind === 'class' && y.kind === 'class') {
    if (y.cls.isDerivedFrom(x.cls)) return pointerTo(withConst(x, isConst));
    if (x.cls.isDerivedFrom(y.cls)) return pointerTo(withConst(y, isConst));
  }
}

function destroyAllocatedArray(
  frame: Frame,
  store: ArrayStore,
  pointee: Type,
  destroy: ((frame: Frame, value: Value) => void) | undefined
): void {
  const { allocatedElementType, values } = store;
  if (!allocatedElementType || !combinedPointee(allocatedElementType, pointee))
    throw new CppRuntimeError('invalidDelete');
  if (destroy) for (let index = values.length - 1; index >= 0; index--) destroy(frame, values[index]);
}

function combinedPointee(left: Type, right: Type): Type | undefined {
  const isConst = isConstType(left) || isConstType(right);
  if (sameType(left, right, false)) return withConst(left, isConst);
  if (left.kind === 'pointer' && right.kind === 'pointer') {
    const target = combinedPointee(left.to, right.to);
    if (target) return pointerTo(target, true);
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

function logicalConstant(stop: boolean, left: Expr, right: Expr): MemberConstant | undefined {
  const first = memberConstantOf(left);
  if (!first) return;
  const second = memberConstantOf(right);
  return (members) => {
    const value = first(members);
    if (value === undefined) return;
    if ((Number(value) !== 0) === stop) return Number(stop);
    const next = second?.(members);
    if (next !== undefined) return Number(Number(next) !== 0);
  };
}

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
  const order = a.compareAddress(b);
  switch (operator) {
    case '<': {
      return order < 0 ? 1 : 0;
    }
    case '<=': {
      return order <= 0 ? 1 : 0;
    }
    case '>': {
      return order > 0 ? 1 : 0;
    }
    default: {
      return order >= 0 ? 1 : 0;
    }
  }
}

/** A value-initialized standard function object, which is stateless and whose constructor is constexpr. */
function constantFunctor(type: Type, object: Expr): Expr {
  return type.kind === 'class' && type.cls.library?.kind === 'functor'
    ? { ...object, constantInitialization: true }
    : object;
}

/** Whether a constant subscript stays within an array or one past its end, as Apple clang++ accepts in a constant expression. */
function designatesElement(array: Type & { kind: 'array' }, offset: Expr): boolean {
  if (offset.constant === undefined || array.length === undefined) return false;
  const index = Number(offset.constant);
  return index >= 0 && index <= array.length;
}

/** Whether a static member named through `object` keeps its constant value: the object is absent or a constant designation. */
function isConstantObject(object: Expr | undefined): boolean {
  return !object || object.constantDesignation === true || object.staticAddress === true;
}

/** The location of the complete `to` object that `location` designates a base of, stopping when it is no such object. */
function downcastLocation(location: Ptr, to: ClassInfo): Ptr {
  const object = location.read();
  let view: Ptr | undefined;
  if (object instanceof CObject) view = object.cls.isDerivedFrom(to) ? location.forClass(to) : undefined;
  else if (object instanceof Store) view = object.classView(location, to);
  if (!view) throw new CppRuntimeError('custom', `${to.name} 型ではないオブジェクトをキャストしました。`);
  return view;
}

/** The virtual base of `derived` that `base` is or belongs to, which makes a downcast from `base` ill-formed. */
function virtualBaseBetween(derived: ClassInfo, base: ClassInfo): ClassInfo | undefined {
  for (const parent of [derived.base, ...(derived.library?.additionalPublicBases ?? [])]) {
    if (!parent?.isDerivedFrom(base)) continue;
    if (parent.library?.isVirtualBase) return parent;
    const found = virtualBaseBetween(parent, base);
    if (found) return found;
  }
}
