import type { TraceOptions } from '../interpreter/traceAnnotations';
import type { ClassNode, IterationSource, Program, Statement } from '../javascript/ast';
import { type Node, unwrapParentheses } from '../javascript/convertNodes';
import { ProgramConverter } from '../javascript/programConverter';
import { PARAMETER_PROPERTY_ASSIGNMENT } from './jsView';

/** Converts a TypeScript program, viewed as JavaScript, to the JavaScript interpreter's AST. */
export class TypeScriptProgramConverter extends ProgramConverter {
  // The reference runs a file without `import` or `export` as a CommonJS script, which is not strict mode code.
  protected override readonly isStrictByDefault = false;

  constructor(source: string, trace: TraceOptions | undefined) {
    super(source, trace);
    const convertReturn = this.statementConverters.return_statement;
    this.statementConverters.return_statement = (node) => {
      const statement = convertReturn(node);
      if (statement.kind === 'return' && statement.value?.kind === 'call' && statement.value.callee.kind === 'super')
        statement.value.skipsAfterSuper = true;
      return statement;
    };
    // `this.name = name` for a parameter property, which steps on the parameter's row as the assignment it stands for.
    this.statementConverters[PARAMETER_PROPERTY_ASSIGNMENT] = (node: Node) => {
      const row = node.startPosition.row;
      const name = node.text;
      return {
        kind: 'expression',
        expression: {
          kind: 'assign',
          operator: '=',
          target: {
            kind: 'member',
            object: { kind: 'this', row },
            property: { kind: 'key', key: name },
            optional: false,
            row,
          },
          value: { kind: 'identifier', name, row },
          row,
        },
        stepRow: this.stepRowOf(node),
        row,
      };
    };
  }

  override classNode(node: Node, name: string): ClassNode {
    const cls = super.classNode(node, name);
    if (!cls.superClass || !cls.ctor) return cls;
    const constructor = node
      .childForFieldName('body')
      ?.namedChildren.find(
        (member) =>
          member.type === 'method_definition' &&
          member.childForFieldName('name')?.text === 'constructor' &&
          !member.children.some((child) => child?.type === 'static')
      );
    const count =
      constructor?.childForFieldName('body')?.children.filter((child) => child?.type === PARAMETER_PROPERTY_ASSIGNMENT)
        .length ?? 0;
    if (count > 0) cls.afterSuper = (cls.ctor.body as Statement[]).splice(0, count);
    return cls;
  }

  protected override arrayDestructuringSource(node: Node): IterationSource | undefined {
    return super.arrayDestructuringSource(unwrapParentheses(node));
  }

  override convert(root: Node): Program {
    return { ...super.convert(root), rejectsFunctionText: true };
  }
}
