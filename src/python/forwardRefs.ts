import type { Expression } from './ast';
import { pyRepr } from './conversions';
import type { Runtime } from './runtime';
import { newForwardRef } from './typeHints';
import { type PyClass, PyError, type PyValue } from './values';

/**
 * A class's annotations as `annotationlib.get_annotations(cls, format=Format.FORWARDREF)` gives them to `@dataclass`:
 * first evaluated with every undefined name standing for a forward reference, and, when that still fails, each
 * evaluated on its own, those that fail becoming a forward reference to their source.
 */
export function forwardRefAnnotations(runtime: Runtime, cls: PyClass): [PyValue, PyValue][] {
  const thunks = runtime.classAnnotationThunks.get(cls) ?? [];
  try {
    return runtime.withForwardRefOwner(cls, () => thunks.map(([name, evaluate]) => [name, evaluate()]));
  } catch (error) {
    if (!(error instanceof PyError)) throw error;
  }
  return thunks.map(([name, evaluate, expression]) => {
    try {
      return [name, evaluate()];
    } catch (error) {
      const source = expression && unparse(expression);
      if (!(error instanceof PyError) || source === undefined) throw error;
      return [name, newForwardRef(source, cls)];
    }
  });
}

/** The source of an annotation as `ast.unparse` writes it, for the forms annotations take; undefined for others. */
function unparse(expression: Expression): string | undefined {
  switch (expression.kind) {
    case 'name': {
      return expression.name;
    }
    case 'attribute': {
      const object = unparse(expression.object);
      return object === undefined ? undefined : `${object}.${expression.name}`;
    }
    case 'subscript': {
      const object = unparse(expression.object);
      const index =
        expression.index.kind === 'tuple' ? unparseAll(expression.index.elements) : unparse(expression.index);
      return object === undefined || index === undefined ? undefined : `${object}[${index}]`;
    }
    case 'binary': {
      const left = unparse(expression.left);
      const right = unparse(expression.right);
      return expression.operator !== '|' || left === undefined || right === undefined
        ? undefined
        : `${left} | ${right}`;
    }
    case 'constant': {
      return unparseConstant(expression.value);
    }
    default: {
      return undefined;
    }
  }
}

function unparseAll(elements: readonly unknown[]): string | undefined {
  const parts = elements.map((element) => unparse(element as Expression));
  return parts.includes(undefined) ? undefined : parts.join(', ');
}

function unparseConstant(constant: Extract<Expression, { kind: 'constant' }>['value']): string | undefined {
  switch (constant.kind) {
    case 'str': {
      return pyRepr(constant.value);
    }
    case 'none': {
      return 'None';
    }
    case 'ellipsis': {
      return '...';
    }
    case 'int':
    case 'bool': {
      return String(constant.value === true ? 'True' : constant.value === false ? 'False' : constant.value);
    }
    default: {
      return undefined;
    }
  }
}
