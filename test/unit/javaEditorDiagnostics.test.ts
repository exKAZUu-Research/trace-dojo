// @vitest-environment jsdom
import { java } from '@codemirror/lang-java';
import { diagnosticCount, forceLinting } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { expect, test } from 'vitest';

import { fillInBlankProblemDefinitions } from '../../src/problems/fillInBlank/definitions';
import { javaEditorDiagnostics } from '../../src/problems/fillInBlank/javaEditorDiagnostics';
import { instantiateProblem } from '../../src/problems/instantiateProblem';

test.each(Object.keys(fillInBlankProblemDefinitions))(
  'the untouched %s starter shows no local syntax hint for its placeholders',
  async (id) => {
    const problem = instantiateProblem(id, 'java', 'starter-hints');
    if (!problem) throw new Error(`Unknown problem: ${id}`);
    const view = new EditorView({
      parent: document.body,
      doc: `${problem.displayProgram}\nclass Probe { int value = ; }`,
      extensions: [java(), javaEditorDiagnostics],
    });
    try {
      forceLinting(view);
      // The appended probe line proves linting ran; only it may be reported.
      await expect.poll(() => diagnosticCount(view.state)).toBe(1);
    } finally {
      view.destroy();
    }
  }
);
