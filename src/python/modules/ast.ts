// CPython's ast module: CPython's own `ast.py` and `_ast_unparse.py` over the node classes of `_ast`, with the trees
// compile() builds for `ast.parse` from this interpreter's syntax tree.
import { registerAstSupport } from '../dynamicCode';
import { importModule } from '../modules';
import { callValue } from '../objects';
import { withPythonTree } from '../parse';
import type { Runtime } from '../runtime';
import { currentRuntime } from '../runtimeContext';
import { registerSourceModule } from '../sourceModules';
import { PyClass, PyInstance, type PyValue } from '../values';
import { AstBuilder, isInteractiveStatement } from './astBuilder';
import { AST_NODES_SOURCE } from './astNodesSource';
import { optimizeTree } from './astOptimizer';
import { AST_SOURCE } from './astSource';
import { AST_UNPARSE_SOURCE } from './astUnparseSource';

registerSourceModule('_ast', AST_NODES_SOURCE);
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
