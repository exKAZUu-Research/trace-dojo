import { binaryOperation, complement, negate } from '../c/arith';
import type { BinaryOperator } from '../c/ast';
import { fma as binaryFma } from '../c/library/binaryFloat';
import { commonType, promote } from '../c/types';
import { CompileError } from '../interpreter/diagnostics';
import { arithmeticOperation, convertNumeric, type NumericValue } from './arithmetic';
import { byteAt } from './bytes';
import { asTemplate, hasAuto, isAuto } from './compilerBase';
import { requirementsHold } from './concepts';
import {
  classLocation,
  conversionFunctions,
  type ConversionSequence,
  convertArithmetic,
  functionTypeOf,
  implicitConversion,
  Rank,
  scalarValue,
  sequence,
} from './conversions';
import { CppRuntimeError } from './errors';
import {
  constantExpr,
  constantLocationOf,
  evaluatesWithoutSideEffects,
  type Expr,
  type FunctionCandidates,
  hasConstantObject,
  type Initializer,
  mapMemberConstants,
  type MemberConstant,
  memberConstantOf,
  NO_CONSTANT_MEMBERS,
  offsetConstantLocation,
  zeroLiteral,
} from './expr';
import { type FloatingValue, fusedNaN, negateFloat } from './floatSign';
import { orderingOf, UNORDERED } from './library/compare';
import { lessThan, moveValue } from './library/elements';
import { cStringStore, throwLibrary } from './library/support';
import { checkLiteralPrefix, literalBytes, numberLiteral, utf8 } from './literals';
import { typeInfoName } from './mangling';
import { constructArray, initializeAt, invoke, ObjectCompiler, outermostOwner, zeroOf } from './objectCompiler';
import { hasUserType, memberOperators, overloadedOperator, withOverloads } from './operatorOverloads';
import { expandPacks, PACK_ELEMENT, packElements, packsIn, withPackElement } from './packs';
import { erasePointee, recoverPointee } from './pointerCasts';
import type { ClassTemplateInfo } from './programTemplates';
import { type Eval, type Frame, holdAll } from './runtime';
import type { Entity } from './scopes';
import { fieldOf, type Syntax, tokenOf } from './syntax';
import {
  alignOf,
  type ArithmeticType,
  BOOL,
  CHAR,
  type ClassInfo,
  classType,
  type FieldInfo,
  fieldSubobjectOffset,
  type FunctionInfo,
  type GlobalInfo,
  INT,
  isArithmetic,
  isCharType,
  isConstType,
  isCopyConstructor,
  isInteger,
  isReferenceRelated,
  isScopedEnum,
  isSigned,
  isWide,
  LONG,
  nonReference,
  NULLPTR,
  pointerTo,
  PTRDIFF_T,
  referenceTo,
  sameType,
  SIZE_T,
  sizeOf,
  type StaticFieldInfo,
  type Type,
  typeName,
  unqualified,
  withConst,
} from './types';
import { TYPE_QUERIES, TYPE_TRAITS } from './typeTraits';
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
  UNINIT,
  type Value,
} from './values';
import { nextVariadicArgument, startVariadicArguments } from './variadic';

const RELATIONAL_OPERATORS = ['<', '<=', '>', '>='];
const COMPARISONS = new Set(['==', '!=', ...RELATIONAL_OPERATORS]);
const ARITHMETIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

type FloatingFactors = [FloatingValue, FloatingValue];

