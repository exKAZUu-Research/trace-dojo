import type { Entity } from '../entities';
import { newError } from '../errorValues';
import { addMethod, definePackage, fn, namedType, nativeFunction, opaqueType, typeEntity } from '../native';
import { GoPanic } from '../runtime';
import { ANY, BASIC, ERROR_TYPE, pointerTo, sliceOf, type StructType, type Type } from '../types';
import { Cell, type GoMap, GoStruct, Pointer, Slice, type Value } from '../values';
import { IO_WRITER } from './io';
import {
  ANY_SLICE,
  BOOL,
  BYTES,
  byteSlice,
  bytesOf,
  callMethod,
  receiverStruct,
  sliceValues,
  STRING,
  stringPanic,
} from './support';
import { EXEC_ERROR, type ExecTemplate, execute, type MissingKey } from './templateExec';
import {
  BUILTINS,
  evalArgs,
  goodFunc,
  goodName,
  htmlEscape,
  htmlEscapeString,
  isTrue,
  jsEscape,
  jsEscapeString,
  queryEscape,
} from './templateFuncs';
import { sprintf } from './templateLex';
import { isEmptyTree, parseTrees, TemplateParseError, type Tree } from './templateParse';
import { funcTypeOf, kindOf, type RV, type RValue, valueOf } from './templateReflect';

/** `*parse.Tree`, which programs only pass from one template to another. */
const TREE = opaqueType(namedType('text/template/parse', 'Tree', { kind: 'struct', fields: [] }));
TREE.unsupported = new Set(['Name', 'ParseName', 'Root', 'Mode', 'Copy', 'ErrorContext', 'Parse']);

const FILE_MEMBERS = ['ParseFiles', 'ParseGlob', 'ParseFS'];

/** `template.Template`, whose embedded `*parse.Tree` is its only field programs see. */
const TEMPLATE = opaqueType(namedType('text/template', 'Template', { kind: 'struct', fields: [] }));
(TEMPLATE.underlying as StructType).fields.push({ name: 'Tree', type: pointerTo(TREE), embedded: true });
TEMPLATE.unsupported = new Set([...FILE_MEMBERS, ...(TREE.unsupported as Set<string>)]);
const TEMPLATE_POINTER = pointerTo(TEMPLATE);

const FUNC_MAP = namedType('text/template', 'FuncMap', { kind: 'map', key: BASIC.string, value: ANY });

/** The templates, options, and functions that associated templates share (`common`). */
class Common {
  readonly tmpl = new Map<string, Template>();
  missingKey: MissingKey = 'invalid';
  readonly parseFuncs = new Map<string, Value>();
  readonly execFuncs = new Map<string, RV>();
}

const treePointers = new WeakMap<Tree, Pointer>();

/** The state of a `*Template`, which the Go value keeps in `native`. */
class Template implements ExecTemplate {
  common: Common | undefined;
  leftDelim = '';
  rightDelim = '';
  readonly pointer: Pointer;

  constructor(
    readonly name: string,
    existing?: Pointer
  ) {
    this.pointer = existing ?? new Pointer(new Cell(new GoStruct([undefined])), 'v');
    (this.pointer.load() as GoStruct).native = { template: this };
  }

  get tree(): Tree | undefined {
    const pointer = (this.pointer.load() as GoStruct).fields[0] as Pointer | undefined;
    return (pointer?.load() as GoStruct | undefined)?.native?.tree as Tree | undefined;
  }

  set tree(tree: Tree | undefined) {
    (this.pointer.load() as GoStruct).fields[0] = tree && treePointer(tree);
  }

  get missingKey(): MissingKey {
    return this.common?.missingKey ?? 'invalid';
  }

  init(): Common {
    this.common ??= new Common();
    return this.common;
  }

  lookup(name: string): Template | undefined {
    return this.common?.tmpl.get(name);
  }

  execFunc(name: string): RV | undefined {
    return this.common?.execFuncs.get(name);
  }

  newAssociated(name: string): Template {
    const common = this.init();
    const template = new Template(name);
    template.common = common;
    template.leftDelim = this.leftDelim;
    template.rightDelim = this.rightDelim;
    return template;
  }

