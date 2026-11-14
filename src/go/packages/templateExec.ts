// code-gauge-allow-file fileNcss 575 -- Keeps template control evaluation and its shared callback context together.
import { Printer } from '../fmt';
import { compareMapKeys } from '../mapOrder';
import { addMethod, currentRuntime, fn, namedType, nativeFunc } from '../native';
import { nilPointerPanic } from '../runtimeErrors';
import {
  BASIC,
  ERROR_TYPE,
  type FuncType,
  integerBits,
  pointerTo,
  type SliceType,
  type Type,
  typeString,
  underlying,
} from '../types';
import { Complex, type GoFunc, type GoMap, GoStruct, Iface, Slice, type Value } from '../values';
import { errorf } from './fmt';
import { callMethod, errorText } from './support';
import {
  BranchPanic,
  BUILTINS,
  CALL_FUNC,
  goodFunc,
  isTrue,
  printableValue,
  safeCall,
  shown,
  truth,
} from './templateFuncs';
import { sprintf, toInterface } from './templateLex';
import type {
  BranchNode,
  ChainNode,
  CommandNode,
  FieldNode,
  IdentifierNode,
  Node,
  NumberNode,
  PipeNode,
  TemplateNode,
  Tree,
  VariableNode,
} from './templateParse';
import { nodeString } from './templateParse';
import {
  addrOf,
  assignableTo,
  canBeNil,
  elem,
  fieldByIndex,
  fieldByName,
  funcTypeOf,
  indexOf,
  indirect,
  indirectInterface,
  isExportedName,
  isMissing,
  isNilValue,
  kindOf,
  lengthOf,
  methodByName,
  MISSING,
  REFLECT_VALUE,
  type RV,
  type RValue,
  rvString,
  toGoValue,
  typeKind,
  valueOf,
  zeroRV,
} from './templateReflect';

export type MissingKey = 'invalid' | 'zero' | 'error';

/** What the executor needs of a template: its tree, the templates and functions it shares, and its options. */
export interface ExecTemplate {
  readonly name: string;
  readonly tree: Tree | undefined;
  lookup(name: string): ExecTemplate | undefined;
  execFunc(name: string): RV | undefined;
  readonly missingKey: MissingKey;
}

/** `template.ExecError`, the error of a failed execution. */
export const EXEC_ERROR = namedType('text/template', 'ExecError', {
  kind: 'struct',
  fields: [
    { name: 'Name', type: BASIC.string, embedded: false },
    { name: 'Err', type: ERROR_TYPE, embedded: false },
  ],
});
addMethod(EXEC_ERROR, 'Error', fn([], [BASIC.string]), (receiver) => errorText((receiver as GoStruct).fields[1]));
addMethod(EXEC_ERROR, 'Unwrap', fn([], [ERROR_TYPE]), (receiver) => (receiver as GoStruct).fields[1]);

const MAX_EXEC_DEPTH = 100_000;

/** Stands for a field or map entry that a receiver lacks. */
const NOT_FOUND = Symbol('notFound');

/** A failed execution, carrying the error Execute returns. */
class ExecFailure {
  constructor(readonly error: Value) {}
}

interface Variable {
  name: string;
  value: RValue;
}

type FmtArg = string | number | Iface | undefined;

/** `Template.execute`: applies the template to `data`, writing to `wr`, and returns the error, if any. */
export function execute(tmpl: ExecTemplate, wr: Value, data: Value): Value {
  const value = valueOf(data);
  const state = new State(tmpl, wr, [{ name: '$', value }], 0);
  try {
    const root = tmpl.tree?.root;
    if (!root) state.errorf('%q is an incomplete or empty template', tmpl.name);
    state.walk(value, root as Node);
    return undefined;
  } catch (error) {
    if (error instanceof ExecFailure) return error.error;
    if (error instanceof DepthExceeded) {
      try {
        error.state.errorf('exceeded maximum template depth (%v)', MAX_EXEC_DEPTH);
      } catch (error_) {
        return (error_ as ExecFailure).error;
      }
    }
    throw error;
  }
}

/**
 * Template recursion deeper than the JavaScript stack allows, which stands for Go's limit of nested templates; the
 * state is that of the innermost template call, which reports the error.
 */
class DepthExceeded {
  constructor(readonly state: State) {}
}

