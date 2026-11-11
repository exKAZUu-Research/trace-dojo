// Builds the trees of CPython's `ast` module from the syntax tree, as `compile(..., PyCF_ONLY_AST)` returns them.
import type { Node } from '@willbooster/web-tree-sitter';

import { children, field, fieldNodes, namedChildren } from '../convertNodes';
import { newList, None } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';
import { type Context, identifier, type Location } from './astExpressionBuilder';
import { AstPatternBuilder } from './astPatternBuilder';

const AUGMENTED: Record<string, string> = {
  '+=': 'Add',
  '-=': 'Sub',
  '*=': 'Mult',
  '@=': 'MatMult',
  '/=': 'Div',
  '%=': 'Mod',
  '**=': 'Pow',
  '<<=': 'LShift',
  '>>=': 'RShift',
  '|=': 'BitOr',
  '^=': 'BitXor',
  '&=': 'BitAnd',
  '//=': 'FloorDiv',
};

const SIMPLE: Record<string, string> = {
  pass_statement: 'Pass',
  break_statement: 'Break',
  continue_statement: 'Continue',
};

export class AstBuilder extends AstPatternBuilder {
  /** The tree of a whole source text in `mode`, as `ast.parse` returns it. */
  module(root: Node, mode: 'exec' | 'eval' | 'single'): PyValue {
    if (mode === 'eval') {
      const statement = namedChildren(root)[0];
      const expression = namedChildren(statement);
      const body = expression.length === 1 ? this.expr(expression[0]) : this.tuple(expression, 'Load', statement);
      return this.make('Expression', { body });
    }
    const body = this.block(namedChildren(root));
    if (mode === 'single') return this.make('Interactive', { body });
    return this.make('Module', { body, type_ignores: newList([]) });
  }

  private block(nodes: Node[]): PyValue {
    return newList(nodes.filter((node) => node.type !== 'comment').flatMap((node) => this.statements(node)));
  }

  protected body(node: Node): PyValue {
    return this.block(namedChildren(node));
  }

  /** The end of a statement as CPython gives it: the end of the last statement in its last block. */
  protected endOf(node: Node): Node {
    if (!isCompound(node) && !isClause(node) && node.type !== 'block') return node;
    const last = namedChildren(node).findLast((child) => child.type !== 'comment');
    return last ? this.endOf(last) : node;
  }

  private spanning(node: Node, start: Node = node): Location {
    return this.location(start, this.endOf(node));
  }

  // code-gauge-allow functionNcss 60 -- One case per kind of statement node, each delegating where it grows.
  private statements(node: Node): PyValue[] {
    const at = this.location(node);
    switch (node.type) {
      case 'expression_statement': {
        return [this.expressionStatement(node, at)];
      }
      case 'pass_statement':
      case 'break_statement':
      case 'continue_statement': {
        return [this.make(SIMPLE[node.type], {}, at)];
      }
      case 'return_statement': {
        const value = namedChildren(node)[0];
        return [this.make('Return', { value: value ? this.expr(value) : None }, at)];
      }
      case 'delete_statement': {
        const target = namedChildren(node)[0];
        const targets = target.type === 'expression_list' ? namedChildren(target) : [target];
        return [this.make('Delete', { targets: newList(targets.map((each) => this.expr(each, 'Del'))) }, at)];
      }
      case 'raise_statement': {
        const cause = node.childForFieldName('cause');
        const exception = namedChildren(node).find((child) => child !== cause);
        return [
          this.make(
            'Raise',
            { exc: exception ? this.expr(exception) : None, cause: cause ? this.expr(cause) : None },
            at
          ),
        ];
      }
      case 'assert_statement': {
        const [test, msg] = namedChildren(node);
        return [this.make('Assert', { test: this.expr(test), msg: msg ? this.expr(msg) : None }, at)];
      }
      case 'global_statement':
      case 'nonlocal_statement': {
        const names = newList(namedChildren(node).map((name) => identifier(name)));
        return [this.make(node.type === 'global_statement' ? 'Global' : 'Nonlocal', { names }, at)];
      }
      case 'import_statement': {
        return [this.make('Import', { names: newList(fieldNodes(node, 'name').map((name) => this.alias(name))) }, at)];
      }
      case 'import_from_statement':
      case 'future_import_statement': {
        return [this.importFrom(node, at)];
      }
      case 'if_statement': {
        return [this.ifStatement(node, node)];
      }
      case 'while_statement': {
        const orelse = node.childForFieldName('alternative');
        return [
          this.make(
            'While',
            {
              test: this.expr(field(node, 'condition')),
              body: this.body(field(node, 'body')),
              orelse: this.orelse(orelse),
            },
            this.spanning(node)
          ),
        ];
      }
      case 'for_statement': {
        return [this.forStatement(node)];
      }
      case 'try_statement': {
        return [this.tryStatement(node)];
      }
      case 'with_statement': {
        return [this.withStatement(node)];
      }
      case 'function_definition': {
        return [this.functionDef(node, [])];
      }
      case 'class_definition': {
        return [this.classDef(node, [])];
      }
      case 'decorated_definition': {
        const decorators = newList(
          namedChildren(node)
            .filter((child) => child.type === 'decorator')
            .map((decorator) => this.expr(namedChildren(decorator)[0]))
        );
        const definition = field(node, 'definition');
        return [
          definition.type === 'class_definition'
            ? this.classDef(definition, decorators.items)
            : this.functionDef(definition, decorators.items),
        ];
      }
      case 'match_statement': {
        return [this.matchStatement(node)];
      }
      case 'type_alias_statement': {
        return [this.typeAlias(node, at)];
      }
      default: {
        throw new UnsupportedFeatureError(`ast.parse() が扱えない文（${node.type}）`);
      }
    }
  }