  parse(text: string): Value[] {
    const common = this.init();
    let trees: Map<string, Tree>;
    try {
      trees = parseTrees(
        this.name,
        text,
        this.leftDelim,
        this.rightDelim,
        (name) => common.parseFuncs.get(name) !== undefined || BUILTINS.has(name)
      );
    } catch (error) {
      if (error instanceof TemplateParseError) return [undefined, newError(error.message)];
      throw error;
    }
    for (const [name, tree] of trees) this.addParseTree(name, tree);
    return [this.pointer, undefined];
  }

  addParseTree(name: string, tree: Tree | undefined): Template {
    this.init();
    const template = name === this.name ? this : this.newAssociated(name);
    if (this.associate(template, tree) || !template.tree) template.tree = tree;
    return template;
  }

  private associate(template: Template, tree: Tree | undefined): boolean {
    const common = this.common as Common;
    const old = common.tmpl.get(template.name);
    if (old && isEmptyTree(tree?.root) && old.tree) return false;
    common.tmpl.set(template.name, template);
    return true;
  }

  clone(): Template {
    const clone = this.copy(undefined);
    const common = clone.init();
    if (!this.common) return clone;
    common.missingKey = this.common.missingKey;
    for (const [name, template] of this.common.tmpl) {
      common.tmpl.set(name, name === this.name ? clone : template.copy(common));
    }
    for (const [name, value] of this.common.parseFuncs) common.parseFuncs.set(name, value);
    for (const [name, value] of this.common.execFuncs) common.execFuncs.set(name, value);
    return clone;
  }

  private copy(common: Common | undefined): Template {
    const copy = new Template(this.name);
    copy.tree = this.tree;
    copy.common = common;
    copy.leftDelim = this.leftDelim;
    copy.rightDelim = this.rightDelim;
    return copy;
  }

  funcs(funcMap: GoMap | undefined): void {
    const common = this.init();
    for (const { key, value } of funcMap?.entries.values() ?? []) {
      const name = key as string;
      if (!goodName(name)) throw new GoPanic(newError(sprintf('function name %q is not a valid identifier', name)));
      const fnValue = valueOf(value);
      if (kindOf(fnValue) !== 'func') stringPanic(`value for ${name} not a function`);
      const bad = goodFunc(name, funcTypeOf(fnValue as RV));
      if (bad) throw new GoPanic(newError(bad));
      common.execFuncs.set(name, fnValue as RV);
    }
    for (const { key, value } of funcMap?.entries.values() ?? []) common.parseFuncs.set(key as string, value);
  }

  option(option: string): void {
    const common = this.init();
    if (option === '') stringPanic('empty option string');
    const [key, value] = option.split(/=(.*)/s);
    if (key === 'missingkey' && option.includes('=')) {
      if (value === 'invalid' || value === 'default') {
        common.missingKey = 'invalid';
        return;
      }
      if (value === 'zero' || value === 'error') {
        common.missingKey = value;
        return;
      }
    }
    stringPanic(`unrecognized option: ${option}`);
  }

  definedTemplates(): string {
    if (!this.common) return '';
    let text = '';
    for (const [name, template] of this.common.tmpl) {
      if (!template.tree?.root) continue;
      text += text === '' ? '; defined templates are: ' : ', ';
      text += sprintf('%q', name);
    }
    return text;
  }
}

function treePointer(tree: Tree): Pointer {
  let pointer = treePointers.get(tree);
  if (!pointer) {
    pointer = new Pointer(new Cell(new GoStruct([], { tree })), 'v');
    treePointers.set(tree, pointer);
  }
  return pointer;
}

/** The state of a `*Template` receiver, which a zero `Template` gets on first use. */
function templateOf(receiver: Value): Template {
  const struct = receiverStruct(receiver);
  const existing = struct.native?.template as Template | undefined;
  return existing ?? new Template('', receiver as Pointer);
}

function method(
  name: string,
  params: Type[],
  results: Type[],
  impl: (template: Template, args: Value[]) => Value | Value[],
  variadic = false
): void {
  addMethod(TEMPLATE, name, fn(params, results, variadic), (receiver, args) => impl(templateOf(receiver), args), true);
}