/** The state of one template's execution, as exec.go's `state`. */
class State {
  private node: Node | undefined;

  constructor(
    private readonly tmpl: ExecTemplate,
    private readonly wr: Value,
    private vars: Variable[],
    private readonly depth: number
  ) {}

  errorf(format: string, ...args: FmtArg[]): never {
    const name = doublePercent(this.tmpl.name);
    let full: string;
    if (this.node) {
      const [location, context] = (this.node.tr as Tree).errorContext(this.node);
      full = sprintf('template: %s: executing %q at <%s>: %s', location, name, doublePercent(context), format);
    } else {
      full = sprintf('template: %s: %s', name, format);
    }
    this.fail(errorf(full, args.map(toInterface)));
  }

  private fail(error: Value): never {
    throw new ExecFailure(new Iface(EXEC_ERROR, new GoStruct([this.tmpl.name, error])));
  }

  walk(dot: RValue, node: Node): void {
    currentRuntime().spend();
    this.node = node;
    switch (node.type) {
      case 'action': {
        const value = this.evalPipeline(dot, node.pipe);
        if (node.pipe.decl.length === 0) this.printValue(node, value);
        return;
      }
      case 'break':
      case 'continue': {
        throw new BranchPanic(node.type);
      }
      case 'comment': {
        return;
      }
      case 'if':
      case 'with': {
        this.walkIfOrWith(node, dot);
        return;
      }
      case 'list': {
        for (const child of node.nodes) this.walk(dot, child);
        return;
      }
      case 'range': {
        this.walkRange(dot, node);
        return;
      }
      case 'template': {
        this.walkTemplate(dot, node);
        return;
      }
      case 'text': {
        this.write(node.text);
        return;
      }
      default: {
        this.errorf('unknown node: %s', nodeString(node));
      }
    }
  }

  private write(bytes: string): void {
    if (!(this.wr instanceof Iface)) nilPointerPanic();
    const array = Array.from(bytes, (char) => BigInt(char.codePointAt(0) as number));
    const [, error] = callMethod(this.wr, 'Write', [new Slice(array, 0, array.length, array.length)]) as Value[];
    if (error !== undefined) throw new ExecFailure(error);
  }

  private mark(): number {
    return this.vars.length;
  }

  private pop(mark: number): void {
    this.vars = this.vars.slice(0, mark);
  }

  private setVar(name: string, value: RValue): void {
    for (let index = this.mark() - 1; index >= 0; index--) {
      if (this.vars[index].name === name) {
        this.vars[index].value = value;
        return;
      }
    }
    this.errorf('undefined variable: %s', name);
  }

  private setTopVar(n: number, value: RValue): void {
    this.vars[this.vars.length - n].value = value;
  }

  private varValue(name: string): RValue {
    for (let index = this.mark() - 1; index >= 0; index--) {
      if (this.vars[index].name === name) return this.vars[index].value;
    }
    return this.errorf('undefined variable: %s', name);
  }

  private walkIfOrWith(node: BranchNode, dot: RValue): void {
    const mark = this.mark();
    try {
      const value = this.evalPipeline(dot, node.pipe);
      const [truthValue, ok] = isTrue(indirectInterface(value));
      if (!ok) this.errorf("if/with can't use %v", shown(value));
      if (truthValue) this.walk(node.type === 'with' ? value : dot, node.list);
      else if (node.elseList) this.walk(dot, node.elseList);
    } finally {
      this.pop(mark);
    }
  }

  private walkRange(dot: RValue, node: BranchNode): void {
    this.node = node;
    const outerMark = this.mark();
    try {
      const [value] = indirect(this.evalPipeline(dot, node.pipe));
      if (this.rangeOver(value, node)) return;
      if (node.elseList) this.walk(dot, node.elseList);
    } catch (error) {
      if (!(error instanceof BranchPanic && error.branch === 'break')) throw error;
    } finally {
      this.pop(outerMark);
    }
  }

