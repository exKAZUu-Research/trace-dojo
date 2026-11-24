import type { Compiler } from './compiler';
import { AUTO } from './compilerBase';
import type { Expr, Initializer } from './expr';
import { initializeAt, newObject } from './objectCompiler';
import { templateParameters } from './programTemplates';
import type { Eval, Frame } from './runtime';
import type { CaptureLookup, Entity, FunctionContext } from './scopes';
import { fieldOf, type Syntax } from './syntax';
import {
  ClassInfo,
  classType,
  type FieldInfo,
  type FunctionInfo,
  isConstType,
  nonReference,
  pointerTo,
  referenceTo,
  type Type,
  unqualified,
} from './types';
import type { Value } from './values';

/** How a lambda captures a variable: a copy, or a reference to it. */
interface Capture {
  name: string;
  field: FieldInfo;
  byReference: boolean;
  /** The initializer of an init-capture (`[x = 1]`), else the variable's name. */
  source: Syntax;
  /** The element of a pack the capture holds, which compiles in place of `source`. */
  element?: () => Expr;
}

/**
 * The captures of a lambda's body, which name lookup in the body consults before the enclosing scopes: the variables
 * it captures become members of its closure type (C++20 [expr.prim.lambda.capture]).
 */
class LambdaCaptures implements CaptureLookup {
  readonly captures: Capture[] = [];
  /** The member holding the enclosing object's `this` (`[this]`), or its copy (`[*this]`). */
  thisCapture: { field: FieldInfo; byCopy: boolean } | undefined;
  private readonly explicit = new Map<string, Capture>();

  constructor(
    private readonly compiler: Compiler,
    readonly closure: ClassInfo,
    private readonly enclosing: FunctionContext,
    private readonly enclosingClass: ClassInfo | undefined,
    private readonly defaultCapture: '=' | '&' | undefined,
    private readonly thisAllowed: boolean
  ) {}

  /** Adds a capture the lambda names: `x`, `&x`, `x = e`, or `&x = e`. */
  addExplicit(name: string, type: Type, byReference: boolean, source: Syntax, row: number): void {
    if (this.explicit.has(name) || this.packs.has(name)) this.compiler.error(row, `${name} はすでに取り込んでいます。`);
    const capture = this.addField(name, type, byReference, source, row);
    this.explicit.set(name, capture);
  }

  /**
   * Adds the captures of a pack's elements (`[args...]`, `[...xs = args]`), which the body names as a pack, each
   * initialized from the element of `pack` at its position.
   */
  addPack(name: string, pack: Extract<Entity, { kind: 'pack' }>, byReference: boolean, source: Syntax): void {
    if (this.explicit.has(name) || this.packs.has(name))
      this.compiler.error(source.row, `${name} はすでに取り込んでいます。`);
    const captures = pack.items.map((item, index) => {
      const element = (): Expr => this.compiler.entityExpr(item, source, false);
      const value = element();
      const type = byReference ? value.type : unqualified(this.compiler.deduceAuto(AUTO, value, source.row));
      const capture = this.addField(`${name}#${index}`, type, byReference, source, source.row);
      capture.element = element;
      return capture;
    });
    this.packs.set(name, captures);
  }

  private readonly packs = new Map<string, Capture[]>();

  captureThis(byCopy: boolean, row: number): void {
    const owner = this.enclosingClass;
    if (!owner || this.enclosing.isStaticContext)
      this.compiler.error(row, 'this は、static でないメンバ関数の中のラムダ式でしか取り込めません。');
    if (this.thisCapture) this.compiler.error(row, 'this はすでに取り込んでいます。');
    const type: Type = byCopy
      ? classType(owner, this.enclosing.isConstMember)
      : pointerTo(classType(owner, this.enclosing.isConstMember));
    const field = this.newField('\0this', type, row);
    this.thisCapture = { field, byCopy };
  }

