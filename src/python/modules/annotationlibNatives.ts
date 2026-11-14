import { annotateGlobals, callAnnotateWithFakeGlobals, classAnnotations } from '../annotations';
import { builtin } from '../define';
import { namespaceDict } from '../namespaces';
import { callValue } from '../objects';
import type { Runtime } from '../runtime';
import { newTuple, typeError } from '../types';
import { PyClass, type PyValue } from '../values';

/** The private helpers of annotationlib, which reach the annotations of functions, classes, and modules. */
export function annotationlibNatives(runtime: Runtime): Map<string, PyValue> {
  return new Map<string, PyValue>([
    [
      '_call_with_fake_globals',
      builtin('_call_with_fake_globals', 'expected', 4, 4, ([annotate, globals, allowEvaluation, stringifier]) =>
        callAnnotateWithFakeGlobals(annotate, {
          globals,
          allowEvaluation: allowEvaluation === true,
          stringifier: (name) => callValue(stringifier, [name]),
        })
      ),
    ],
    [
      '_annotate_namespaces',
      builtin('_annotate_namespaces', 'one', 1, 1, ([annotate]) =>
        newTuple([namespaceDict(annotateGlobals(annotate)), namespaceDict(runtime.builtins)])
      ),
    ],
    [
      '_class_annotations',
      builtin('_class_annotations', 'one', 1, 1, ([cls]) => {
        if (!(cls instanceof PyClass)) throw typeError('descriptor requires a type');
        return classAnnotations(cls);
      }),
    ],
  ]);
}