  /** Runs the iterations of a range, returning whether there were any. */
  // code-gauge-allow functionCognitiveComplexity 25 -- A transcription of the kinds Go's walkRange iterates over.
  private rangeOver(value: RValue, node: BranchNode): boolean {
    const mark = this.mark();
    const oneIteration = (index: RValue, element: RValue): void => this.oneIteration(node, mark, index, element);
    const kind = kindOf(value);
    if (kind === 'int' || kind === 'uint') {
      const range = value as RV;
      if (node.pipe.decl.length > 1) this.errorf("can't use %v to iterate over more than one variable", shown(range));
      const count = range.value as bigint;
      for (let index = 0n; index < count; index++) oneIteration(undefined, { type: range.type, value: index });
      return count > 0n;
    }
    if (kind === 'array' || kind === 'slice') {
      const length = lengthOf(value as RV);
      for (let index = 0; index < length; index++) {
        oneIteration({ type: BASIC.int, value: BigInt(index) }, indexOf(value as RV, index));
      }
      return length > 0;
    }
    if (kind === 'map') {
      const map = value as RV;
      const { key, value: valueType } = underlying(map.type) as { key: Type; value: Type };
      const entries = [...((map.value as GoMap | undefined)?.entries.values() ?? [])].toSorted((a, b) =>
        compareMapKeys(a.key, b.key, key)
      );
      for (const entry of entries)
        oneIteration({ type: key, value: entry.key }, { type: valueType, value: entry.value });
      return entries.length > 0;
    }
    if (kind === 'invalid') return false;
    if (kind === 'func') {
      const ran = this.rangeOverFunc(value as RV, node, oneIteration);
      if (ran !== undefined) return ran;
    }
    return this.errorf("range can't iterate over %v", shown(value));
  }

  /** Ranges over an iterator function, or returns undefined for a function that is not one. */
  private rangeOverFunc(
    value: RV,
    node: BranchNode,
    oneIteration: (index: RValue, element: RValue) => void
  ): boolean | undefined {
    const yieldType = seqYield(funcTypeOf(value));
    if (!yieldType) return undefined;
    if (yieldType.params.length === 1 && node.pipe.decl.length > 1) {
      this.errorf("can't use %v iterate over more than one variable", shown(value));
    }
    let ran = false;
    const [first, second] = yieldType.params;
    const yieldFunc = nativeFunc((args) => {
      ran = true;
      const key: RV = { type: first, value: args[0] };
      if (yieldType.params.length === 1) oneIteration(undefined, key);
      else if (node.pipe.decl.length > 1) oneIteration(key, { type: second, value: args[1] });
      else oneIteration(undefined, key);
      return true;
    });
    const iterator = value.value as GoFunc | undefined;
    if (!iterator) nilPointerPanic();
    iterator.call([yieldFunc]);
    return ran;
  }

  private oneIteration(node: BranchNode, mark: number, index: RValue, element: RValue): void {
    const { decl, isAssign } = node.pipe;
    if (decl.length > 0) {
      if (isAssign) this.setVar(decl[0].ident[0], decl.length > 1 ? index : element);
      else this.setTopVar(1, element);
    }
    if (decl.length > 1) {
      if (isAssign) this.setVar(decl[1].ident[0], element);
      else this.setTopVar(2, index);
    }
    try {
      this.walk(element, node.list);
    } catch (error) {
      if (!(error instanceof BranchPanic && error.branch === 'continue')) throw error;
    } finally {
      this.pop(mark);
    }
  }

  private walkTemplate(dotArg: RValue, node: TemplateNode): void {
    this.node = node;
    const tmpl = this.tmpl.lookup(node.name);
    if (!tmpl) this.errorf('template %q not defined', node.name);
    if (this.depth === MAX_EXEC_DEPTH) this.errorf('exceeded maximum template depth (%v)', MAX_EXEC_DEPTH);
    const dot = this.evalPipeline(dotArg, node.pipe);
    const state = new State(tmpl, this.wr, [{ name: '$', value: dot }], this.depth + 1);
    if (!tmpl.tree) nilPointerPanic();
    try {
      state.walk(dot, tmpl.tree.root as Node);
    } catch (error) {
      if (error instanceof RangeError && error.message.includes('call stack')) {
        this.node = node;
        throw new DepthExceeded(this);
      }
      throw error;
    }
  }