  lookup(name: string): Entity | undefined {
    const capture = this.explicit.get(name);
    if (capture) return { kind: 'field', field: capture.field };
    const pack = this.packs.get(name);
    if (pack) return { kind: 'pack', items: pack.map((element) => ({ kind: 'field', field: element.field })) };
    const outer = this.enclosing.lookupLocal(name) ?? this.enclosing.captures?.lookup(name);
    const variableType = outer && capturableType(outer);
    if (!outer || !variableType) return outer;
    if (outer.kind === 'local') {
      if (outer.staticStorage) return outer;
      // A constant variable of literal type is usable without a capture, since reading it uses no object.
      if (!outer.isReference && outer.constant !== undefined && isConstType(outer.local.type)) return outer;
    }
    const implicit = this.implicitCaptures.get(name);
    if (implicit) return { kind: 'field', field: implicit.field };
    if (!this.defaultCapture) {
      return {
        kind: 'value',
        make: (row) =>
          this.compiler.error(
            row,
            `ラムダ式の中では、取り込んでいない変数 ${name} は使えません（[${name}] や [&] で取り込んでください）。`
          ),
      };
    }
    const type = variableType;
    const nameNode: Syntax = {
      type: 'identifier',
      text: name,
      row: this.closure.row,
      endRow: this.closure.row,
      start: 0,
      end: 0,
      isNamed: true,
      field: undefined,
      all: [],
      children: [],
    };
    const added = this.addField(name, type, this.defaultCapture === '&', nameNode, this.closure.row);
    this.implicitCaptures.set(name, added);
    return { kind: 'field', field: added.field };
  }

  private readonly implicitCaptures = new Map<string, Capture>();

  /** Captures every variable of the enclosing scopes that a body names, and the enclosing object if there is one. */
  captureNamed(body: Syntax): void {
    const visit = (node: Syntax): void => {
      if (node.type === 'identifier') this.lookup(node.text);
      for (const child of node.children) visit(child);
    };
    visit(body);
    if (this.enclosingClass && !this.enclosing.isStaticContext && !this.thisCapture) this.thisObject(body.row);
  }

  /** The enclosing object, which the body's implicit member accesses and `this` use. */
  thisObject(row: number): Expr | undefined {
    if (!this.thisCapture) {
      if (!this.thisAllowed || !this.defaultCapture || !this.enclosingClass || this.enclosing.isStaticContext)
        return undefined;
      this.captureThis(false, row);
    }
    return this.compiler.capturedThisObject(this.thisCapture as { field: FieldInfo; byCopy: boolean }, row);
  }

  private addField(name: string, type: Type, byReference: boolean, source: Syntax, row: number): Capture {
    if (type.kind === 'void') this.compiler.error(row, `void の値は取り込めません（${name}）。`);
    const fieldType = byReference ? referenceTo(type) : type;
    const capture: Capture = { name, field: this.newField(name, fieldType, row), byReference, source };
    this.captures.push(capture);
    return capture;
  }

  private newField(name: string, type: Type, row: number): FieldInfo {
    const field: FieldInfo = {
      name: `\0capture ${name}`,
      type,
      index: this.closure.fields.length,
      access: 'private',
      owner: this.closure,
      row,
    };
    this.closure.fields.push(field);
    return field;
  }
}

/**
 * The type of the variable a name denotes when a lambda can capture it: a local variable, or what an enclosing
 * lambda captured.
 */
function capturableType(entity: Entity): Type | undefined {
  if (entity.kind === 'local') return nonReference(entity.local.type);
  if (entity.kind === 'field' && entity.field.owner.isLambda && entity.field.name.startsWith('\0capture '))
    return nonReference(entity.field.type);
  return undefined;
}

/**
 * Compiles a lambda expression: its closure type, a class whose function call operator runs the body, and the
 * closure object the expression creates (C++20 [expr.prim.lambda]).
 */
