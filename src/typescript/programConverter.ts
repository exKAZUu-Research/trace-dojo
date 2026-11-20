import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import type { ClassNode, IterationSource, Program, Statement } from '../javascript/ast';
import { nameOf, type Node, rowOf, unwrapParentheses } from '../javascript/convertNodes';
import { isConstructorDefinition, ProgramConverter } from '../javascript/programConverter';
import { PARAMETER_PROPERTY_ASSIGNMENT } from './jsView';

/** Converts a TypeScript program, viewed as JavaScript, to the JavaScript interpreter's AST. */
export class TypeScriptProgramConverter extends ProgramConverter {
  // The reference runs a file without `import` or `export` as a CommonJS script, which is not strict mode code.
  protected override readonly isStrictByDefault = false;
  /** The errors of the statements that failed to convert, which tsc reports all of, unlike Node's first one. */
  private readonly statementErrors: SourceDiagnostic[] = [];

  constructor(source: string, trace: TraceOptions | undefined) {
    super(source, trace);
    this.recoverFromStatementErrors();
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
      const name = nameOf(node);
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

  override convert(root: Node): Program {
    const program = super.convert(root);
    if (this.statementErrors.length > 0) throw new CompileError(this.statementErrors);
    return {
      ...program,
      hasCommonJsReceiver: true,
      rejectsFunctionText: true,
      allowsOnlyStringRawTag: true,
      rejectsUnavailableMembers: true,
    };
  }

  private recoverFromStatementErrors(): void {
    for (const [type, convert] of Object.entries(this.statementConverters)) {
      this.statementConverters[type] = (node) => {
        try {
          return convert(node);
        } catch (error) {
          if (!(error instanceof CompileError)) throw error;
          this.statementErrors.push(...error.diagnostics);
          return { kind: 'empty', row: rowOf(node) };
        }
      };
    }
  }

  override classNode(node: Node, name: string): ClassNode {
    const cls = super.classNode(node, name);
    if (!cls.superClass || !cls.ctor) return cls;
    const constructor = node.childForFieldName('body')?.namedChildren.find((member) => isConstructorDefinition(member));
    const count =
      constructor?.childForFieldName('body')?.children.filter((child) => child?.type === PARAMETER_PROPERTY_ASSIGNMENT)
        .length ?? 0;
    if (count > 0) cls.afterSuper = (cls.ctor.body as Statement[]).splice(0, count);
    return cls;
  }

  protected override duplicate(node: Node, name: string): never {
    return super.duplicate(node.childForFieldName('name') ?? node, name);
  }

  protected override arrayDestructuringSource(node: Node): IterationSource | undefined {
    return super.arrayDestructuringSource(unwrapParentheses(node));
  }
}