  private evalPipeline(dot: RValue, pipe: PipeNode | undefined): RValue {
    if (!pipe) return undefined;
    this.node = pipe;
    let value: RValue = MISSING;
    for (const command of pipe.cmds) {
      value = this.evalCommand(dot, command, value);
      if (value && typeKind(value.type) === 'interface' && isEmptyInterface(value.type)) value = elem(value);
    }
    for (const variable of pipe.decl) {
      if (pipe.isAssign) this.setVar(variable.ident[0], value);
      else this.vars.push({ name: variable.ident[0], value });
    }
    return value;
  }

  private notAFunction(args: Node[], final: RValue): void {
    if (args.length > 1 || !isMissing(final))
      this.errorf("can't give argument to non-function %s", nodeString(args[0]));
  }

  private evalCommand(dot: RValue, command: CommandNode, final: RValue): RValue {
    currentRuntime().spend();
    const firstWord = command.args[0];
    switch (firstWord.type) {
      case 'field': {
        return this.evalFieldNode(dot, firstWord, command.args, final);
      }
      case 'chain': {
        return this.evalChainNode(dot, firstWord, command.args, final);
      }
      case 'identifier': {
        return this.evalFunction(dot, firstWord, command, command.args, final);
      }
      case 'pipe': {
        this.notAFunction(command.args, final);
        return this.evalPipeline(dot, firstWord);
      }
      case 'variable': {
        return this.evalVariableNode(dot, firstWord, command.args, final);
      }
    }
    this.node = firstWord;
    this.notAFunction(command.args, final);
    switch (firstWord.type) {
      case 'bool': {
        return { type: BASIC.bool, value: firstWord.value };
      }
      case 'dot': {
        return dot;
      }
      case 'nil': {
        return this.errorf('nil is not a command');
      }
      case 'number': {
        return this.idealConstant(firstWord);
      }
      case 'string': {
        return { type: BASIC.string, value: firstWord.text };
      }
    }
    return this.errorf("can't evaluate command %q", nodeString(firstWord));
  }

  private idealConstant(constant: NumberNode): RValue {
    this.node = constant;
    if (constant.isComplex) return { type: BASIC.complex128, value: constant.complex128 };
    if (
      constant.isFloat &&
      !isHexInt(constant.text) &&
      !constant.text.startsWith("'") &&
      /[.eEpP]/.test(constant.text)
    ) {
      return { type: BASIC.float64, value: constant.float64 };
    }
    if (constant.isInt) return { type: BASIC.int, value: constant.int64 };
    if (constant.isUint) this.errorf('%s overflows int', constant.text);
    return undefined;
  }

  private evalFieldNode(dot: RValue, field: FieldNode, args: Node[], final: RValue): RValue {
    this.node = field;
    return this.evalFieldChain(dot, dot, field, field.ident, args, final);
  }

  private evalChainNode(dot: RValue, chain: ChainNode, args: Node[] | undefined, final: RValue): RValue {
    this.node = chain;
    if (chain.field.length === 0) this.errorf('internal error: no fields in evalChainNode');
    if (chain.node.type === 'nil') this.errorf('indirection through explicit nil in %s', nodeString(chain));
    const pipe = this.evalArg(dot, undefined, chain.node);
    return this.evalFieldChain(dot, pipe, chain, chain.field, args, final);
  }

  private evalVariableNode(dot: RValue, variable: VariableNode, args: Node[] | undefined, final: RValue): RValue {
    this.node = variable;
    const value = this.varValue(variable.ident[0]);
    if (variable.ident.length === 1) {
      this.notAFunction(args ?? [], final);
      return value;
    }
    return this.evalFieldChain(dot, value, variable, variable.ident.slice(1), args, final);
  }

  private evalFieldChain(
    dot: RValue,
    receiverArg: RValue,
    node: Node,
    ident: string[],
    args: Node[] | undefined,
    final: RValue
  ): RValue {
    let receiver = receiverArg;
    for (const name of ident.slice(0, -1)) receiver = this.evalField(dot, name, node, undefined, MISSING, receiver);
    return this.evalField(dot, ident.at(-1) as string, node, args, final, receiver);
  }

  private evalFunction(
    dot: RValue,
    node: IdentifierNode,
    command: Node,
    args: Node[] | undefined,
    final: RValue
  ): RValue {
    this.node = node;
    const name = node.ident;
    const fromTemplate = this.tmpl.execFunc(name);
    const fun = fromTemplate ?? BUILTINS.get(name);
    if (!fun) this.errorf('%q is not a defined function', name);
    return this.evalCall(dot, fun, !fromTemplate, command, name, args, final);
  }