method('Name', [], [STRING], (template) => template.name);
method('New', [STRING], [TEMPLATE_POINTER], (template, [name]) => template.newAssociated(name as string).pointer);
method('Parse', [STRING], [TEMPLATE_POINTER, ERROR_TYPE], (template, [text]) => template.parse(text as string));
method('Execute', [IO_WRITER, ANY], [ERROR_TYPE], (template, [wr, data]) => execute(template, wr, data));
method('ExecuteTemplate', [IO_WRITER, STRING, ANY], [ERROR_TYPE], (template, [wr, name, data]) => {
  const target = template.lookup(name as string);
  if (!target) {
    return newError(sprintf('template: no template %q associated with template %q', name as string, template.name));
  }
  return execute(target, wr, data);
});
method('Lookup', [STRING], [TEMPLATE_POINTER], (template, [name]) => template.lookup(name as string)?.pointer);
method('Templates', [], [sliceOf(TEMPLATE_POINTER)], (template) => {
  if (!template.common) return;
  const pointers = [...template.common.tmpl.values()].map((each) => each.pointer);
  return new Slice(pointers, 0, pointers.length, pointers.length);
});
method('Funcs', [FUNC_MAP], [TEMPLATE_POINTER], (template, [funcMap]) => {
  template.funcs(funcMap as GoMap | undefined);
  return template.pointer;
});
method(
  'Option',
  [sliceOf(STRING)],
  [TEMPLATE_POINTER],
  (template, [options]) => {
    template.init();
    for (const option of sliceValues(options)) template.option(option as string);
    return template.pointer;
  },
  true
);
method('Delims', [STRING, STRING], [TEMPLATE_POINTER], (template, [left, right]) => {
  template.init();
  template.leftDelim = left as string;
  template.rightDelim = right as string;
  return template.pointer;
});
method('Clone', [], [TEMPLATE_POINTER, ERROR_TYPE], (template) => [template.clone().pointer, undefined]);
method('AddParseTree', [STRING, pointerTo(TREE)], [TEMPLATE_POINTER, ERROR_TYPE], (template, [name, tree]) => {
  const parsed = ((tree as Pointer | undefined)?.load() as GoStruct | undefined)?.native?.tree as Tree | undefined;
  return [template.addParseTree(name as string, parsed).pointer, undefined];
});
method('DefinedTemplates', [], [STRING], (template) => template.definedTemplates());

/** Writes through an io.Writer, as the escaping functions do. */
function writerOf(writer: Value): (bytes: string) => void {
  return (bytes) => {
    callMethod(writer, 'Write', [byteSlice(bytes)]);
  };
}

function anyArgs(args: Value): RValue[] {
  return sliceValues(args).map((value): RV => ({ type: ANY, value }));
}

const members: Record<string, Entity> = {
  Template: typeEntity(TEMPLATE),
  FuncMap: typeEntity(FUNC_MAP),
  ExecError: typeEntity(EXEC_ERROR),
  New: nativeFunction('New', fn([STRING], [TEMPLATE_POINTER]), ([name]) => new Template(name as string).pointer),
  Must: nativeFunction('Must', fn([TEMPLATE_POINTER, ERROR_TYPE], [TEMPLATE_POINTER]), ([template, error]) => {
    if (error !== undefined) throw new GoPanic(error);
    return template;
  }),
  HTMLEscape: nativeFunction('HTMLEscape', fn([IO_WRITER, BYTES], []), ([writer, bytes]) => {
    htmlEscape(writerOf(writer), bytesOf(bytes));
    return;
  }),
  HTMLEscapeString: nativeFunction('HTMLEscapeString', fn([STRING], [STRING]), ([text]) =>
    htmlEscapeString(text as string)
  ),
  HTMLEscaper: nativeFunction('HTMLEscaper', fn([ANY_SLICE], [STRING], true), ([args]) =>
    htmlEscapeString(evalArgs(anyArgs(args)))
  ),
  JSEscape: nativeFunction('JSEscape', fn([IO_WRITER, BYTES], []), ([writer, bytes]) => {
    jsEscape(writerOf(writer), bytesOf(bytes));
    return;
  }),
  JSEscapeString: nativeFunction('JSEscapeString', fn([STRING], [STRING]), ([text]) => jsEscapeString(text as string)),
  JSEscaper: nativeFunction('JSEscaper', fn([ANY_SLICE], [STRING], true), ([args]) =>
    jsEscapeString(evalArgs(anyArgs(args)))
  ),
  URLQueryEscaper: nativeFunction('URLQueryEscaper', fn([ANY_SLICE], [STRING], true), ([args]) =>
    queryEscape(evalArgs(anyArgs(args)))
  ),
  IsTrue: nativeFunction('IsTrue', fn([ANY], [BOOL, BOOL]), ([value]) => isTrue(valueOf(value))),
};

export const TEXT_TEMPLATE_PACKAGE = definePackage('text/template', members, FILE_MEMBERS);