  private expressionStatement(node: Node, at: Location): PyValue {
    const parts = namedChildren(node);
    const [first] = parts;
    if (parts.length === 1 && first.type === 'assignment') return this.assignment(first, at);
    if (parts.length === 1 && first.type === 'augmented_assignment') {
      const op = this.singleton(AUGMENTED[(first.childForFieldName('operator') as Node).text]);
      return this.make(
        'AugAssign',
        { target: this.expr(field(first, 'left'), 'Store'), op, value: this.expr(field(first, 'right')) },
        at
      );
    }
    const value = parts.length === 1 ? this.expr(first) : this.tuple(parts, 'Load', node);
    return this.make('Expr', { value }, at);
  }

  private assignment(node: Node, at: Location): PyValue {
    const annotation = node.childForFieldName('type');
    const left = field(node, 'left');
    if (annotation) {
      const right = node.childForFieldName('right');
      const simple = left.type === 'identifier' ? 1n : 0n;
      return this.make(
        'AnnAssign',
        {
          target: this.expr(left, 'Store'),
          annotation: this.expr(annotation),
          value: right ? this.expr(right) : None,
          simple,
        },
        at
      );
    }
    const targets: PyValue[] = [];
    let current = node;
    for (;;) {
      targets.push(this.expr(field(current, 'left'), 'Store'));
      const right = field(current, 'right');
      if (right.type !== 'assignment') {
        return this.make('Assign', { targets: newList(targets), value: this.expr(right), type_comment: None }, at);
      }
      current = right;
    }
  }

  private alias(node: Node): PyValue {
    if (node.type === 'aliased_import') {
      const name = dotted(field(node, 'name'));
      return this.make('alias', { name, asname: identifier(field(node, 'alias')) }, this.location(node));
    }
    return this.make('alias', { name: dotted(node), asname: None }, this.location(node));
  }

  private importFrom(node: Node, at: Location): PyValue {
    let module: PyValue = '__future__';
    let level = 0;
    const moduleNode = node.childForFieldName('module_name');
    if (moduleNode?.type === 'relative_import') {
      const prefix = namedChildren(moduleNode).find((child) => child.type === 'import_prefix') as Node;
      level = prefix.text.length;
      const name = namedChildren(moduleNode).find((child) => child.type === 'dotted_name');
      module = name ? dotted(name) : None;
    } else if (moduleNode) {
      module = dotted(moduleNode);
    }
    const wildcard = namedChildren(node).find((child) => child.type === 'wildcard_import');
    const names = wildcard
      ? [this.make('alias', { name: '*', asname: None }, this.location(wildcard))]
      : fieldNodes(node, 'name').map((name) => this.alias(name));
    return this.make('ImportFrom', { module, names: newList(names), level: BigInt(level) }, at);
  }