  // code-gauge-allow functionCognitiveComplexity 20 -- A transcription of Go's evalField.
  private evalField(
    dot: RValue,
    fieldName: string,
    node: Node,
    args: Node[] | undefined,
    final: RValue,
    receiverArg: RValue
  ): RValue {
    if (!receiverArg) {
      if (this.tmpl.missingKey === 'error') this.errorf('nil data; no entry for key %q', fieldName);
      return undefined;
    }
    const typ = typeString(receiverArg.type);
    const [indirected, isNil] = indirect(receiverArg);
    const receiver = indirected as RV;
    if (kindOf(receiver) === 'interface' && isNil) this.errorf('nil pointer evaluating %s.%s', typ, fieldName);
    let ptr = receiver;
    if (kindOf(ptr) !== 'interface' && kindOf(ptr) !== 'pointer' && ptr.addr) ptr = addrOf(ptr);
    const method = methodByName(ptr, fieldName);
    if (method) return this.evalCall(dot, method, false, node, fieldName, args, final);
    const hasArgs = (args?.length ?? 0) > 1 || !isMissing(final);
    const kind = kindOf(receiver);
    if (kind === 'struct') {
      const field = this.structField(receiver, fieldName, typ, hasArgs);
      if (field !== NOT_FOUND) return field;
    } else if (kind === 'map') {
      const entry = this.mapEntry(receiver, fieldName, hasArgs);
      if (entry !== NOT_FOUND) return entry;
    } else if (kind === 'pointer') {
      const element = (underlying(receiver.type) as { element: Type }).element;
      if (isNil && (typeKind(element) !== 'struct' || fieldByName(element, fieldName))) {
        this.errorf('nil pointer evaluating %s.%s', typ, fieldName);
      }
    }
    return this.errorf("can't evaluate field %s in type %s", fieldName, typ);
  }

  private structField(receiver: RV, fieldName: string, typ: string, hasArgs: boolean): RValue | typeof NOT_FOUND {
    const field = fieldByName(receiver.type, fieldName);
    if (!field) return NOT_FOUND;
    const [value, error] = fieldByIndex(receiver, field.index);
    if (!isExportedName(fieldName)) this.errorf('%s is an unexported field of struct type %s', fieldName, typ);
    if (error !== undefined) this.errorf('%v', error);
    if (hasArgs) this.errorf('%s has arguments but cannot be invoked as function', fieldName);
    return value;
  }

  private mapEntry(receiver: RV, fieldName: string, hasArgs: boolean): RValue | typeof NOT_FOUND {
    const { key, value: valueType } = underlying(receiver.type) as { key: Type; value: Type };
    if (!assignableTo(BASIC.string, key)) return NOT_FOUND;
    if (hasArgs) this.errorf('%s is not a method but has arguments', fieldName);
    const map = receiver.value as GoMap | undefined;
    const keyValue = toGoValue({ type: BASIC.string, value: fieldName }, key);
    const entry = map?.entries.get(map.keyOf(keyValue));
    if (entry) return { type: valueType, value: entry.value };
    if (this.tmpl.missingKey === 'zero') return zeroRV(valueType);
    if (this.tmpl.missingKey === 'error') this.errorf('map has no entry for key %q', fieldName);
    return undefined;
  }

  private evalCall(
    dot: RValue,
    funArg: RV,
    isBuiltin: boolean,
    node: Node,
    name: string,
    argNodes: Node[] | undefined,
    final: RValue
  ): RValue {
    let fun = funArg;
    const args = argNodes ? argNodes.slice(1) : [];
    const type = funcTypeOf(fun);
    const numParams = type.params.length;
    const numIn = isMissing(final) ? args.length : args.length + 1;
    if (type.variadic) {
      if (numIn < numParams - 1) {
        this.errorf('wrong number of args for %s: want at least %d got %d', name, numParams - 1, args.length);
      }
    } else if (numIn !== numParams) {
      this.errorf('wrong number of args for %s: want %d got %d', name, numParams, numIn);
    }
    const bad = goodFunc(name, type);
    if (bad) this.errorf('%v', bad);
    if (isBuiltin && (name === 'and' || name === 'or')) return this.evalAndOr(dot, name, args, final);
    let argv = this.evalCallArgs(dot, type, args, final);
    if (isBuiltin && name === 'call') {
      const calleeName = args.length === 0 ? rvString(final) : nodeString(args[0]);
      argv = [{ type: BASIC.string, value: calleeName }, ...argv];
      fun = CALL_FUNC;
    }
    const [value, error] = safeCall(fun, argv);
    if (error !== undefined) {
      this.node = node;
      this.errorf('error calling %s: %w', name, error as Iface);
    }
    return value;
  }

