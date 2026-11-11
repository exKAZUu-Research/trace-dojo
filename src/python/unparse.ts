import type {
  Argument,
  BinaryOperator,
  Comprehension,
  Constant,
  DictItem,
  Element,
  Expression,
  FormattedValue,
  Parameter,
  Target,
} from './ast';
import { bytesLiteral } from './bytesLiteral';
import { complexRepr, newComplex } from './complexNumbers';
import { floatRepr } from './numbers';
import { strRepr } from './strings';

/** The precedence levels of CPython's `Python/ast_unparse.c`, which decide where it writes parentheses. */
const enum Level {
  Tuple,
  Test,
  Or,
  And,
  Not,
  Compare,
  BitOr,
  BitXor,
  BitAnd,
  Shift,
  Arith,
  Term,
  Factor,
  Power,
  Await,
  Atom,
}

const BINARY_LEVELS: Record<BinaryOperator, Level> = {
  '|': Level.BitOr,
  '^': Level.BitXor,
  '&': Level.BitAnd,
  '<<': Level.Shift,
  '>>': Level.Shift,
  '+': Level.Arith,
  '-': Level.Arith,
  '*': Level.Term,
  '@': Level.Term,
  '/': Level.Term,
  '%': Level.Term,
  '//': Level.Term,
  '**': Level.Power,
};

/** The source text CPython stores for an annotation under `from __future__ import annotations`. */
export function unparseAnnotation(expression: Expression): string {
  return unparse(expression, Level.Test);
}

// code-gauge-allow functionNcss 58 -- One case per kind of expression, as ast_unparse.c writes it.
// code-gauge-allow functionCognitiveComplexity 20 -- One case per kind of expression, as ast_unparse.c writes it.
function unparse(expression: Expression, level: Level): string {
  switch (expression.kind) {
    case 'name': {
      return expression.name;
    }
    case 'constant': {
      return constantText(expression.value);
    }
    case 'fstring': {
      return `f${strRepr(fstringBody(expression.parts))}`;
    }
    case 'list': {
      return `[${elementsText(expression.elements)}]`;
    }
    case 'set': {
      return expression.elements.length === 0 ? '{*()}' : `{${elementsText(expression.elements)}}`;
    }
    case 'tuple': {
      return tupleText(expression.elements, level);
    }
    case 'dict': {
      return `{${expression.items.map(dictItemText).join(', ')}}`;
    }
    case 'attribute': {
      const { object } = expression;
      const isInteger = object.kind === 'constant' && object.value.kind === 'int';
      return `${unparse(object, Level.Atom)}${isInteger ? ' .' : '.'}${expression.name}`;
    }
    case 'subscript': {
      return `${unparse(expression.object, Level.Atom)}[${unparse(expression.index, Level.Tuple)}]`;
    }
    case 'slice': {
      const part = (value: Expression | undefined): string => (value ? unparse(value, Level.Test) : '');
      return `${part(expression.lower)}:${part(expression.upper)}${expression.step ? `:${part(expression.step)}` : ''}`;
    }
    case 'call': {
      return callText(expression.callee, expression.args);
    }
    case 'binary': {
      return binaryText(expression, level);
    }
    case 'unary': {
      return parenthesize(`${expression.operator}${unparse(expression.operand, Level.Factor)}`, level > Level.Factor);
    }
    case 'not': {
      return parenthesize(`not ${unparse(expression.operand, Level.Not)}`, level > Level.Not);
    }
    case 'boolean': {
      const operatorLevel = expression.operator === 'and' ? Level.And : Level.Or;
      const text = `${unparse(expression.left, operatorLevel + 1)} ${expression.operator} ${unparse(expression.right, operatorLevel + 1)}`;
      return parenthesize(text, level > operatorLevel);
    }
    case 'compare': {
      return compareText(expression, level);
    }
    case 'conditional': {
      const text = `${unparse(expression.body, Level.Test + 1)} if ${unparse(expression.test, Level.Test + 1)} else ${unparse(expression.orelse, Level.Test)}`;
      return parenthesize(text, level > Level.Test);
    }
    case 'lambda': {
      const params = parametersText(expression.fn.params);
      const body = unparse(expression.fn.body as Expression, Level.Test);
      // CPython writes no space after `lambda` when the parameters start with `*`.
      const space = params !== '' && !params.startsWith('*') ? ' ' : '';
      return parenthesize(`lambda${space}${params}: ${body}`, level > Level.Test);
    }
    case 'namedExpression': {
      const text = `${expression.target.name} := ${unparse(expression.value, Level.Atom)}`;
      return parenthesize(text, level > Level.Tuple);
    }
    case 'comprehension': {
      return comprehensionText(expression);
    }
    case 'yield':
    case 'yieldFrom': {
      const keyword = expression.kind === 'yield' ? 'yield' : 'yield from';
      return `(${keyword}${expression.value ? ` ${unparse(expression.value, Level.Test)}` : ''})`;
    }
    case 'await': {
      return parenthesize(`await ${unparse(expression.value, Level.Atom)}`, level > Level.Await);
    }
  }
}