  private orelse(node: Node | null): PyValue {
    if (!node) return newList([]);
    if (node.type === 'elif_clause') return newList([this.ifStatement(node, node)]);
    return this.body(field(node, 'body'));
  }

  private ifStatement(node: Node, start: Node): PyValue {
    const alternatives = fieldNodes(node, 'alternative');
    let orelse: PyValue = newList([]);
    // The elif clauses nest, each an If in the orelse of the one before.
    for (const alternative of alternatives.toReversed()) {
      if (alternative.type === 'else_clause') {
        orelse = this.body(field(alternative, 'body'));
      } else {
        const test = this.expr(field(alternative, 'condition'));
        const body = this.body(field(alternative, 'consequence'));
        const end = this.endOf(alternatives.at(-1) as Node);
        orelse = newList([this.make('If', { test, body, orelse }, this.location(alternative, end))]);
      }
    }
    const test = this.expr(field(node, 'condition'));
    const body = this.body(field(node, 'consequence'));
    const end = alternatives.length > 0 ? this.endOf(alternatives.at(-1) as Node) : this.endOf(node);
    return this.make('If', { test, body, orelse }, this.location(start, end));
  }

  private forStatement(node: Node): PyValue {
    const isAsync = children(node)[0].type === 'async';
    const rights = fieldNodes(node, 'right');
    const iter = rights.length === 1 ? this.expr(rights[0]) : this.tuple(rights, 'Load', node);
    return this.make(
      isAsync ? 'AsyncFor' : 'For',
      {
        target: this.expr(field(node, 'left'), 'Store'),
        iter,
        body: this.body(field(node, 'body')),
        orelse: this.orelse(node.childForFieldName('alternative')),
        type_comment: None,
      },
      this.spanning(node)
    );
  }

  private tryStatement(node: Node): PyValue {
    const clauses = namedChildren(node);
    const handlers: PyValue[] = [];
    let orelse: PyValue = newList([]);
    let finalbody: PyValue = newList([]);
    let isGroup = false;
    for (const clause of clauses) {
      if (clause.type === 'except_clause' || clause.type === 'except_group_clause') {
        if (clause.type === 'except_group_clause' || children(clause)[1]?.type === '*') isGroup = true;
        handlers.push(this.handler(clause));
      } else if (clause.type === 'else_clause') {
        orelse = this.body(field(clause, 'body'));
      } else if (clause.type === 'finally_clause') {
        finalbody = this.block(namedChildren(namedChildren(clause).at(-1) as Node));
      }
    }
    return this.make(
      isGroup ? 'TryStar' : 'Try',
      { body: this.body(field(node, 'body')), handlers: newList(handlers), orelse, finalbody },
      this.spanning(node)
    );
  }

  private handler(clause: Node): PyValue {
    const value = clause.childForFieldName('value');
    const alias = clause.childForFieldName('alias');
    const block = namedChildren(clause).at(-1) as Node;
    return this.make(
      'ExceptHandler',
      { type: value ? this.expr(value) : None, name: alias ? identifier(alias) : None, body: this.body(block) },
      this.location(clause, this.endOf(block))
    );
  }

  private withStatement(node: Node): PyValue {
    const isAsync = children(node)[0].type === 'async';
    const clause = namedChildren(node).find((child) => child.type === 'with_clause') as Node;
    const items = namedChildren(clause).map((item) => {
      const value = field(item, 'value');
      if (value.type === 'as_pattern') {
        const target = namedChildren(field(value, 'alias'))[0];
        return this.make('withitem', {
          context_expr: this.expr(namedChildren(value)[0]),
          optional_vars: this.expr(target, 'Store'),
        });
      }
      return this.make('withitem', { context_expr: this.expr(value), optional_vars: None });
    });
    return this.make(
      isAsync ? 'AsyncWith' : 'With',
      { items: newList(items), body: this.body(field(node, 'body')), type_comment: None },
      this.spanning(node)
    );
  }

