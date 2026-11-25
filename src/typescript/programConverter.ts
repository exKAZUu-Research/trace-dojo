import { CompileError, type SourceDiagnostic } from '../interpreter/diagnostics';
import type { TraceOptions } from '../interpreter/traceAnnotations';
import type { ClassNode, Expression, IterationSource, MemberExpression, Program, Statement } from '../javascript/ast';
import { nameOf, type Node, rowOf, unwrapParentheses } from '../javascript/convertNodes';
import { decodeStringLiteral } from '../javascript/literals';
import { isConstructorDefinition, ProgramConverter } from '../javascript/programConverter';
import { countedEnumValue, type FoldedValue, foldEnumValue } from './enumFolding';
import { PARAMETER_PROPERTY_ASSIGNMENT, unsteppedStatements } from './jsView';

/** Converts a TypeScript program, viewed as JavaScript, to the JavaScript interpreter's AST. */
export class TypeScriptProgramConverter extends ProgramConverter {
  /**
   * The reference runs a file without `import` or `export` as a CommonJS script, which is not strict mode code, and
   * compiles one with them to strict mode CommonJS.
   */
  protected override isStrictByDefault = false;
  protected override readonly hasAutoAccessors = true;
  /** What esbuild knows of the members of the enums converted so far, by enum and member. */
  private readonly foldedEnums = new Map<string, Map<string, FoldedValue>>();
  /** The errors of the statements that failed to convert, which tsc reports all of, unlike Node's first one. */
  private readonly statementErrors: SourceDiagnostic[] = [];

  /** @param isModule Whether the program has an `import` or an `export`, which makes it a module. */
  constructor(source: string, trace: TraceOptions | undefined, isModule: boolean) {
    super(source, trace);
    this.isStrictByDefault = isModule;
    this.recoverFromStatementErrors();
    const convertReturn = this.statementConverters.return_statement;
    this.statementConverters.return_statement = (node) => {
      const statement = convertReturn(node);
      if (statement.kind === 'return' && statement.value?.kind === 'call' && statement.value.callee.kind === 'super')
        statement.value.skipsAfterSuper = true;
      return statement;
    };
    this.statementConverters.enum_declaration = (node) => this.enumDeclaration(node);
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

  /**
   * `enum E { A, B = 5 }` as tsx compiles it: `var E = (E = E || {}, E[E["A"] = 0] = "A", …, E)`, with the values
   * esbuild folds (`foldEnumValue`): a member without an initializer counts up from the one before, and a member esbuild
   * knows to be a string has no reverse mapping.
   */
  private enumDeclaration(node: Node): Statement {
    const row = rowOf(node);
    const nameNode = node.childForFieldName('name') as Node;
    const name = nameOf(nameNode);
    this.declareVariable(nameNode, name, 'var');
    const enumObject = (): Expression => ({ kind: 'identifier', name, row });
    const memberOf = (key: Expression): MemberExpression => ({
      kind: 'member',
      object: enumObject(),
      property: { kind: 'computed', expression: key },
      optional: false,
      row,
    });
    const text = (value: string): Expression => ({ kind: 'literal', value, row });
    const assignments: Expression[] = [];
    const folded = this.foldedEnums.get(name) ?? new Map<string, FoldedValue>();
    this.foldedEnums.set(name, folded);
    let previous: FoldedValue;
    let isFirst = true;
    for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
      if (member.type === 'comment') continue;
      const key = enumMemberName(member);
      const initializer = member.childForFieldName('value');
      const known = initializer ? foldEnumValue(initializer, this.foldedEnums) : countedEnumValue(previous, isFirst);
      const value: Expression = initializer
        ? this.expression(initializer)
        : { kind: 'literal', value: known?.kind === 'number' ? known.value : undefined, row };
      assignments.push({ kind: 'assign', operator: '=', target: memberOf(text(key)), value, row });
      // esbuild maps the value back to the name unless it knows the value is a string.
      if (known?.kind !== 'string')
        assignments.push({
          kind: 'assign',
          operator: '=',
          target: memberOf(memberOf(text(key))),
          value: text(key),
          row,
        });
      folded.set(key, known);
      previous = known;
      isFirst = false;
    }
    const created: Expression = {
      kind: 'assign',
      operator: '=',
      target: { kind: 'identifier', name, row },
      value: { kind: 'logical', operator: '||', left: enumObject(), right: { kind: 'object', members: [], row }, row },
      row,
    };
    return {
      kind: 'declaration',
      declarationKind: 'var',
      declarators: [
        {
          target: { kind: 'identifier', name, row },
          init: { kind: 'sequence', expressions: [created, ...assignments, enumObject()], row },
        },
      ],
      stepRow: this.stepRowOf(node),
      row,
    };
  }

  override convert(root: Node): Program {
    const program = super.convert(root);
    if (this.statementErrors.length > 0) throw new CompileError(this.statementErrors);
    return {
      ...program,
      hasCommonJsReceiver: true,
      rejectsFunctionText: true,
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

  /** The decorators of a class or a class member, which run as TypeScript's standard decorators do. */
  protected override decoratorsOf(node: Node): Expression[] | undefined {
    const decorators = node.namedChildren.filter((child) => child.type === 'decorator');
    if (decorators.length === 0) return undefined;
    return decorators.map((decorator) => this.expression(decorator.namedChildren[0] as Node));
  }

  protected override stepRowOf(node: Node): number | undefined {
    return unsteppedStatements.has(node) ? undefined : super.stepRowOf(node);
  }

  protected override duplicate(node: Node, name: string): never {
    return super.duplicate(node.childForFieldName('name') ?? node, name);
  }

  protected override arrayDestructuringSource(node: Node): IterationSource | undefined {
    return super.arrayDestructuringSource(unwrapParentheses(node));
  }
}

/** The name of an enum member, which an identifier or a string literal gives. */
function enumMemberName(member: Node): string {
  const name = member.type === 'enum_assignment' ? (member.childForFieldName('name') as Node) : member;
  return name.type === 'string' ? decodeStringLiteral(name.text) : nameOf(name);
}