function binaryText(expression: Extract<Expression, { kind: 'binary' }>, level: Level): string {
  const operatorLevel = BINARY_LEVELS[expression.operator];
  const isRight = expression.operator === '**' ? 1 : 0;
  const left = unparse(expression.left, operatorLevel + isRight);
  const right = unparse(expression.right, operatorLevel + 1 - isRight);
  return parenthesize(`${left} ${expression.operator} ${right}`, level > operatorLevel);
}

function compareText(expression: Extract<Expression, { kind: 'compare' }>, level: Level): string {
  const [first, ...rest] = expression.operands;
  let text = unparse(first, Level.Compare + 1);
  for (const [index, operand] of rest.entries()) {
    text += ` ${expression.operators[index]} ${unparse(operand, Level.Compare + 1)}`;
  }
  return parenthesize(text, level > Level.Compare);
}

function parenthesize(text: string, needed: boolean): string {
  return needed ? `(${text})` : text;
}

function constantText(constant: Constant): string {
  switch (constant.kind) {
    case 'ellipsis': {
      return '...';
    }
    case 'none': {
      return 'None';
    }
    case 'bool': {
      return constant.value ? 'True' : 'False';
    }
    case 'int': {
      return constant.value.toString();
    }
    case 'float': {
      return infinityText(floatRepr(constant.value));
    }
    case 'imaginary': {
      return infinityText(complexRepr(newComplex(0, constant.value)));
    }
    case 'str': {
      return `${constant.isUnicode ? 'u' : ''}${strRepr(constant.value)}`;
    }
    case 'bytes': {
      return `b${bytesLiteral(constant.value)}`;
    }
  }
}

/** CPython writes an infinite literal as `1e309`, which reads back as infinity. */
function infinityText(text: string): string {
  return text.replaceAll('inf', '1e309');
}

function elementsText(elements: Element[]): string {
  return elements.map(elementText).join(', ');
}

function elementText(element: Element): string {
  return element.kind === 'starred' ? `*${unparse(element.value, Level.BitOr)}` : unparse(element, Level.Test);
}

function tupleText(elements: Element[], level: Level): string {
  if (elements.length === 0) return '()';
  const text = elements.length === 1 ? `${elementText(elements[0])},` : elementsText(elements);
  return parenthesize(text, level > Level.Tuple);
}

function dictItemText(item: DictItem): string {
  return item.kind === 'doubleStar'
    ? `**${unparse(item.value, Level.BitOr)}`
    : `${unparse(item.key, Level.Test)}: ${unparse(item.value, Level.Test)}`;
}