  /** `and` and `or`, which evaluate their arguments only until the result is known. */
  private evalAndOr(dot: RValue, name: string, args: Node[], final: RValue): RValue {
    let value: RValue;
    for (const arg of args) {
      value = this.evalArg(dot, REFLECT_VALUE, arg);
      if (truth(value) === (name === 'or')) return value;
    }
    if (!isMissing(final)) value = this.validateType(final, REFLECT_VALUE);
    return value;
  }

  /** The arguments of a call, of the parameters' types, where the previous command's value comes last. */
  private evalCallArgs(dot: RValue, type: FuncType, args: Node[], final: RValue): RValue[] {
    const numParams = type.params.length;
    const numFixed = type.variadic ? numParams - 1 : args.length;
    const argv: RValue[] = [];
    let index = 0;
    for (; index < numFixed && index < args.length; index++) {
      argv.push(this.evalArg(dot, type.params[index], args[index]));
    }
    if (type.variadic) {
      const argType = (underlying(type.params[numParams - 1]) as SliceType).element;
      for (; index < args.length; index++) argv.push(this.evalArg(dot, argType, args[index]));
    }
    if (!isMissing(final)) {
      let finalType = type.params[numParams - 1];
      if (type.variadic) {
        finalType = args.length < numFixed ? type.params[args.length] : (underlying(finalType) as SliceType).element;
      }
      argv.push(this.validateType(final, finalType));
    }
    return argv;
  }

  // code-gauge-allow functionCognitiveComplexity 23 -- A transcription of Go's validateType.
  private validateType(valueArg: RValue, type: Type | undefined): RValue {
    let value = valueArg;
    if (!value) {
      if (!type) return undefined;
      if (canBeNil(type)) return zeroRV(type);
      this.errorf('invalid value; expected %s', typeString(type));
    }
    if (type === REFLECT_VALUE) return value;
    if (type && !assignableTo(value.type, type)) {
      if (kindOf(value) === 'interface' && !isNilValue(value)) {
        value = elem(value) as RV;
        if (assignableTo(value.type, type)) return value;
      }
      if (kindOf(value) === 'pointer' && assignableTo((underlying(value.type) as { element: Type }).element, type)) {
        const element = elem(value);
        if (!element) this.errorf('dereference of nil pointer of type %s', typeString(type));
        value = element;
      } else if (value.addr && assignableTo(pointerTo(value.type), type)) {
        value = addrOf(value);
      } else {
        this.errorf('wrong type for value; expected %s; got %s', typeString(type), typeString(value.type));
      }
    }
    return value;
  }