/** Compiles expressions to closures that evaluate them. */
export abstract class ExpressionCompiler extends ObjectCompiler {
  /** Whether `auto` deduces an array from an array, as a structured binding's hidden variable does. */
  protected deducesArrays = false;
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
      case 'raw_string_literal':
      case 'concatenated_string': {
        return this.stringLiteral(node);
      }
      case 'user_defined_literal': {
        return this.userDefinedLiteral(node);
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
        const concept = this.conceptId(node);
        if (concept) return concept;
        const entity = this.lookupQualified(node);
        let name = fieldOf(node, 'name') as Syntax;
        while (name.type === 'qualified_identifier') name = fieldOf(name, 'name') as Syntax;
        const variable = entity.kind === 'template' ? entity.template.program : undefined;
        if (variable?.kind === 'variable' && (name.type === 'template_function' || name.type === 'template_type')) {
          const written = this.templateArguments(fieldOf(name, 'arguments') as Syntax);
          return this.entityExpr(this.instantiateVariableTemplate(variable, written, node.row), node, true);
        }
        const expr = this.entityExpr(entity, node, true);
        // `std::min<long long>` names a function template with its template arguments.
        if (name.type !== 'template_function' || !expr.functions) return expr;
        const templateArgs = this.templateArguments(fieldOf(name, 'arguments') as Syntax);
        return { ...expr, functions: { ...expr.functions, templateArgs } };
      }
      case 'template_function': {
        return this.templateFunction(node);
      }
      case 'typeid_expression': {
        return this.typeidExpression(node);
      }
      case 'va_arg_expression': {
        return this.vaArgExpression(node);
      }
      case 'requires_expression': {
        return constantExpr(BOOL, Number(requirementsHold(this as never, node)), node.row);
      }
      case PACK_ELEMENT: {
        return withPackElement(this, node, (pattern) => this.compileExpression(pattern));
      }
      case 'fold_expression': {
        return this.foldExpression(node);
      }
      case 'pack_index_expression': {
        return this.entityExpr(this.packElement(node), fieldOf(node, 'pack') as Syntax, false);
      }
      case 'dependent_name': {
        return this.compileExpression({ ...node.children[0], field: node.field });
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
      case 'lambda_expression': {
        return this.deducingLambdas?.get(node) ?? this.lambdaExpression(node);
      }
      case 'extension_expression': {
        return this.compileExpression(node.children[0]);
      }
      case 'alignof_expression': {
        const operand = fieldOf(node, 'type') ?? node.children[0];
        const type =
          operand.type === 'type_descriptor' ? this.typeDescriptor(operand) : this.compileExpression(operand).type;
        return constantExpr(SIZE_T, BigInt(alignOf(nonReference(type))), node.row);
      }
      case 'offsetof_expression': {
        return this.offsetOf(node);
      }
      case 'generic_expression': {
        return this.genericSelection(node);
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
      checkLiteralPrefix(part);
      if (part.type === 'raw_string_literal') {
        // A raw string literal holds its characters as written, with no escape sequences (C++20 [lex.string]).
        bytes += utf8(part.children.find((child) => child.type === 'raw_string_content')?.text ?? '');
        continue;
      }
      if (part.type !== 'string_literal') return this.error(part.row, `${part.text} は文字列リテラルではありません。`);
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

  /**
   * A user-defined literal (C++20 [lex.ext]): `10_km` calls `operator""_km`, and the library's `"abc"s` makes a
   * `std::string`.
   */
  private userDefinedLiteral(node: Syntax): Expr {
    const suffix = (node.children.find((child) => child.type === 'literal_suffix') as Syntax).text;
    const literal = node.children.find((child) => child.type !== 'literal_suffix') as Syntax;
    const { row } = node;
    if (!suffix.startsWith('_')) return this.standardLiteral(suffix, literal, row);
    const name = `operator""${suffix}`;
    const entity = this.findName(name);
    if (entity?.kind !== 'functions') return this.error(row, `リテラル演算子 ${name} は宣言されていません。`);
    const callee = this.entityExpr(entity, { ...node, text: name }, false);
    const args = this.literalOperatorArguments(literal, entity.functions);
    return this.callWith(callee, args, row);
  }

  /** The arguments a literal operator gets for a literal: its value, or a string literal's pointer and length. */
  private literalOperatorArguments(literal: Syntax, candidates: FunctionInfo[]): Expr[] {
    const { row } = literal;
    if (literal.type === 'number_literal') {
      const value = this.compileExpression(literal);
      const takesRaw = candidates.some(
        (fn) => fn.params.length === 1 && fn.params[0].type.kind === 'pointer' && isCharType(fn.params[0].type.to)
      );
      const isInteger = value.type.kind === 'int';
      const cooked = candidates.some(
        (fn) =>
          fn.params.length === 1 && (isInteger ? fn.params[0].type.kind === 'int' : fn.params[0].type.kind === 'float')
      );
      // A numeric literal goes to the operator that takes its value, or else to the one that takes its characters.
      if (!cooked && takesRaw)
        return [
          this.stringLiteral({
            ...literal,
            type: 'string_literal',
            children: [{ ...literal, type: 'string_content' }],
            all: [{ ...literal, type: 'string_content' }],
          }),
        ];
      return [
        convertArithmetic(
          this.rvalue(value),
          isInteger ? { kind: 'int', name: 'ullong' } : { kind: 'float', name: 'ldouble' }
        ),
      ];
    }
    const value = this.compileExpression(literal);
    if (literal.type === 'char_literal') return [value];
    const length = (value.type as Extract<Type, { kind: 'array' }>).length ?? 1;
    return [this.rvalue(value), constantExpr(SIZE_T, BigInt(length - 1), row)];
  }

  /**
   * The library's literal suffixes: `"abc"s` makes a `std::string` and `"abc"sv` a `std::string_view`; the others need
   * what the interpreter leaves out.
   */
  private standardLiteral(suffix: string, literal: Syntax, row: number): Expr {
    if (suffix === 's' && literal.type !== 'number_literal') {
      const value = this.compileExpression(literal);
      const length = (value.type as Extract<Type, { kind: 'array' }>).length ?? 1;
      const { stringClass } = this.library;
      const pointer = this.rvalue(value);
      return this.constructObject(stringClass, [pointer, constantExpr(SIZE_T, BigInt(length - 1), row)], row, false);
    }
    if (['h', 'min', 's', 'ms', 'us', 'ns', 'y', 'd'].includes(suffix))
      return this.unsupported(row, '<chrono> の時間のリテラル');
    if (['i', 'if', 'il'].includes(suffix)) return this.unsupported(row, '<complex> の虚数のリテラル');
    const view = suffix === 'sv' && literal.type !== 'number_literal' ? this.findStdName('string_view') : undefined;
    if (view?.kind === 'class') {
      const value = this.compileExpression(literal);
      const length = (value.type as Extract<Type, { kind: 'array' }>).length ?? 1;
      const args = [this.rvalue(value), constantExpr(SIZE_T, BigInt(length - 1), row)];
      return this.constructObject(view.cls, args, row, false);
    }
    return this.error(row, `リテラルの接尾辞 ${suffix} はありません。`);
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
        if (!entity.global.isDefined) this.requireStaticDefinition(entity.global, row);
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
        const object = this.subobject(this.implicitThis(row, name, field.owner), field.owner, row);
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
        const object =
          members.length > 0 && !this.context.isStaticContext
            ? this.implicitThis(row, name, members[0].owner)
            : undefined;
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
      case 'pack': {
        return this.error(row, `パラメータパック ${name} は、... で展開して使ってください。`);
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
    const concept = this.conceptId(node);
    if (concept) return concept;
    const entity =
      nameNode.type === 'qualified_identifier'
        ? this.lookupQualified(nameNode)
        : this.lookupName(nameNode.text, node.row);
    const templateArgs = this.templateArguments(fieldOf(node, 'arguments') as Syntax);
    const variable = entity.kind === 'template' ? entity.template.program : undefined;
    if (variable?.kind === 'variable')
      return this.entityExpr(this.instantiateVariableTemplate(variable, templateArgs, node.row), nameNode, true);
    if (entity.kind !== 'functions') return this.error(node.row, `${nameNode.text} は関数テンプレートではありません。`);
    const expr = this.entityExpr(entity, nameNode, nameNode.type === 'qualified_identifier');
    return { ...expr, functions: { ...(expr.functions as FunctionCandidates), templateArgs } };
  }

  /**
   * `p->~A()`, which runs the object's destructor and those of its members and bases without freeing its storage
   * (C++20 [class.dtor]p15).
   */
  private destructorCall(object: Expr, name: Syntax, row: number): Expr {
    const type = object.type;
    const written = name.children[0]?.text ?? '';
    const cls = type.kind === 'class' ? type.cls : undefined;
    // `x.~T()` names the type through a name for it, such as a template parameter.
    const named = this.findName(written, true);
    const namesType =
      (named?.kind === 'type' && sameType(unqualified(named.type), unqualified(type), false)) ||
      (named?.kind === 'class' && named.cls === cls);
    if (cls && !namesType && written !== cls.name && written !== cls.name.replace(/^std::/, '').replace(/<.*$/, ''))
      return this.error(row, `デストラクタの名前 ~${written} が ${typeName(type)} と合いません。`);
    const destroy = this.destroyerOf(type, row);
    const call: FunctionInfo = {
      name: `~${written}`,
      displayName: `~${written}`,
      params: [],
      ret: { kind: 'void' },
      owner: cls,
      isStatic: false,
      isVirtual: false,
      isConst: false,
      isPure: false,
      isConstructor: false,
      isDestructor: true,
      isNoexcept: true,
      isOverride: false,
      isFinal: false,
      access: 'public',
      row,
      isAtomic: false,
      isDefined: true,
      native: (_args, { frame, selfLocation }) => {
        destroy?.(frame, selfLocation?.read() as Value);
        return;
      },
    };
    return {
      type: { kind: 'void' },
      isLvalue: false,
      row,
      run: () => {},
      functions: { name: call.name, candidates: [call], object, isQualified: true },
    };
  }

  /** `this` as the object it points to, for a member a member function names without `this->`. */
  /** The subobject of a class that an object of a class derived from it holds, through its secondary bases. */
  private subobject(object: Expr, owner: ClassInfo, row: number): Expr {
    let current = object;
    for (;;) {
      if (current.type.kind !== 'class') return current;
      let found: ClassInfo['secondaryBases'][number] | undefined;
      for (let cls: ClassInfo | undefined = current.type.cls; cls && !found; cls = cls.base) {
        if (cls === owner) return current;
        found = cls.secondaryBases.find((secondary) => secondary.cls.isDerivedFrom(owner));
      }
      if (!found) return current;
      current = this.fieldAccess(current, found.field, row);
    }
  }

  private implicitThis(row: number, name: string, owner?: ClassInfo): Expr {
    const { captures } = this.context;
    if (captures && owner !== captures.closure) {
      // A lambda's body names the members of the enclosing object through the `this` it captures.
      const object = captures.thisObject(row);
      if (!object) return this.error(row, `ラムダ式で this を取り込んでいないので、メンバ ${name} は使えません。`);
      return object;
    }
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

  /** The `this` of the code compiled now. */
  compileThis(row: number): Expr {
    return this.thisExpr(row);
  }

  private thisExpr(row: number): Expr {
    const { captures } = this.context;
    if (captures) {
      const object = captures.thisObject(row);
      if (!object) return this.error(row, 'ラムダ式で this を取り込んでいないので、this は使えません。');
      return this.addressOf(object, row);
    }
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
    if (fieldNode.type === 'destructor_name') return this.destructorCall(object, fieldNode, node.row);
    if (fieldNode.type === 'qualified_identifier') return this.qualifiedMember(object, fieldNode);
    // `obj.f<int>` and `obj.template f<int>` name a member function template with template arguments.
    const method = fieldNode.type === 'dependent_name' ? fieldNode.children[0] : fieldNode;
    if (method?.type === 'template_method') {
      const member = this.member(object, (fieldOf(method, 'name') as Syntax).text, node.row);
      if (!member.functions) return this.error(node.row, `${method.text} はメンバ関数テンプレートではありません。`);
      const templateArgs = this.templateArguments(fieldOf(method, 'arguments') as Syntax);
      return { ...member, functions: { ...member.functions, templateArgs } };
    }
    return this.member(object, fieldNode.text, node.row);
  }

  /** The object `p->` designates: what a pointer points to, or what an iterator's `->` gives. */
  arrow(pointer: Expr, row: number): Expr {
    const type = pointer.type;
    if (type.kind === 'class' && !type.cls.library) {
      // `p->m` calls `p.operator->()` and applies `->` again to its result (C++20 [over.ref]).
      const overloaded = overloadedOperator(this, '->', [pointer], row);
      if (!overloaded) return this.error(row, `${typeName(type)} には operator-> がありません。`);
      return this.arrow(overloaded.expr, row);
    }
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
      const field =
        owner.ownFields.find((candidate) => candidate.name === name) ??
        owner.anonymousFields.find((candidate) => candidate.name === name);
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
    const inSecondary = this.secondaryMember(object, cls, name, row);
    if (inSecondary) return inSecondary;
    return this.missingMember(cls, name, row);
  }

  /** A member that a secondary base of the class (or of its bases) declares, through the base's subobject. */
  private secondaryMember(object: Expr, cls: ClassInfo, name: string, row: number): Expr | undefined {
    const found: Expr[] = [];
    for (let owner: ClassInfo | undefined = cls; owner; owner = owner.base) {
      for (const secondary of owner.secondaryBases) {
        if (!hasMemberNamed(secondary.cls, name)) continue;
        this.checkBaseConversion(cls, secondary.cls, row);
        found.push(this.member(this.fieldAccess(object, secondary.field, row), name, row));
      }
    }
    if (found.length > 1) return this.error(row, `${name} は複数の親クラスにあるので、どれを指すのか決まりません。`);
    return found[0];
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
    if (field.path) {
      const [first, ...rest] = field.path;
      return this.fieldAccess(
        this.fieldAccess(object, first, row),
        { ...field, path: rest.length > 0 ? rest : undefined },
        row
      );
    }
    const { index } = field;
    const type = isConstType(object.type) && !field.isMutable ? withConst(field.type) : field.type;
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
    const isBitField = field.bitWidth !== undefined;
    const bitFieldPromotion = isBitField ? bitFieldPromotionOf(type, field.bitWidth as number) : undefined;
    if (object.isLvalue) {
      const { run, temporaryBinding } = object;
      return {
        type,
        bitFieldPromotion,
        isBitField,
        isLvalue: true,
        isXvalue: object.isXvalue,
        staticAddress: object.staticAddress,
        constantInitialization: object.constantInitialization,
        constantDesignation: object.constantDesignation,
        memberConstant: object.isThis && isArithmetic(type) ? (members) => members.get(field) : undefined,
        row,
        run: (frame) => locate(run(frame) as Ptr),
        description: field.name.replace(/^\0capture /, ''),
        temporaryBinding: temporaryBinding && ((frame, retain) => locate(temporaryBinding(frame, retain))),
      };
    }
    const materialized = this.temporaryLocation(object);
    return {
      type,
      bitFieldPromotion,
      isBitField,
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
    const leftNode = fieldOf(node, 'left') as Syntax;
    const left = this.compileExpression(leftNode);
    const right = this.compileExpression(fieldOf(node, 'right') as Syntax);
    if (normalized === '<=>') return this.threeWay(left, right, node.row);
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
    if (!left.functions && !right.functions && (hasUserType(left.type) || hasUserType(right.type)))
      return this.withComparisonRewrites(operator, left, right, row);
    return this.builtinBinary(operator, left, right, row);
  }

  /**
   * A binary operator with the operator functions the program declares, including the comparisons C++20 rewrites:
   * `a != b` as `!(a == b)` and `a == b` as `b == a` when only those are declared (C++20 [over.match.oper]p3).
   */
  private withComparisonRewrites(operator: string, left: Expr, right: Expr, row: number): Expr {
    const builtin = (): Expr => this.builtinBinary(operator, left, right, row);
    const direct = overloadedOperator(this, operator, [left, right], row);
    if (direct) return withOverloads(this, operator, [left, right], row, builtin);
    if (operator === '==' || operator === '!=') {
      const equal =
        overloadedOperator(this, '==', [left, right], row) ?? overloadedOperator(this, '==', [right, left], row);
      if (equal) return operator === '==' ? equal.expr : this.unary('!', equal.expr, row);
    }
    if (RELATIONAL_OPERATORS.includes(operator)) {
      // `a < b` compares `a <=> b` with 0, or `b <=> a` the other way (C++20 [over.match.oper]p3).
      const forward = overloadedOperator(this, '<=>', [left, right], row);
      if (forward) return this.binary(operator, forward.expr, zeroLiteral(row), row);
      const reversed = overloadedOperator(this, '<=>', [right, left], row);
      if (reversed) return this.binary(operator, constantExpr(INT, 0, row), reversed.expr, row);
    }
    return builtin();
  }

  /**
   * `a <=> b` (C++20 [expr.spaceship]): an operator function the program declares, or the built-in comparison of
   * arithmetic values (a `std::strong_ordering` for integers, a `std::partial_ordering` for floating-point values)
   * and of pointers, or the library's three-way comparison of its classes.
   */
  threeWay(left: Expr, right: Expr, row: number): Expr {
    if (hasUserType(left.type) || hasUserType(right.type)) {
      const overloaded = overloadedOperator(this, '<=>', [left, right], row);
      if (overloaded) return overloaded.expr;
    }
    const a = promoteBitField(this.rvalue(left));
    const b = promoteBitField(this.rvalue(right));
    if (isArithmetic(a.type) && isArithmetic(b.type) && !isScopedEnum(a.type)) {
      const common = commonType(unqualified(a.type) as never, unqualified(b.type) as never) as ArithmeticType;
      const x = convertArithmetic(a, common).run;
      const y = convertArithmetic(b, common).run;
      const cls = this.library.ordering(common.kind === 'float' ? 'partial_ordering' : 'strong_ordering');
      return orderingOf(
        cls,
        (frame) =>
          frame.unsequencedOperands(x, y, (first, second) => {
            const p = first as number | bigint;
            const q = second as number | bigint;
            if (Number.isNaN(Number(p)) || Number.isNaN(Number(q))) return UNORDERED;
            return p < q ? -1 : p > q ? 1 : 0;
          }),
        row
      );
    }
    if (a.type.kind === 'pointer' && b.type.kind === 'pointer') {
      const x = a.run;
      const y = b.run;
      return orderingOf(
        this.library.ordering('strong_ordering'),
        (frame) => Math.sign((x(frame) as Ptr).compareAddress(y(frame) as Ptr)),
        row
      );
    }
    const less = sameType(unqualified(left.type), unqualified(right.type), false)
      ? lessThan(unqualified(left.type))
      : undefined;
    if (less && left.type.kind === 'class') {
      const x = this.materialize(left).run;
      const y = this.materialize(right).run;
      return orderingOf(
        this.library.ordering('strong_ordering'),
        (frame) => {
          const p = (x(frame) as Ptr).read();
          const q = (y(frame) as Ptr).read();
          return Math.sign(less(p, q, frame));
        },
        row
      );
    }
    return this.error(row, `演算子 <=> は ${typeName(left.type)} と ${typeName(right.type)} には使えません。`);
  }

  private builtinBinary(operator: string, written: Expr, writtenRight: Expr, row: number): Expr {
    const left = this.builtinOperand(written);
    const right = this.builtinOperand(writtenRight);
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
      if (operand.functions)
        return this.error(row, `関数 ${operand.functions.name} の後に (...) を書いて呼び出してください。`);
      if (operand.type.kind === 'void') return this.error(row, '値を返さない関数（void）の結果は使えません。');
    }
    const leftValue = this.rvalue(left);
    const rightValue = this.rvalue(right);
    const lt = leftValue.type;
    const rt = rightValue.type;
    // A scoped enumeration takes part only in comparisons with its own type (C++20 [expr.rel], [expr.eq]).
    if (
      (isScopedEnum(lt) || isScopedEnum(rt)) &&
      (!COMPARISONS.has(operator) || !sameType(unqualified(lt), unqualified(rt)))
    )
      return this.error(
        row,
        `演算子 ${operator} は ${typeName(lt)} と ${typeName(rt)} には使えません（enum class の値は整数として計算できません）。`
      );
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
  arithmetic(operator: string, written: Expr, right: Expr, row: number): Expr {
    const left = promoteBitField(written);
    right = promoteBitField(right);
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
        const isConstant =
          a.constant !== undefined &&
          b.constant !== undefined &&
          (isComparison || !isInvalidFloating(operator, common, knownB, constant));
        if (isConstant) expr.constant = constant;
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

  private shift(operator: '<<' | '>>', written: Expr, right: Expr, row: number): Expr {
    const left = promoteBitField(written);
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
    if (operator === '+' && isInteger(lt) && rt.kind === 'pointer')
      return this.pointerOffset(right, left, 1, row, true);
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
            // Null minus null is 0; other pointers must point into storage that is still alive.
            if (!p.isNull) p.target();
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
  /** `pointer + offset` (or `- offset`), evaluating the offset first when it is the left operand. */
  pointerOffset(pointer: Expr, offset: Expr, sign: 1 | -1, row: number, offsetFirst = false): Expr {
    const type = pointer.type as Extract<Type, { kind: 'pointer' }>;
    this.checkPointerArithmetic(type, row);
    const p = pointer.run;
    const displacement = this.rvalue(offset);
    const n = displacement.run;
    const move = (location: unknown, distance: unknown): Ptr => {
      const delta = distance as number | bigint;
      return (location as Ptr).offset(sign === 1 ? delta : -delta);
    };
    return {
      type,
      isLvalue: false,
      staticAddress: pointer.staticAddress && displacement.constant !== undefined,
      constantPointee: offsetConstantLocation(pointer.constantPointee, displacement.constant, sign),
      row,
      run: (frame) => {
        return offsetFirst
          ? frame.unsequencedOperands(n, p, (distance, location) => move(location, distance))
          : frame.unsequencedOperands(p, n, move);
      },
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
    if (!operand.functions && hasUserType(operand.type))
      return withOverloads(this, operator, [operand], row, () => this.builtinUnary(operator, operand, row));
    return this.builtinUnary(operator, operand, row);
  }

  /**
   * The operand a built-in operator takes for an object of a class that the program wrote: the value of its only
   * implicit conversion function (C++20 [over.built]), or the object itself.
   */
  private builtinOperand(expr: Expr): Expr {
    if (expr.type.kind !== 'class' || expr.type.cls.library) return expr;
    const [only, ...others] = conversionFunctions(expr.type.cls).filter((fn) => !fn.isExplicit);
    return only && others.length === 0 ? this.callConversion(expr, only) : expr;
  }

  private builtinUnary(operator: string, writtenOperand: Expr, row: number): Expr {
    const operand = this.builtinOperand(writtenOperand);
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
    const value = promoteBitField(this.rvalue(operand));
    const type = value.type;
    if (operator === '+' && type.kind === 'pointer') return value;
    if (!isArithmetic(type) || (operator === '~' && !isInteger(type)) || isScopedEnum(type)) {
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

  increment(target: Expr, operator: '++' | '--', isPrefix: boolean, row: number): Expr {
    if (hasUserType(target.type))
      return withOverloads(
        this,
        operator,
        [target],
        row,
        () => this.builtinIncrement(target, operator, isPrefix, row),
        !isPrefix
      );
    return this.builtinIncrement(target, operator, isPrefix, row);
  }

  // code-gauge-allow functionNcss -- The result category and shared update depend on the same operand.
  private builtinIncrement(target: Expr, operator: '++' | '--', isPrefix: boolean, row: number): Expr {
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
      if (type.kind === 'int' && type.enumeration)
        return this.error(row, `列挙 ${type.enumeration.name} の変数には ${operator} を使えません。`);
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
    if (hasUserType(operand.type))
      return withOverloads(this, '*', [operand], row, () => this.builtinDereference(operand, row));
    return this.builtinDereference(operand, row);
  }

  private builtinDereference(operand: Expr, row: number): Expr {
    const libraryResult = this.libraryOperator('*', [operand], row);
    if (libraryResult) return libraryResult;
    if (operand.functions) return operand;
    const value = this.rvalue(operand);
    // `*fp` designates the function, which a call uses as it uses the pointer.
    if (value.type.kind === 'pointer' && value.type.to.kind === 'function') return value;
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
    if (operand.functions) {
      if (operand.functions.object || operand.functions.candidates.some((fn) => fn.owner && !fn.isStatic))
        return this.unsupported(row, 'メンバ関数へのポインタ');
      return operand;
    }
    if (!operand.isLvalue || operand.isXvalue)
      return this.error(row, '& は、変数などの場所を持つ値（左辺値）にしか使えません。');
    if (operand.isBitField) return this.error(row, 'ビットフィールドのアドレスは取れません。');
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
  // code-gauge-allow functionNcss -- Both assignments share storage tracking and preserve C++ operand order.
  assign(operator: string, target: Expr, source: Expr, row: number): Expr {
    if (target.type.kind === 'class' && !target.type.cls.library) {
      const overloaded = overloadedOperator(this, operator, [target, source], row);
      if (overloaded) return overloaded.expr;
    } else if (hasUserType(source.type) || (target.type.kind === 'int' && target.type.enumeration)) {
      const overloaded = overloadedOperator(this, operator, [target, source], row);
      if (overloaded && operator !== '=') return overloaded.expr;
    }
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

  /** `a ?: b` (a GNU extension clang++ accepts), which gives `a` when it is true and else `b`, evaluating `a` once. */
  private elvis(test: Expr, alternative: Expr, row: number): Expr {
    const value = this.rvalue(test);
    const held: Value[] = [];
    const first: Expr = { ...value, run: () => held.at(-1) as Value, constant: undefined };
    const condition = this.condition(first, row);
    const { left, right, type } = this.conditionalOperands(first, alternative, row);
    const leftValue = this.rvalue(left).run;
    const rightValue = this.rvalue(right).run;
    return {
      type,
      isLvalue: false,
      row,
      run: (frame) => {
        held.push(value.run(frame) as Value);
        try {
          return condition(frame) ? leftValue(frame) : rightValue(frame);
        } finally {
          held.pop();
        }
      },
    };
  }

  private conditionalExpression(node: Syntax): Expr {
    const test = this.compileExpression(fieldOf(node, 'condition') as Syntax);
    const condition = this.condition(test, node.row);
    const consequenceNode = fieldOf(node, 'consequence');
    if (!consequenceNode)
      return this.elvis(test, this.compileExpression(fieldOf(node, 'alternative') as Syntax), node.row);
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
    return this.comma(left, right);
  }

  /** `left, right`, which evaluates `left`, discards its value, and gives `right`. */
  comma(left: Expr, right: Expr): Expr {
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
    if (array.type.kind === 'class' && !array.type.cls.library) {
      const overloaded = overloadedOperator(this, '[]', [array, index], row);
      if (overloaded) return overloaded.expr;
    }
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
      staticAddress:
        pointer.staticAddress &&
        offset.constant !== undefined &&
        (original.type.kind !== 'array' || designatesElement(original.type, offset, type)),
      constantDesignation:
        original.type.kind === 'array' &&
        original.constantDesignation &&
        designatesElement(original.type, offset, type),
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
    if (isScopedEnum(type)) return this.error(row, `enum class（${typeName(type)}）の値は条件に使えません。`);
    if (isArithmetic(type))
      return (frame) => {
        const v = run(frame);
        return v !== 0 && v !== 0n;
      };
    if (type.kind === 'pointer' || type.kind === 'nullptr') return (frame) => !(run(frame) as Ptr).isNull;
    if (type.kind === 'class' && !type.cls.library) {
      // A condition converts to `bool` contextually, which may use an explicit conversion function.
      const conversion = implicitConversion(this, expr, BOOL, true, true);
      if (conversion) return this.condition(conversion.apply(expr), row);
    }
    const libraryBool = this.libraryBool(expr, row);
    if (libraryBool) {
      const test = libraryBool.run;
      return (frame) => test(frame) !== 0;
    }
    if (expr.functions) return this.error(row, `関数 ${expr.functions.name} の後に (...) を書いて呼び出してください。`);
    if (type.kind === 'void') return this.error(row, '値を返さない関数（void）の結果は条件に使えません。');
    return this.error(row, `${typeName(type)} 型の値は条件に使えません。`);
  }

  private libraryBool(expr: Expr, row: number): Expr | undefined {
    if (expr.type.kind === 'class') return expr.type.cls.library?.operator?.(this, 'bool', [expr], row);
  }

  /** An explicit conversion: `static_cast`, a C-style cast (`kind` 'C'), or a functional cast `T(x)`. */
  explicitConversion(expr: Expr, type: Type, row: number, kind: 'static' | 'C'): Expr {
    if (type.kind === 'void') {
      const run = this.discardedValue(expr);
      return { type, isLvalue: false, row, run: (frame) => (run(frame), undefined), onlyCalls: expr.onlyCalls };
    }
    if (type.kind === 'reference') return this.castReference(expr, type, row, kind);
    const direct = this.directInitializerArgument(type, expr, row);
    if (direct !== expr) return direct;
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
    if (expr.type.kind === 'class' && !expr.type.cls.library) {
      // A cast is a direct-initialization, which may use an explicit conversion function.
      const conversion = implicitConversion(this, expr, unqualified(type), true, true);
      if (conversion) return conversion.apply(expr);
    }
    return this.convert(expr, unqualified(type), row);
  }

  directInitializerArgument(type: Type, expr: Expr, row = expr.row): Expr {
    if (type.kind !== 'int' || type.name !== 'bool') return expr;
    if (expr.type.kind !== 'nullptr') return this.libraryBool(expr, row) ?? expr;
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
    // `static_cast<T&&>(x)` makes an xvalue of an lvalue, as `std::move` does.
    if (
      type.isRvalue &&
      expr.isLvalue &&
      sameType(unqualified(from), unqualified(to), false) &&
      (!isConstType(from) || isConstType(to))
    )
      return { ...expr, type: to, isXvalue: true };
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
    return { ...converted, type: to, isLvalue: true, isXvalue: type.isRvalue === true };
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
    // A C-style cast may take `const` away, as const_cast does; static_cast may not.
    if (isConstType(from) && !isConstType(to) && kind !== 'C')
      return this.error(row, `static_cast では const を外せません（${typeName(value.type)} から ${typeName(type)}）。`);
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
    const type = this.typeDescriptor(fieldOf(node, 'type') as Syntax);
    const value = this.compileExpression(fieldOf(node, 'value') as Syntax);
    const { row } = node;
    switch (keyword) {
      case 'static_cast': {
        return this.explicitConversion(value, type, row, 'static');
      }
      case 'const_cast': {
        return this.constCast(value, type, row);
      }
      case 'dynamic_cast': {
        return this.dynamicCast(value, type, row);
      }
      case 'reinterpret_cast': {
        // The cases whose results do not depend on how the machine lays out values in memory.
        const target = nonReference(type);
        const source = this.rvalue(value).type;
        if (
          target.kind === 'pointer' &&
          source.kind === 'pointer' &&
          sameType(unqualified(target.to), unqualified(source.to), false)
        )
          return this.explicitConversion(value, type, row, 'C');
        return this.unsupported(row, 'reinterpret_cast（値のメモリ上の表し方は、CPU や OS によって違います）');
      }
      default: {
        return this.unsupported(row, keyword ?? 'キャスト');
      }
    }
  }

  /** `const_cast<T>(e)`, which adds or removes `const` from a pointer's or a reference's target. */
  private constCast(value: Expr, type: Type, row: number): Expr {
    const strip = (t: Type): Type => (t.kind === 'pointer' ? pointerTo(strip(t.to)) : unqualified(t));
    if (type.kind === 'reference') {
      if (!value.isLvalue || !sameType(strip(value.type), strip(type.to), false))
        return this.error(row, `${typeName(value.type)} は const_cast で ${typeName(type)} に変換できません。`);
      return { ...value, type: type.to, isXvalue: type.isRvalue === true ? true : undefined };
    }
    const pointer = this.rvalue(value);
    if (
      type.kind !== 'pointer' ||
      pointer.type.kind !== 'pointer' ||
      !sameType(strip(pointer.type), strip(type), false)
    )
      return this.error(row, `${typeName(value.type)} は const_cast で ${typeName(type)} に変換できません。`);
    return { ...pointer, type };
  }

  /**
   * `dynamic_cast<T>(e)`, which checks the dynamic type of a polymorphic object: a pointer cast gives a null pointer
   * when the object is no `T`, and a reference cast throws `std::bad_cast`.
   */
  private dynamicCast(value: Expr, type: Type, row: number): Expr {
    const isReference = type.kind === 'reference';
    const target = isReference ? type.to : type.kind === 'pointer' ? type.to : undefined;
    const source = isReference ? value.type : this.rvalue(value).type;
    const from = isReference ? source : source.kind === 'pointer' ? source.to : undefined;
    if (target?.kind !== 'class' || from?.kind !== 'class')
      return this.error(row, 'dynamic_cast には、クラスへのポインタか参照を書いてください。');
    if (isConstType(from) && !isConstType(target))
      return this.error(row, `dynamic_cast では const を外せません（${typeName(source)}）。`);
    if (from.cls.isDerivedFrom(target.cls))
      return isReference
        ? this.castReference(value, type as Extract<Type, { kind: 'reference' }>, row, 'static')
        : this.convert(value, type, row);
    if (!from.cls.isPolymorphic)
      return this.error(row, `${typeName(from)} は仮想関数を持たないので、dynamic_cast できません。`);
    const cls = target.cls;
    const badCast = this.library.exception('bad_cast');
    if (isReference) {
      const run = value.run;
      return {
        type: target,
        isLvalue: true,
        row,
        run: (frame) => {
          const location = run(frame) as Ptr;
          const object = location.read();
          if (!(object instanceof CObject) || !outermostOwner(object).cls.isDerivedFrom(cls))
            throwLibrary(frame, badCast, 'std::bad_cast');
          return location.forClass(cls);
        },
      };
    }
    const run = this.rvalue(value).run;
    return {
      type,
      isLvalue: false,
      row,
      run: (frame) => {
        const location = run(frame) as Ptr;
        if (location.isNull) return NULL_PTR;
        const object = location.read();
        return object instanceof CObject && outermostOwner(object).cls.isDerivedFrom(cls)
          ? location.forClass(cls)
          : NULL_PTR;
      },
    };
  }

  /**
   * A fold expression (C++20 [expr.prim.fold]): `(xs + ...)` and `(0 + ... + xs)` fold from the right or the left,
   * applying the operator to the pack's elements in order.
   */
  private foldExpression(node: Syntax): Expr {
    const operator = (fieldOf(node, 'operator') as Syntax).type;
    const left = fieldOf(node, 'left') as Syntax;
    const right = fieldOf(node, 'right') as Syntax;
    const isPack = (side: Syntax): boolean => side.isNamed && packsIn(this, side).size > 0;
    const isRightFold = left.isNamed && isPack(left);
    const pattern = isRightFold ? left : right;
    const init = isRightFold ? (right.isNamed ? right : undefined) : left.isNamed ? left : undefined;
    const operands = packElements(this, pattern, node.row).map((element) => this.compileExpression(element));
    if (init) {
      const initial = this.compileExpression(init);
      if (isRightFold) operands.push(initial);
      else operands.unshift(initial);
    }
    if (operands.length === 0) {
      // An empty pack folds to the operator's identity, which only `&&`, `||`, and `,` have.
      if (operator === '&&') return constantExpr(BOOL, 1, node.row);
      if (operator === '||') return constantExpr(BOOL, 0, node.row);
      if (operator === ',') return { type: { kind: 'void' }, isLvalue: false, row: node.row, run: () => {} };
      return this.error(node.row, `空のパラメータパックは、演算子 ${operator} で畳み込めません。`);
    }
    // A right fold applies the operator from the last element back, a left fold from the first forward.
    const [first, ...rest] = isRightFold ? operands.toReversed() : operands;
    let folded = first;
    for (const operand of rest)
      folded = isRightFold
        ? this.foldOperation(operator, operand, folded, node.row)
        : this.foldOperation(operator, folded, operand, node.row);
    return folded;
  }

  private foldOperation(operator: string, left: Expr, right: Expr, row: number): Expr {
    if (operator === ',') return this.comma(left, right);
    if (operator.endsWith('=') && !['==', '!=', '<=', '>='].includes(operator))
      return this.assign(operator, left, right, row);
    return this.binary(ALTERNATIVE_TOKENS[operator] ?? operator, left, right, row);
  }

  private sizeofExpression(node: Syntax): Expr {
    if (node.all.some((child) => child.type === '...')) {
      const name = fieldOf(node, 'value') as Syntax;
      const entity = this.findName(name.text);
      if (entity?.kind !== 'pack') return this.error(node.row, `${name.text} はパラメータパックではありません。`);
      return constantExpr(SIZE_T, BigInt(entity.items.length), node.row);
    }
    const type = this.sizeofOperandType(node);
    if (type.kind === 'array' && type.variableLength) {
      // A variable-length array's size is its length at run time, times its element's.
      const array = this.compileExpression(fieldOf(node, 'value') as Syntax).run;
      const element = BigInt(sizeOf(type.of));
      return {
        type: SIZE_T,
        isLvalue: false,
        row: node.row,
        run: (frame) => BigInt(((array(frame) as Ptr).read() as ArrayStore).length) * element,
      };
    }
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

  protected typeOfExpression(operand: Syntax): Type {
    return this.unevaluated(() => this.compileExpression(operand).type);
  }

  protected decltypeOf(operand: Syntax): Type {
    const previous = this.isUnevaluated;
    this.isUnevaluated = true;
    try {
      // An unparenthesized name or member access gives the type its entity was declared with.
      if (operand.type === 'identifier' || operand.type === 'qualified_identifier') {
        const entity =
          operand.type === 'identifier' ? this.lookupName(operand.text, operand.row) : this.lookupQualified(operand);
        if (entity.kind === 'local') return entity.local.type;
        if (entity.kind === 'global') return entity.global.type;
        if (entity.kind === 'field') return entity.field.type;
        if (entity.kind === 'staticField') return entity.field.type;
      }
      const expr = this.compileExpression(operand);
      if (operand.type === 'field_expression' && expr.description !== undefined) return expr.type;
      if (expr.functions) {
        const [fn, ...others] = expr.functions.candidates;
        if (others.length > 0) return this.error(operand.row, `${expr.functions.name} はオーバーロードされています。`);
        return functionTypeOf(fn);
      }
      // Otherwise an lvalue gives a reference to its type.
      return expr.isLvalue && !expr.isXvalue ? referenceTo(expr.type) : expr.type;
    } finally {
      this.isUnevaluated = previous;
    }
  }

  /** `offsetof(T, member)`, the offset in bytes of a member in the objects of a standard-layout class. */
  private offsetOf(node: Syntax): Expr {
    const type = this.typeDescriptor(fieldOf(node, 'type') as Syntax);
    const member = fieldOf(node, 'member') as Syntax;
    if (type.kind !== 'class') return this.error(node.row, `${typeName(type)} はクラスではありません。`);
    const field = type.cls.fields.find((candidate) => candidate.name === member.text);
    if (!field) return this.error(node.row, `${typeName(type)} に ${member.text} というメンバはありません。`);
    return constantExpr(SIZE_T, BigInt(fieldSubobjectOffset(type.cls, field)), node.row);
  }

  /**
   * `_Generic(e, T1: v1, default: v2)` (a C11 feature clang++ accepts), which gives the value whose type is the
   * controlling expression's after array and function decay and without qualifiers.
   */
  private genericSelection(node: Syntax): Expr {
    const [control, ...associations] = node.children;
    const controlType = this.unevaluated(() => this.rvalue(this.compileExpression(control)).type);
    let fallback: Syntax | undefined;
    for (let index = 0; index + 1 < associations.length; index += 2) {
      const typeNode = associations[index];
      const value = associations[index + 1];
      if (typeNode.text === 'default') {
        fallback = value;
        continue;
      }
      if (sameType(unqualified(this.typeDescriptor(typeNode)), unqualified(controlType)))
        return this.compileExpression(value);
    }
    if (fallback) return this.compileExpression(fallback);
    return this.error(node.row, `_Generic に ${typeName(controlType)} 型に合うものがありません。`);
  }

  /** Runs `run` in an unevaluated operand. */
  unevaluated<T>(run: () => T): T {
    const previous = this.isUnevaluated;
    this.isUnevaluated = true;
    try {
      return run();
    } finally {
      this.isUnevaluated = previous;
    }
  }

  /** `T{...}`, a braced functional cast, which list-initializes a prvalue. */
  private bracedCast(node: Syntax): Expr {
    const typeNode = fieldOf(node, 'type') as Syntax;
    // `(T){...}` is a C99 compound literal, which clang++ makes a temporary as `T{...}`.
    const list = fieldOf(node, 'value') as Syntax;
    if (typeNode.type !== 'type_descriptor' && this.namedClassTemplate(typeNode)) {
      // `Box{1}` deduces a class template's arguments, from the lambdas it initializes the object with too.
      const nodes = expandPacks(this, list.children);
      const args = nodes.map((arg) => this.argument(arg));
      const saved = this.deducingLambdas;
      this.deducingLambdas = new Map(saved);
      for (const [index, arg] of nodes.entries())
        if (arg.type === 'lambda_expression') this.deducingLambdas.set(arg, args[index]);
      try {
        const type = this.withDeducedClass(typeNode, args, () => this.resolveTypeSpecifier(typeNode));
        return this.listObject(type, list, node.row);
      } finally {
        this.deducingLambdas = saved;
      }
    }
    const type =
      typeNode.type === 'type_descriptor' ? this.typeDescriptor(typeNode) : this.resolveTypeSpecifier(typeNode);
    return this.listObject(type, list, node.row);
  }

  private listObject(type: Type, list: Syntax, row: number): Expr {
    const value = this.listValue(type, list, true, row);
    const object = { ...value, onlyCalls: type.kind === 'class' };
    return list.children.length === 0 ? constantFunctor(type, object) : object;
  }

  // Calls -------------------------------------------------------------------------------------------------------------

  /** `va_start(ap, last)`, `va_end(ap)`, and `va_copy(dst, src)` of `<cstdarg>`, which work on a `va_list`. */
  private variadicMacro(name: string, argNodes: readonly Syntax[], row: number): Expr {
    const args = argNodes.map((arg) => this.compileExpression(arg));
    const [list, other] = args;
    if (!list?.isLvalue) return this.error(row, `${name} の最初の引数には va_list の変数を書いてください。`);
    if (name === 'va_start' && !this.context.fn?.isVariadic)
      return this.error(row, 'va_start は、可変長引数（...）をとる関数の中でしか使えません。');
    const location = list.run;
    const source = name === 'va_copy' && other ? this.rvalue(other).run : undefined;
    return {
      type: { kind: 'void' },
      isLvalue: false,
      row,
      run: (frame) => {
        const target = location(frame) as Ptr;
        if (name === 'va_start') target.write(startVariadicArguments(frame));
        else if (source) target.write(source(frame) as Ptr);
        return;
      },
    };
  }

  /** `va_arg(ap, T)`, the next argument of a variadic function, as a `T`. */
  private vaArgExpression(node: Syntax): Expr {
    const list = this.compileExpression(fieldOf(node, 'value') as Syntax);
    const type = unqualified(this.typeDescriptor(fieldOf(node, 'type') as Syntax));
    if (!list.isLvalue) return this.error(node.row, 'va_arg の最初の引数には va_list の変数を書いてください。');
    const location = list.run;
    return {
      type,
      isLvalue: false,
      row: node.row,
      run: (frame) => {
        const place = location(frame) as Ptr;
        const { value, next } = nextVariadicArgument(place.read() as Ptr, type);
        place.write(next);
        return value;
      },
    };
  }

  /**
   * `typeid(T)` or `typeid(e)`: the `std::type_info` of a type, or of the dynamic type of a polymorphic object, which
   * names the type as Apple clang++ does (C++20 [expr.typeid]).
   */
  private typeidExpression(node: Syntax): Expr {
    const { row } = node;
    const typeInfo = this.findStdName('type_info');
    if (typeInfo?.kind !== 'class') return this.error(row, 'typeid を使うには #include <typeinfo> を書いてください。');
    const { cls } = typeInfo;
    const result = { type: withConst(classType(cls)), isLvalue: true, row };
    const typeNode = fieldOf(node, 'type');
    if (typeNode) {
      const type = this.typeDescriptor(typeNode);
      return { ...result, run: (frame) => typeInfoObject(frame, cls, type, row) };
    }
    const valueNode = fieldOf(node, 'value') as Syntax;
    // `typeid(Base)` names a type with a name the grammar reads as an expression.
    const named = this.expressionAsType(valueNode);
    if (named) return { ...result, run: (frame) => typeInfoObject(frame, cls, named, row) };
    const probe = this.unevaluated(() => this.compileExpression(valueNode));
    const operandType = probe.type;
    if (!(probe.isLvalue && operandType.kind === 'class' && operandType.cls.isPolymorphic))
      return { ...result, run: (frame) => typeInfoObject(frame, cls, operandType, row) };
    // A polymorphic glvalue's typeid names the dynamic type of the object, which runs the operand.
    const operand = this.compileExpression(valueNode).run;
    return {
      ...result,
      run: (frame) => {
        const object = (operand(frame) as Ptr).read();
        const dynamic = object instanceof CObject ? classType(outermostOwner(object).cls) : operandType;
        return typeInfoObject(frame, cls, dynamic, row);
      },
    };
  }

  /** A type-trait builtin (`__is_class(T)`), a constant that tells whether its types have a property. */
  private typeTrait(name: string, argNodes: readonly Syntax[], row: number): Expr {
    const typeOf = (node: Syntax): Type =>
      this.expressionAsType(node) ?? this.error(row, `${name} の引数には型を書いてください（${node.text}）。`);
    const types = argNodes.map((arg) => (arg.type === PACK_ELEMENT ? withPackElement(this, arg, typeOf) : typeOf(arg)));
    if (Object.hasOwn(TYPE_QUERIES, name))
      return constantExpr(SIZE_T, BigInt(TYPE_QUERIES[name](this as never, types, row)), row);
    return constantExpr(BOOL, Number(TYPE_TRAITS[name](this as never, types, row)), row);
  }

  /** The expression or initializer that direct-initializes an object of a type from arguments (`T(args...)`). */
  directInitialization(type: Type, args: Expr[], row: number): Expr | Initializer {
    if (type.kind === 'class') return this.constructObject(type.cls, args, row, false);
    if (args.length === 0) return this.valueInitialized(type, row);
    if (args.length === 1) return this.convert(this.directInitializerArgument(type, args[0]), type, row);
    return this.error(row, `${typeName(type)} は値1つで初期化してください。`);
  }

  private callExpression(node: Syntax): Expr {
    const functionNode = fieldOf(node, 'function') as Syntax;
    const argsNode = fieldOf(node, 'arguments') as Syntax;
    const argNodes = expandPacks(this, argsNode.children);
    const isUnqualified = functionNode.type === 'identifier';
    if (isUnqualified && VARIADIC_MACROS.has(functionNode.text) && this.library.isFunctionMacro(functionNode.text))
      return this.variadicMacro(functionNode.text, argNodes, node.row);
    if (isUnqualified && this.library.isFunctionMacro(functionNode.text))
      return this.unsupported(functionNode.row, `マクロ（${functionNode.text}）`);
    // The grammar reads the `noexcept(e)` operator as a call.
    if (functionNode.type === 'identifier' && functionNode.text === 'noexcept' && argNodes.length === 1)
      return this.noexceptOperator(argNodes[0], node.row);
    if (
      isUnqualified &&
      (Object.hasOwn(TYPE_TRAITS, functionNode.text) || Object.hasOwn(TYPE_QUERIES, functionNode.text))
    )
      return this.typeTrait(functionNode.text, argNodes, node.row);
    const cast = this.utilityCast(functionNode, argNodes, node.row);
    if (cast) return cast;
    // `Box(5)` makes an instance of a class template, deducing its arguments from the call's.
    if (this.namedClassTemplate(functionNode)) {
      const args = argNodes.map((arg) => this.argument(arg));
      const deduced = this.withDeducedClass(functionNode, args, () => this.resolveTypeSpecifier(functionNode));
      if (deduced.kind === 'class') return this.constructObject(deduced.cls, args, node.row, false);
    }
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

  /**
   * `noexcept(e)`, which tells whether an unevaluated expression may throw: whether it calls a function that may, or
   * makes an object with `new` or `throw` (C++20 [expr.unary.noexcept]).
   */
  private noexceptOperator(operand: Syntax, row: number): Expr {
    const previous = { probe: this.noexceptProbe, unevaluated: this.isUnevaluated };
    const probe = { mayThrow: false };
    this.noexceptProbe = probe;
    this.isUnevaluated = true;
    try {
      this.compileExpression(operand);
    } finally {
      this.noexceptProbe = previous.probe;
      this.isUnevaluated = previous.unevaluated;
    }
    return constantExpr(BOOL, probe.mayThrow ? 0 : 1, row);
  }

  /**
   * `std::move(x)`, `std::forward<T>(x)`, and `std::as_const(x)` of `<utility>`, which only change the value category
   * or the constness of their argument (C++20 [utility]).
   */
  private utilityCast(functionNode: Syntax, argNodes: readonly Syntax[], row: number): Expr | undefined {
    const qualified = functionNode.type === 'qualified_identifier' && fieldOf(functionNode, 'scope')?.text === 'std';
    const named = qualified ? (fieldOf(functionNode, 'name') as Syntax) : functionNode;
    const plain = named.type === 'template_function' ? (fieldOf(named, 'name') as Syntax) : named;
    if (!['move', 'forward', 'as_const'].includes(plain.text) || argNodes.length !== 1) return undefined;
    // An unqualified name means std's only through `using namespace std;` with nothing else of that name.
    if (!qualified) {
      const entity = this.findName(plain.text);
      if (entity?.kind !== 'functions' || entity.functions.some((fn) => !fn.native)) return undefined;
    }
    const arg = this.compileExpression(argNodes[0]);
    if (arg.functions) return undefined;
    if (plain.text === 'as_const') {
      if (!arg.isLvalue || arg.isXvalue) return this.error(row, 'std::as_const には左辺値を渡してください。');
      return { ...arg, type: withConst(arg.type), onlyCalls: true };
    }
    if (plain.text === 'move') {
      if (!arg.isLvalue) return { ...this.materialize(arg), isXvalue: true, onlyCalls: true };
      return { ...arg, isXvalue: true, onlyCalls: true };
    }
    const list = named.type === 'template_function' ? fieldOf(named, 'arguments') : undefined;
    if (!list) return this.error(row, 'std::forward には <型> でテンプレート引数を書いてください。');
    const [type] = this.templateArguments(list);
    const isLvalue = type?.kind === 'reference' && !type.isRvalue;
    const value = arg.isLvalue ? arg : this.materialize(arg);
    return { ...value, isXvalue: isLvalue ? undefined : true, onlyCalls: true };
  }

  /** The type a call's function names, when the call is a functional cast `T(...)` rather than a function call. */
  private callTypeTarget(node: Syntax): Type | undefined {
    if (node.type === 'primitive_type' || node.type === 'sized_type_specifier' || node.type === 'template_type') {
      return this.resolveTypeSpecifier(node);
    }
    if (node.type === 'template_function') {
      const name = fieldOf(node, 'name') as Syntax;
      const found = name.type === 'qualified_identifier' ? this.lookupQualified(name) : this.findName(name.text);
      const entity = found && asTemplate(found);
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
    if (node.type === PACK_ELEMENT) return withPackElement(this, node, (pattern) => this.argument(pattern));
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
      const pointee = callee.type.kind === 'pointer' ? callee.type.to : callee.type;
      if (pointee.kind === 'function') return this.callThroughPointer(callee, pointee, args, row);
      if (callee.type.kind === 'class' && !callee.type.cls.library) {
        const overloaded = overloadedOperator(this, '()', [callee, ...args], row);
        if (overloaded) return overloaded.expr;
        const calls = memberOperators(callee.type.cls, 'operator()');
        if (calls.length > 0) this.resolve(`${typeName(callee.type)} の operator()`, calls, args, callee, row);
        return this.error(
          row,
          `${typeName(callee.type)} 型の値は関数として呼び出せません（operator() がありません）。`
        );
      }
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

  /** Calls the function a pointer to a function points to, with the arguments its type takes. */
  private callThroughPointer(callee: Expr, type: Extract<Type, { kind: 'function' }>, args: Expr[], row: number): Expr {
    const signature: FunctionInfo = {
      name: '(関数ポインタ)',
      displayName: typeName(callee.type),
      params: type.params.map((param) => ({ name: undefined, type: param, row })),
      ret: type.ret,
      isStatic: true,
      isVirtual: false,
      isConst: false,
      isPure: false,
      isConstructor: false,
      isDestructor: false,
      isOverride: false,
      isFinal: false,
      access: 'public',
      row,
      isAtomic: false,
      isDefined: true,
    };
    const resolved = this.resolve(`関数ポインタ（${typeName(callee.type)}）`, [signature], args, undefined, row);
    const argRuns = this.callArguments(signature, this.convertArguments(resolved, args), row);
    const target = this.rvalue(callee).run;
    const isReference = type.ret.kind === 'reference';
    const result = nonReference(type.ret);
    return {
      type: result,
      isLvalue: isReference,
      row,
      onlyCalls: true,
      isTemporaryObject: !isReference && result.kind === 'class',
      run: (frame) =>
        holdAll(frame, [target, ...argRuns], ([pointer, ...values]) => {
          if (!(pointer instanceof FunctionRef)) throw new CppRuntimeError('nullAccess');
          return invoke(frame, pointer.candidates[0], values, undefined, row, true);
        }),
    };
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

  /** A concept-id used as an expression (`std::integral<int>`), which is a constant of type `bool`. */
  protected abstract conceptId(node: Syntax): Expr | undefined;
  abstract isInitializerList(cls: ClassInfo): boolean;
  protected abstract instantiateVariableTemplate(info: ClassTemplateInfo, written: Type[], row: number): Entity;

  /** A lambda expression's closure object. */
  abstract lambdaExpression(node: Syntax): Expr;

  /** The non-member operator functions an operator expression may call, as unqualified lookup finds them. */
  nonMemberOperators(name: string, operands: Expr[]): FunctionInfo[] {
    const entity = this.findNonMemberName(name);
    const found = entity?.kind === 'functions' ? entity.functions.filter((fn) => !fn.owner && !fn.native) : [];
    return this.withArgumentDependentLookup(name, found, operands).filter((fn) => !fn.owner && !fn.native);
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
    // A library container takes a `std::initializer_list` as the range of its elements.
    const [only] = args;
    if (cls.library && args.length === 1 && only.type.kind === 'class' && this.isInitializerList(only.type.cls)) {
      const range = this.materialize(only);
      const ends = ['begin', 'end'].map((end) => this.callWith(this.member(range, end, row), [], row));
      return this.constructArguments(cls, ends, row, isBraced);
    }
    // A library class takes an object of the program's class through the class's conversion function.
    if (cls.library && args.length === 1 && only.type.kind === 'class' && !only.type.cls.library) {
      const conversions = [...only.type.cls.methods.values()].flat().filter((fn) => fn.isConversion);
      const conversion = conversions.length > 0 ? implicitConversion(this, only, classType(cls)) : undefined;
      if (conversion) return conversion.apply(only);
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
    if (this.noexceptProbe) this.noexceptProbe.mayThrow = true;
    const placement = this.placementOf(node);
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
      if (placement) return this.unsupported(node.row, '配列の配置 new（new (場所) 型[要素の数]）');
      return this.newArray(elementType, lengths[0], argsNode, node.row);
    }
    if (baseType.kind === 'void') return this.error(node.row, 'void のオブジェクトは new で作れません。');
    const type = unqualified(baseType);
    let initialize: Initializer;
    if (!argsNode) initialize = this.defaultInitializer(baseType, node.row);
    else if (argsNode.type === 'initializer_list') {
      initialize = this.listInitializer(type, argsNode, node.row, true);
    } else {
      const args = expandPacks(this, argsNode.children).map((arg) => this.argument(arg));
      if (type.kind === 'class')
        initialize = this.copyInitializer(type, this.constructObject(type.cls, args, node.row, false), node.row, false);
      else if (args.length === 0) initialize = this.valueInitialized(type, node.row).run as Eval<Value>;
      else if (args.length === 1)
        initialize = this.convert(this.directInitializerArgument(type, args[0]), type, node.row).run as Eval<Value>;
      else return this.error(node.row, `new ${typeName(type)}(...) には値を1つだけ書いてください。`);
    }
    if (placement) return this.placementNew(placement, type, initialize, node.row);
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

  /**
   * The pointer a placement `new (p) T` makes its object at, or undefined for an ordinary `new`, which
   * `new (std::nothrow) T` is too, since allocation never fails.
   */
  private placementOf(node: Syntax): Expr | undefined {
    const placement = fieldOf(node, 'placement');
    if (!placement) return undefined;
    const args = placement.children;
    if (args.length === 1 && /^(?:std::)?nothrow$/.test(args[0].text.replaceAll(/\s/g, ''))) return undefined;
    if (args.length !== 1) return this.unsupported(node.row, '引数が2つ以上の配置 new');
    const pointer = this.rvalue(this.compileExpression(args[0]));
    if (pointer.type.kind !== 'pointer')
      return this.error(node.row, `配置 new の場所には、ポインタを書いてください（${typeName(pointer.type)}）。`);
    return pointer;
  }

  /** `new (p) T(...)`, which makes an object of `T` where `p` points, as the object of `T` that was there. */
  private placementNew(pointer: Expr, type: Type, initialize: Initializer, row: number): Expr {
    const pointee = (pointer.type as Extract<Type, { kind: 'pointer' }>).to;
    if (pointee.kind !== 'void' && !sameType(unqualified(pointee), type, false))
      return this.unsupported(row, `${typeName(pointee)} の場所に ${typeName(type)} を作る配置 new`);
    const place = pointer.run;
    return {
      type: pointerTo(type),
      isLvalue: false,
      row,
      onlyCalls: type.kind === 'class',
      run: (frame) => {
        const written = place(frame) as Ptr;
        if (written.isNull) throw new CppRuntimeError('nullAccess');
        const location = pointee.kind === 'void' ? recoverPointee(written, type) : written;
        initializeAt(frame, type, location, location.readRaw(), (target) =>
          initialize(frame, target, false, 'full-expression')
        );
        return location;
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
    this.requireDestructorAccess(elementType, row);
    const destroy = this.destroyerOf(elementType);
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
      frame.runtime.deleteDepth++;
      try {
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
      } finally {
        frame.runtime.deleteDepth--;
      }
      return;
    };
    return { type: { kind: 'void' }, isLvalue: false, row: node.row, run: exec, onlyCalls: true };
  }

  /** The type of an `auto` variable, deduced from its initializer as a function template parameter would be. */
  deduceAuto(declared: Type, init: Expr, row: number): Type {
    if (!hasAuto(declared)) return declared;
    if (init.functions) {
      // A function's name decays to a pointer to the function, which must be the only one of that name.
      const [fn, ...others] = init.functions.candidates;
      if (others.length > 0)
        return this.error(row, `${init.functions.name} はオーバーロードされているので、auto の型が決まりません。`);
      if (fn.owner && !fn.isStatic) return this.unsupported(row, 'メンバ関数へのポインタ');
      return this.deduceAutoPattern(declared, pointerTo(functionTypeOf(fn)), row);
    }
    if (init.type.kind === 'void')
      return this.error(row, 'auto の変数の初期値に、値を返さない関数（void）の結果は使えません。');
    const decayed =
      init.type.kind === 'array' && !this.deducesArrays ? pointerTo(init.type.of) : unqualified(init.type);
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

/** A pointer's value; a pointer to a function, which only `==` and `!=` compare, keeps its function. */
const asPointer = (value: unknown): Ptr =>
  value instanceof Ptr || value instanceof FunctionRef ? (value as Ptr) : NULL_PTR;

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
export function thisLocation(frame: Frame): Ptr {
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

/**
 * Whether a floating operation that Apple clang++ folds is not a constant expression: a division by zero, or arithmetic
 * that produces a NaN (overflow to infinity stays constant).
 */
function isInvalidFloating(operator: string, type: ArithmeticType, divisor: number | bigint, result: unknown): boolean {
  if (type.kind !== 'float') return false;
  return (operator === '/' && Number(divisor) === 0) || Number.isNaN(Number(result));
}

/**
 * Whether a constant subscript designates an element of an array, or one past its end when the element is no array that
 * a further subscript could enter, as Apple clang++ accepts in a constant expression.
 */
function designatesElement(array: Type & { kind: 'array' }, offset: Expr, element: Type): boolean {
  if (offset.constant === undefined || array.length === undefined) return false;
  const index = Number(offset.constant);
  return index >= 0 && (index < array.length || (index === array.length && element.kind !== 'array'));
}

/** Whether a static member named through `object` keeps its constant value: the object is absent or a constant designation. */
function isConstantObject(object: Expr | undefined): boolean {
  return !object || evaluatesWithoutSideEffects(object);
}

/** The location of the complete `to` object that `location` designates a base of, stopping when it is no such object. */
function downcastLocation(location: Ptr, to: ClassInfo): Ptr {
  const object = location.read();
  let view: Ptr | undefined;
  if (object instanceof CObject)
    view = outermostOwner(object).cls.isDerivedFrom(to) ? location.forClass(to) : undefined;
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

/**
 * The promotion of a bit-field's type that its width allows: int when int holds every value of the width, else
 * unsigned int when that does, else none beyond its type's own (C++20 [conv.prom]).
 */
function bitFieldPromotionOf(type: Type, width: number): Extract<Type, { kind: 'int' }> | undefined {
  if (type.kind !== 'int' || type.enumeration || sizeOf(type) < 4) return undefined;
  const signed = isSigned(type);
  if (width < 32 || (signed && width === 32)) return INT;
  if (width === 32) return { kind: 'int', name: 'uint' };
  return undefined;
}

/** A bit-field's value after the promotion its width allows, or another value as it is. */
function promoteBitField(expr: Expr): Expr {
  const promotion = expr.bitFieldPromotion;
  if (!promotion || expr.isLvalue) return expr;
  return { ...convertArithmetic(expr, promotion), bitFieldPromotion: undefined };
}

/** Whether a class or one of its bases declares a member of a name. */
function hasMemberNamed(cls: ClassInfo, name: string): boolean {
  for (let owner: ClassInfo | undefined = cls; owner; owner = owner.base) {
    if (owner.ownFields.some((field) => field.name === name) || owner.methods.has(name)) return true;
    if (owner.staticFields.has(name) || owner.constants.has(name) || owner.memberTypes.has(name)) return true;
    if (owner.secondaryBases.some((secondary) => hasMemberNamed(secondary.cls, name))) return true;
  }
  return false;
}

const typeInfoObjects = new WeakMap<object, Map<string, Ptr>>();

/**
 * The `std::type_info` object that names a type, one for each name in a run of a program, which names the type when a
 * program first asks, since a type the interpreter cannot name stops only the program that asks.
 */
function typeInfoObject(frame: Frame, cls: ClassInfo, type: Type, row: number): Ptr {
  let name: string;
  try {
    name = typeInfoName(type, row);
  } catch (error) {
    if (error instanceof CompileError) throw new CppRuntimeError('custom', error.diagnostics[0]?.message);
    throw error;
  }
  let objects = typeInfoObjects.get(frame.runtime);
  if (!objects) {
    objects = new Map();
    typeInfoObjects.set(frame.runtime, objects);
  }
  let location = objects.get(name);
  if (!location) {
    const object = new CObject(
      cls,
      cls.fields.map(() => UNINIT)
    );
    object.values[0] = new Ptr(cStringStore(name), 0);
    const box = new Box(object);
    location = box.location(0);
    object.completeLocation = location;
    objects.set(name, location);
  }
  return location;
}

/** The macros of `<cstdarg>` that the compiler gives the meaning of. */
const VARIADIC_MACROS = new Set(['va_start', 'va_end', 'va_copy']);