/** Writes a call with its positional arguments before its keyword arguments, as CPython's AST orders them. */
function callText(callee: Expression, args: Argument[]): string {
  const [only] = args;
  if (
    args.length === 1 &&
    only.kind === 'positional' &&
    only.value.kind === 'comprehension' &&
    only.value.type === 'generator'
  ) {
    return `${unparse(callee, Level.Atom)}${unparse(only.value, Level.Test)}`;
  }
  const positional = args.filter((arg) => arg.kind === 'positional' || arg.kind === 'star');
  const keywords = args.filter((arg) => arg.kind === 'keyword' || arg.kind === 'doubleStar');
  return `${unparse(callee, Level.Atom)}(${[...positional, ...keywords].map(argumentText).join(', ')})`;
}

function argumentText(argument: Argument): string {
  switch (argument.kind) {
    case 'positional': {
      return unparse(argument.value, Level.Test);
    }
    case 'star': {
      return `*${unparse(argument.value, Level.BitOr)}`;
    }
    case 'keyword': {
      return `${argument.name}=${unparse(argument.value, Level.Test)}`;
    }
    case 'doubleStar': {
      return `**${unparse(argument.value, Level.BitOr)}`;
    }
  }
}

function parametersText(params: Parameter[]): string {
  const parts: string[] = [];
  for (const [index, param] of params.entries()) {
    const before = params.slice(0, index);
    if (
      param.kind === 'keywordOnly' &&
      !before.some((each) => each.kind === 'varArgs' || each.kind === 'keywordOnly')
    ) {
      parts.push('*');
    }
    if (param.kind === 'varArgs') parts.push(`*${param.name}`);
    else if (param.kind === 'varKeywords') parts.push(`**${param.name}`);
    else parts.push(`${param.name}${param.default ? `=${unparse(param.default, Level.Test)}` : ''}`);
    if (param.kind === 'positionalOnly' && params[index + 1]?.kind !== 'positionalOnly') parts.push('/');
  }
  return parts.join(', ');
}

function comprehensionText(expression: Extract<Expression, { kind: 'comprehension' }>): string {
  const element =
    expression.type === 'dict'
      ? `${unparse(expression.element, Level.Test)}: ${unparse(expression.value as Expression, Level.Test)}`
      : unparse(expression.element, Level.Test);
  const clauses = expression.generators.map(clauseText).join('');
  const [open, close] = { list: '[]', set: '{}', dict: '{}', generator: '()' }[expression.type];
  return `${open}${element}${clauses}${close}`;
}

function clauseText(generator: Comprehension): string {
  const conditions = generator.conditions.map((condition) => ` if ${unparse(condition, Level.Test + 1)}`).join('');
  return `${generator.isAsync ? ' async' : ''} for ${targetText(generator.target, Level.Tuple)} in ${unparse(generator.iterable, Level.Test + 1)}${conditions}`;
}

function targetText(target: Target, level: Level): string {
  if (target.kind !== 'unpack') return unparse(target, level);
  const parts = target.elements.map((element, index) =>
    index === target.starIndex ? `*${targetText(element, Level.BitOr)}` : targetText(element, Level.Test)
  );
  if (parts.length === 1) return parenthesize(`${parts[0]},`, level > Level.Tuple);
  return parenthesize(parts.join(', '), level > Level.Tuple);
}

/** The text between the quotes of an f-string, whose replacement fields CPython writes back from the AST. */
function fstringBody(parts: (string | FormattedValue)[]): string {
  return parts
    .map((part) => {
      if (typeof part === 'string') return part.replaceAll('{', '{{').replaceAll('}', '}}');
      const debug = (part.debugText ?? '').replaceAll('{', '{{').replaceAll('}', '}}');
      const text = unparse(part.expression, Level.Test + 1);
      const conversion = part.conversion ? `!${part.conversion}` : '';
      const spec = part.spec?.kind === 'fstring' ? `:${fstringBody(part.spec.parts)}` : '';
      return `${debug}{${text.startsWith('{') ? ' ' : ''}${text}${conversion}${spec}}`;
    })
    .join('');
}
