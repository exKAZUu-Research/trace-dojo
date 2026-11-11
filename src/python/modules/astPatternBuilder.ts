// Builds the match statements of CPython's `ast` module, with their patterns.
import type { Node } from '@willbooster/web-tree-sitter';

import { children, field, fieldNodes, namedChildren } from '../convertNodes';
import { Ellipsis, newList, None } from '../types';
import { UnsupportedFeatureError } from '../unsupported';
import type { PyValue } from '../values';
import { AstExpressionBuilder, identifier, type Location } from './astExpressionBuilder';

export abstract class AstPatternBuilder extends AstExpressionBuilder {
  protected abstract body(node: Node): PyValue;

  protected abstract endOf(node: Node): Node;

  protected matchStatement(node: Node): PyValue {
    const cases = fieldNodes(field(node, 'body'), 'alternative').map((clause) => {
      const patterns = namedChildren(clause).filter((child) => child.type === 'case_pattern');
      const pattern =
        patterns.length === 1
          ? this.pattern(patterns[0])
          : this.make(
              'MatchSequence',
              { patterns: newList(patterns.map((each) => this.pattern(each))) },
              this.location(patterns[0], patterns.at(-1) as Node)
            );
      const guard = clause.childForFieldName('guard');
      return this.make('match_case', {
        pattern,
        guard: guard ? this.expr(namedChildren(guard)[0]) : None,
        body: this.body(field(clause, 'consequence')),
      });
    });
    return this.make(
      'Match',
      { subject: this.expr(field(node, 'subject')), cases: newList(cases) },
      this.location(node, this.endOf(node))
    );
  }

  private pattern(node: Node): PyValue {
    return node.type === 'case_pattern' ? this.patternOf(children(node)) : this.patternOf([node]);
  }

  /** The pattern the nodes of one alternative make: one node, or a minus sign and a number. */
  // code-gauge-allow functionCognitiveComplexity 22 -- One case per kind of pattern node.
  // code-gauge-allow functionNcss 40 -- One case per kind of pattern node.
  private patternOf(nodes: Node[]): PyValue {
    const [node] = nodes;
    const at = this.location(node, nodes.at(-1) as Node);
    if (nodes.length === 2 && node.type === '-') {
      const operand = this.expr(nodes[1]);
      return this.make('MatchValue', { value: this.make('UnaryOp', { op: this.singleton('USub'), operand }, at) }, at);
    }
    switch (node.type) {
      case 'case_pattern': {
        return this.pattern(node);
      }
      case '_': {
        return this.make('MatchAs', { pattern: None, name: None }, at);
      }
      case 'none':
      case 'true':
      case 'false': {
        const value = node.type === 'none' ? None : node.type === 'true';
        return this.make('MatchSingleton', { value }, at);
      }
      case 'integer':
      case 'float':
      case 'string':
      case 'concatenated_string': {
        return this.make('MatchValue', { value: this.expr(node) }, at);
      }
      case 'complex_pattern': {
        return this.make('MatchValue', { value: this.complexValue(node) }, at);
      }
      case 'dotted_name': {
        const parts = namedChildren(node);
        if (parts.length === 1) return this.make('MatchAs', { pattern: None, name: identifier(parts[0]) }, at);
        return this.make('MatchValue', { value: this.dottedValue(parts) }, at);
      }
      case 'list_pattern':
      case 'tuple_pattern': {
        const patterns = namedChildren(node).map((child) => this.pattern(child));
        return this.make('MatchSequence', { patterns: newList(patterns) }, at);
      }
      case 'splat_pattern': {
        const name = namedChildren(node)[0];
        return this.make('MatchStar', { name: name ? identifier(name) : None }, at);
      }
      case 'dict_pattern': {
        return this.mappingPattern(node, at);
      }
      case 'class_pattern': {
        return this.classPattern(node, at);
      }
      case 'union_pattern': {
        return this.make('MatchOr', { patterns: newList(alternatives(node).map((each) => this.patternOf(each))) }, at);
      }
      case 'as_pattern': {
        const inner = this.pattern(namedChildren(node)[0]);
        return this.make('MatchAs', { pattern: inner, name: identifier(field(node, 'alias')) }, at);
      }
      default: {
        throw new UnsupportedFeatureError(`ast.parse() が扱えないパターン（${node.type}）`);
      }
    }
  }

  /** `1+2j` or `-1-2j` in a pattern: a BinOp of a real and an imaginary number. */
  private complexValue(node: Node): PyValue {
    const parts = children(node);
    const operator = parts.find((part, index) => index > 0 && (part.type === '+' || part.type === '-')) as Node;
    const leftNodes = parts.slice(0, parts.indexOf(operator));
    const right = parts.at(-1) as Node;
    const left =
      leftNodes.length === 2
        ? this.make(
            'UnaryOp',
            { op: this.singleton('USub'), operand: this.expr(leftNodes[1]) },
            this.location(leftNodes[0], leftNodes[1])
          )
        : this.expr(leftNodes[0]);
    const op = this.singleton(operator.type === '+' ? 'Add' : 'Sub');
    return this.make('BinOp', { left, op, right: this.expr(right) }, this.location(node));
  }

  private dottedValue(parts: Node[]): PyValue {
    let value = this.expr(parts[0]);
    for (const part of parts.slice(1)) {
      value = this.make(
        'Attribute',
        { value, attr: identifier(part), ctx: this.singleton('Load') },
        this.location(parts[0], part)
      );
    }
    return value;
  }

  private mappingPattern(node: Node, at: Location): PyValue {
    const keys: PyValue[] = [];
    const patterns: PyValue[] = [];
    let rest: PyValue = None;
    for (const child of namedChildren(node)) {
      if (child.type === 'splat_pattern') {
        rest = identifier(namedChildren(child)[0]);
      } else if (child.type !== 'case_pattern') {
        keys.push(this.keyOf(child));
      } else {
        patterns.push(this.pattern(child));
      }
    }
    return this.make('MatchMapping', { keys: newList(keys), patterns: newList(patterns), rest }, at);
  }

  private keyOf(node: Node): PyValue {
    if (node.type === 'dotted_name') return this.dottedValue(namedChildren(node));
    if (node.type === 'none' || node.type === 'true' || node.type === 'false') return this.expr(node);
    return node.type === 'ellipsis' ? Ellipsis : this.expr(node);
  }

  private classPattern(node: Node, at: Location): PyValue {
    const [nameNode, ...arguments_] = namedChildren(node);
    const positional: PyValue[] = [];
    const attributes: string[] = [];
    const keywordPatterns: PyValue[] = [];
    for (const argument of arguments_) {
      const inner = namedChildren(argument)[0];
      if (inner?.type === 'keyword_pattern') {
        const [name, ...rest] = children(inner);
        attributes.push(identifier(name));
        keywordPatterns.push(this.patternOf(rest.slice(1)));
      } else {
        positional.push(this.pattern(argument));
      }
    }
    const parts = namedChildren(nameNode);
    return this.make(
      'MatchClass',
      {
        cls: this.dottedValue(parts),
        patterns: newList(positional),
        kwd_attrs: newList(attributes),
        kwd_patterns: newList(keywordPatterns),
      },
      at
    );
  }
}

/** The alternatives of an or-pattern, split at its `|` tokens. */
function alternatives(node: Node): Node[][] {
  const result: Node[][] = [[]];
  for (const child of children(node)) {
    if (child.type === '|') result.push([]);
    else (result.at(-1) as Node[]).push(child);
  }
  return result;
}