  private functionDef(node: Node, decorators: PyValue[]): PyValue {
    const isAsync = children(node)[0].type === 'async';
    const returns = node.childForFieldName('return_type');
    return this.make(
      isAsync ? 'AsyncFunctionDef' : 'FunctionDef',
      {
        name: identifier(field(node, 'name')),
        args: this.arguments(field(node, 'parameters')),
        body: this.body(field(node, 'body')),
        decorator_list: newList(decorators),
        returns: returns ? this.expr(returns) : None,
        type_comment: None,
        type_params: this.typeParams(node),
      },
      this.spanning(node)
    );
  }

  private classDef(node: Node, decorators: PyValue[]): PyValue {
    const superclasses = node.childForFieldName('superclasses');
    const [bases, keywords] = superclasses ? this.callArguments(superclasses) : [newList([]), newList([])];
    return this.make(
      'ClassDef',
      {
        name: identifier(field(node, 'name')),
        bases,
        keywords,
        body: this.body(field(node, 'body')),
        decorator_list: newList(decorators),
        type_params: this.typeParams(node),
      },
      this.spanning(node)
    );
  }

  private typeParams(node: Node): PyValue {
    return this.typeParamList(node.childForFieldName('type_parameters') ?? undefined);
  }

  private typeParamList(parameters: Node | undefined): PyValue {
    if (!parameters) return newList([]);
    return newList(namedChildren(parameters).map((parameter) => this.typeParam(parameter)));
  }

  /** A `T`, `T: bound`, `*Ts` or `**P`, each with an optional `= default`. */
  private typeParam(parameter: Node): PyValue {
    const at = this.location(parameter);
    const inner = parameter.type === 'type' ? namedChildren(parameter)[0] : parameter;
    if (inner.type === 'constrained_type') {
      const [name, bound] = namedChildren(inner);
      return this.make('TypeVar', { name: identifier(name), bound: this.expr(bound), default_value: None }, at);
    }
    if (inner.type === 'identifier') {
      return this.make('TypeVar', { name: identifier(inner), bound: None, default_value: None }, at);
    }
    const star = children(inner)[0].type;
    const name = children(inner).find((child) => child.type === 'identifier') as Node;
    const value = inner.childForFieldName('value');
    const defaultValue = value ? this.expr(value) : None;
    if (star === '*') return this.make('TypeVarTuple', { name: identifier(name), default_value: defaultValue }, at);
    if (star === '**') return this.make('ParamSpec', { name: identifier(name), default_value: defaultValue }, at);
    const bound = inner.childForFieldName('bound');
    return this.make(
      'TypeVar',
      { name: identifier(name), bound: bound ? this.expr(bound) : None, default_value: defaultValue },
      at
    );
  }

  private typeAlias(node: Node, at: Location): PyValue {
    const left = namedChildren(field(node, 'left'))[0];
    const isGeneric = left.type === 'generic_type';
    const nameNode = isGeneric ? namedChildren(left)[0] : left;
    const name = this.expr(nameNode, 'Store' as Context);
    const typeParams = this.typeParamList(isGeneric ? namedChildren(left)[1] : undefined);
    return this.make('TypeAlias', { name, type_params: typeParams, value: this.expr(field(node, 'right')) }, at);
  }
}

/** Whether source text is one interactive statement: a compound statement, or simple ones joined on one line. */
export function isInteractiveStatement(root: Node): boolean {
  const statements = namedChildren(root).filter((node) => node.type !== 'comment');
  return (
    statements.length <= 1 ||
    (!statements.some(isCompound) &&
      statements.every((node) => node.startPosition.row === statements[0].startPosition.row))
  );
}

function dotted(node: Node): string {
  return namedChildren(node)
    .map((part) => identifier(part))
    .join('.');
}

function isClause(node: Node): boolean {
  return [
    'else_clause',
    'elif_clause',
    'except_clause',
    'except_group_clause',
    'finally_clause',
    'case_clause',
  ].includes(node.type);
}

function isCompound(node: Node): boolean {
  return [
    'if_statement',
    'while_statement',
    'for_statement',
    'try_statement',
    'with_statement',
    'function_definition',
    'class_definition',
    'decorated_definition',
    'match_statement',
  ].includes(node.type);
}
