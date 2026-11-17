import type { TraceOptions } from '../interpreter/traceAnnotations';
import type { Node } from '../javascript/convertNodes';
import { ProgramConverter } from '../javascript/programConverter';
import { PARAMETER_PROPERTY_ASSIGNMENT } from './jsView';

/** Converts a TypeScript program, viewed as JavaScript, to the JavaScript interpreter's AST. */
export class TypeScriptProgramConverter extends ProgramConverter {
  // The reference runs a file without `import` or `export` as a CommonJS script, which is not strict mode code.
  protected override readonly isStrictByDefault = false;

  constructor(source: string, trace: TraceOptions | undefined) {
    super(source, trace);
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
}