  // code-gauge-allow functionCognitiveComplexity 30 -- A transcription of Go's evalArg, one case per node and kind.
  private evalArg(dot: RValue, type: Type | undefined, node: Node): RValue {
    this.node = node;
    switch (node.type) {
      case 'dot': {
        return this.validateType(dot, type);
      }
      case 'nil': {
        if (canBeNil(type as Type)) return zeroRV(type as Type);
        return this.errorf('cannot assign nil to %s', typeString(type as Type));
      }
      case 'field': {
        return this.validateType(this.evalFieldNode(dot, node, [node], MISSING), type);
      }
      case 'variable': {
        return this.validateType(this.evalVariableNode(dot, node, undefined, MISSING), type);
      }
      case 'pipe': {
        return this.validateType(this.evalPipeline(dot, node), type);
      }
      case 'identifier': {
        return this.validateType(this.evalFunction(dot, node, node, undefined, MISSING), type);
      }
      case 'chain': {
        return this.validateType(this.evalChainNode(dot, node, undefined, MISSING), type);
      }
    }
    const argType = type as Type;
    if (argType === REFLECT_VALUE) return this.evalEmptyInterface(dot, node);
    switch (typeKind(argType)) {
      case 'bool': {
        if (node.type === 'bool') return { type: argType, value: node.value };
        return this.errorf('expected bool; found %s', nodeString(node));
      }
      case 'complex': {
        if (node.type === 'number' && node.isComplex) return { type: argType, value: roundComplex(argType, node) };
        return this.errorf('expected complex; found %s', nodeString(node));
      }
      case 'float': {
        if (node.type === 'number' && node.isFloat) {
          const value = isBasicKind(argType, 'float32') ? Math.fround(node.float64) : node.float64;
          return { type: argType, value };
        }
        return this.errorf('expected float; found %s', nodeString(node));
      }
      case 'int': {
        if (node.type === 'number' && node.isInt) return { type: argType, value: wrapInteger(argType, node.int64) };
        return this.errorf('expected integer; found %s', nodeString(node));
      }
      case 'interface': {
        if (isEmptyInterface(argType)) return this.evalEmptyInterface(dot, node);
        break;
      }
      case 'string': {
        if (node.type === 'string') return { type: argType, value: node.text };
        return this.errorf('expected string; found %s', nodeString(node));
      }
      case 'uint': {
        if (node.type === 'number' && node.isUint) return { type: argType, value: wrapInteger(argType, node.uint64) };
        return this.errorf('expected unsigned integer; found %s', nodeString(node));
      }
    }
    return this.errorf("can't handle %s for arg of type %s", nodeString(node), typeString(argType));
  }

  private evalEmptyInterface(dot: RValue, node: Node): RValue {
    this.node = node;
    switch (node.type) {
      case 'bool': {
        return { type: BASIC.bool, value: node.value };
      }
      case 'dot': {
        return dot;
      }
      case 'field': {
        return this.evalFieldNode(dot, node, [], MISSING);
      }
      case 'identifier': {
        return this.evalFunction(dot, node, node, undefined, MISSING);
      }
      case 'nil': {
        return this.errorf("evalEmptyInterface: nil (can't happen)");
      }
      case 'number': {
        return this.idealConstant(node);
      }
      case 'string': {
        return { type: BASIC.string, value: node.text };
      }
      case 'variable': {
        return this.evalVariableNode(dot, node, undefined, MISSING);
      }
      case 'pipe': {
        return this.evalPipeline(dot, node);
      }
    }
    return this.errorf("can't handle assignment of %s to empty interface argument", nodeString(node));
  }

  private printValue(node: Node, value: RValue): void {
    this.node = node;
    const [printable, ok] = printableValue(value);
    if (!ok) this.errorf("can't print %s of type %s", nodeString(node), typeString((value as RV).type));
    this.write(new Printer().print([printable]));
  }
}

function doublePercent(text: string): string {
  return text.replaceAll('%', '%%');
}

function isHexInt(text: string): boolean {
  return text.length > 2 && text[0] === '0' && (text[1] === 'x' || text[1] === 'X') && !/[pP]/.test(text);
}

function isEmptyInterface(type: Type): boolean {
  const under = underlying(type);
  return under.kind === 'interface' && under.methods.length === 0;
}

function isBasicKind(type: Type, kind: string): boolean {
  const under = underlying(type);
  return under.kind === 'basic' && under.basic === kind;
}

function wrapInteger(type: Type, value: bigint): bigint {
  const under = underlying(type);
  const { bits, signed } = integerBits(under.kind === 'basic' ? under.basic : 'int');
  return signed ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

function roundComplex(type: Type, node: NumberNode): Complex {
  if (!isBasicKind(type, 'complex64')) return node.complex128;
  return new Complex(Math.fround(node.complex128.re), Math.fround(node.complex128.im));
}

/** The yield function type of an iterator function type (`func(yield func(V) bool)` or with two values), if it is one. */
function seqYield(type: FuncType): FuncType | undefined {
  if (type.params.length !== 1 || type.results.length > 0 || type.variadic) return undefined;
  const yieldType = underlying(type.params[0]);
  if (yieldType.kind !== 'func' || yieldType.variadic || yieldType.results.length !== 1) return undefined;
  if (typeKind(yieldType.results[0]) !== 'bool') return undefined;
  if (yieldType.params.length !== 1 && yieldType.params.length !== 2) return undefined;
  return yieldType;
}