export function compileLambda(compiler: Compiler, node: Syntax): Expr {
  const { row } = node;
  const closure = new ClassInfo('(lambda)', 'class');
  closure.row = row;
  closure.isLambda = true;
  const enclosing = compiler.context;
  const enclosingClass = enclosing.cls;
  closure.outer = enclosingClass;
  const captureList = fieldOf(node, 'captures') as Syntax;
  const defaultNode = captureList.children.find((child) => child.type === 'lambda_default_capture');
  const defaultCapture = defaultNode ? (defaultNode.text as '=' | '&') : undefined;
  const captures = new LambdaCaptures(compiler, closure, enclosing, enclosingClass, defaultCapture, true);
  readCaptureList(compiler, captures, captureList);
  const declarator = fieldOf(node, 'declarator');
  const isMutable = declarator?.children.some((child) => child.type === 'lambda_specifier' && child.text === 'mutable');
  const trailing = declarator?.children.find((child) => child.type === 'trailing_return_type');
  const parameters = declarator ? fieldOf(declarator, 'parameters') : undefined;
  const templateList = fieldOf(node, 'template_parameters');
  const isGeneric =
    templateList !== undefined ||
    (parameters?.children.some((parameter) => fieldOf(parameter, 'type')?.type === 'placeholder_type_specifier') ??
      false);
  if (isGeneric) {
    // A generic lambda's call operator is a template, whose instances compile after the closure object's captures
    // are known: a default capture captures every variable of the enclosing scopes the body names.
    if (defaultCapture) captures.captureNamed(node.children.find((child) => child.field === 'body') as Syntax);
    const parameterList = templateList ? templateParameters(templateList) : [];
    compiler.declareGenericLambda(
      closure,
      genericCallOperator(node, isMutable === true, trailing),
      parameterList,
      captures
    );
  } else {
    const ret = trailing ? compiler.typeDescriptor(trailing.children[0]) : AUTO;
    const call: FunctionInfo = {
      name: 'operator()',
      displayName: '(lambda)::operator()',
      params: parameters ? compiler.parameters(parameters) : [],
      ret,
      owner: closure,
      isStatic: false,
      isVirtual: false,
      isInline: false,
      isConst: !isMutable,
      isNoexcept: declarator?.children.some((child) => child.type === 'noexcept') === true,
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
    closure.methods.set('operator()', [call]);
    compiler.compileLambdaBody(call, node, captures);
  }
  compiler.completeClass(closure, true);
  const initializers = captures.captures.map((capture) => ({
    field: capture.field,
    initialize: captureInitializer(compiler, capture),
  }));
  const thisInitializer = captures.thisCapture && thisValue(compiler, captures.thisCapture.byCopy, row);
  const thisField = captures.thisCapture?.field;
  return {
    type: classType(closure),
    isLvalue: false,
    row,
    isTemporaryObject: true,
    run: (frame, _zeroInitialize, destination) => {
      const object = newObject(frame, closure, false, destination);
      for (const { field, initialize } of initializers) {
        initializeAt(frame, field.type, object.location(field.index), object.values[field.index], (target) =>
          initialize(frame, target)
        );
      }
      if (thisField && thisInitializer) object.values[thisField.index] = thisInitializer(frame) as Value;
      object.needsConstruction = false;
      return object;
    },
  };
}

/**
 * A function definition for a generic lambda's call operator: `auto operator()(params) const -> ret { body }`, as a
 * member function template's pattern.
 */
function genericCallOperator(node: Syntax, isMutable: boolean, trailing: Syntax | undefined): Syntax {
  const token = (type: string, field?: string, isNamed = false): Syntax => ({
    ...node,
    type,
    text: type,
    field,
    isNamed,
    all: [],
    children: [],
  });
  const declarator = fieldOf(node, 'declarator');
  const parameters = (declarator && fieldOf(declarator, 'parameters')) ?? token('parameter_list', 'parameters', true);
  const name: Syntax = { ...token('field_identifier', 'declarator', true), text: 'operator()' };
  const qualifiers = isMutable ? [] : [{ ...token('type_qualifier', undefined, true), text: 'const' }];
  const parts = [name, { ...parameters, field: 'parameters' }, ...qualifiers, ...(trailing ? [trailing] : [])];
  const functionDeclarator: Syntax = {
    ...token('function_declarator', 'declarator', true),
    all: parts,
    children: parts.filter((part) => part.isNamed),
  };
  const autoType: Syntax = { ...token('placeholder_type_specifier', 'type', true), text: 'auto' };
  const body = node.children.find((child) => child.field === 'body') as Syntax;
  const all = [autoType, functionDeclarator, body];
  return { ...node, type: 'function_definition', all, children: all };
}

function readCaptureList(compiler: Compiler, captures: LambdaCaptures, list: Syntax): void {
  let pending: string | undefined;
  for (const child of list.all) {
    if (!child.isNamed) {
      if (child.type === '&' || child.type === '*') pending = child.type;
      continue;
    }
    const byReference = pending === '&';
    const isDeref = pending === '*';
    pending = undefined;
    switch (child.type) {
      case 'lambda_default_capture': {
        break;
      }
      case 'this': {
        captures.captureThis(isDeref, child.row);
        break;
      }
      case 'identifier': {
        const entity = compiler.findName(child.text);
        const type = entity && capturableType(entity);
        if (!type || (entity.kind === 'local' && entity.staticStorage))
          return compiler.error(child.row, `${child.text} は、取り込める変数（関数の中の変数）ではありません。`);
        captures.addExplicit(child.text, type, byReference, child, child.row);
        break;
      }
      case 'parameter_pack_expansion': {
        const pattern = fieldOf(child, 'pattern') as Syntax;
        const entity = compiler.findName(pattern.text);
        if (pattern.type !== 'identifier' || entity?.kind !== 'pack')
          return compiler.error(child.row, `${child.text} には、取り込む関数の引数のパックを書いてください。`);
        captures.addPack(pattern.text, entity, byReference, pattern);
        break;
      }
      case 'lambda_capture_initializer': {
        const left = fieldOf(child, 'left') as Syntax;
        const right = fieldOf(child, 'right') as Syntax;
        const isReference = child.all.some((token) => token.type === '&');
        // `[...xs = args]` captures each element of a pack.
        const packEntity = child.all.some((token) => token.type === '...') ? compiler.findName(right.text) : undefined;
        if (packEntity?.kind === 'pack') {
          captures.addPack(left.text, packEntity, isReference, right);
          break;
        }
        const expr = compiler.compileExpression(right);
        const type = isReference ? expr.type : compiler.deduceAuto(AUTO, expr, child.row);
        if (isReference && !expr.isLvalue)
          compiler.error(child.row, `参照で取り込む ${left.text} には、変数などの場所を持つ値を書いてください。`);
        captures.addExplicit(left.text, isReference ? type : unqualified(type), isReference, right, child.row);
        break;
      }
      default: {
        compiler.unsupported(child.row, `ラムダ式の取り込み ${child.text}`);
      }
    }
  }
}

/** Initializes a capture's member from the variable or the init-capture's expression, in the enclosing scope. */
function captureInitializer(compiler: Compiler, capture: Capture): Initializer {
  const expr = capture.element ? capture.element() : compiler.compileExpression(capture.source);
  const { type } = capture.field;
  if (type.kind === 'reference') return compiler.referenceInitializer(type, expr, capture.source.row);
  return compiler.copyInitializer(type, expr, capture.source.row, false);
}

function thisValue(compiler: Compiler, byCopy: boolean, row: number): Eval<Value> {
  const pointer = compiler.compileThis(row);
  if (!byCopy) return pointer.run as Eval<Value>;
  const object = compiler.dereference(pointer, row);
  const copy = compiler.copyInitializer(unqualified(object.type), object, row, false);
  return (frame: Frame) => copy(frame) as Value;
}
