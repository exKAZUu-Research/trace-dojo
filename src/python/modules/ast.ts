// CPython's ast module: CPython's own `ast.py` and `_ast_unparse.py` over the node classes of `_ast`, with the trees
// compile() builds for `ast.parse` from this interpreter's syntax tree.
import { PyAttribute } from '../attributeDescriptors';
import { allocateInstance } from '../cTypes';
import { builtin } from '../define';
import { registerAstSupport } from '../dynamicCode';
import { defineNew } from '../instances';
import { importModule } from '../modules';
import { callValue } from '../objects';
import { withPythonTree } from '../parse';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { defineMethod, None, objectClass } from '../types';
import { PyClass, PyInstance, PyTuple, type PyValue } from '../values';
import { AstBuilder, isInteractiveStatement } from './astBuilder';
import { AST_NODES_SOURCE } from './astNodesSource';
import { optimizeTree } from './astOptimizer';
import { AST_SOURCE } from './astSource';
import { AST_UNPARSE_SOURCE } from './astUnparseSource';

registerSourceModule(
  '_ast',
  AST_NODES_SOURCE,
  () => new Map([['_node_layout', builtin('_node_layout', 'one', 1, 1, ([cls]) => nodeLayout(cls as PyClass))]])
);

/**
 * Gives a node class written in Python here the namespace of CPython's C node type: no entries of the class
 * statement, and the field annotations as `__annotations_cache__`, which CPython's type keeps them under.
 */
function nodeLayout(cls: PyClass): PyValue {
  for (const name of ['__firstlineno__', '__static_attributes__', '__annotate_func__']) cls.dict.delete(name);
  const annotations = cls.dict.get('__annotations__');
  if (annotations !== undefined) {
    cls.dict.delete('__annotations__');
    cls.dict.set('__annotations_cache__', annotations);
  }
  const [base] = cls.bases;
  if (cls.bases.length === 0 || base?.name === 'object') {
    // AST is a C type with its own attribute slots; each of its subclasses adds the weak reference slot.
    weakrefs.set(cls, cls.dict.get('__weakref__'));
    defineNew(cls, (subclass) => allocateInstance(subclass));
    cls.dict.delete('__weakref__');
    for (const name of ['__getattribute__', '__setattr__', '__delattr__']) {
      const slot = objectClass.dict.get(name) as PyValue;
      defineMethod(cls, name, (self, args, kwargs) => callValue(slot, [self, ...args], kwargs));
    }
  } else if (base && weakrefs.has(base)) {
    const weakref = weakrefs.get(base);
    cls.dict.set(
      '__weakref__',
      weakref instanceof PyAttribute
        ? new PyAttribute('getset', '__weakref__', cls, weakref.get, weakref.set, weakref.doc)
        : (weakref as PyValue)
    );
  }
  // The positions a node class's objects may lack, which CPython's type gives None by default.
  const attributes = cls.dict.get('_attributes');
  if (attributes instanceof PyTuple && attributes.items.includes('end_lineno') && !REQUIRED_END.has(cls.name)) {
    cls.dict.set('end_lineno', None);
    cls.dict.set('end_col_offset', None);
  }
  return None;
}

/** The node classes whose objects always have their end positions, which CPython's grammar does not make optional. */
const REQUIRED_END = new Set(['pattern', 'type_param']);

/** The `__weakref__` descriptor of AST, which its direct subclasses have in CPython. */
const weakrefs = new WeakMap<PyClass, PyValue | undefined>();
registerSourceModule('ast', AST_SOURCE);
registerSourceModule('_ast_unparse', AST_UNPARSE_SOURCE);

const singletons = new WeakMap<Runtime, Map<string, PyValue>>();

function singletonsOf(runtime: Runtime): Map<string, PyValue> {
  let shared = singletons.get(runtime);
  if (!shared) {
    shared = new Map();
    singletons.set(runtime, shared);
  }
  return shared;
}

registerAstSupport({
  parse: (source, mode, syntaxError) => {
    const runtime = currentRuntime();
    const classes = importModule(runtime, '_ast').dict;
    return withPythonTree(source, (root) => {
      // Only the grammar decides here: ast.parse accepts what only compiling rejects, such as `return` outside a function.
      if (root.hasError) throw syntaxError('ast.parse() に渡したコードの構文エラー');
      if (mode === 'single' && !isInteractiveStatement(root)) {
        throw syntaxError('multiple statements found while compiling a single statement');
      }
      return new AstBuilder(source, classes, singletonsOf(runtime), syntaxError).module(root, mode);
    });
  },
  optimize: (tree, level) => optimizeTree(tree, level, importModule(currentRuntime(), '_ast').dict),
  unparse: (tree) => callValue(importModule(currentRuntime(), 'ast').dict.get('unparse') as PyValue, [tree]) as string,
  isTree: (value) => {
    const base = currentRuntime().modules.get('_ast')?.dict.get('AST');
    return base instanceof PyClass && value instanceof PyInstance && value.cls.isSubclassOf(base);
  },
});
