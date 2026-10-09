'use client';

import { indentWithTab } from '@codemirror/commands';
import { java } from '@codemirror/lang-java';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type React from 'react';
import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export const JavaCodeEditor: React.FC<Props> = ({ value, disabled, onChange }) => {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(undefined);
  const editing = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const initialValue = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      doc: initialValue.current,
      extensions: [
        basicSetup,
        java(),
        keymap.of([indentWithTab]),
        editing.current.of([]),
        EditorView.contentAttributes.of({ 'aria-label': 'Javaコード', 'aria-describedby': 'java-editor-help' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': { backgroundColor: 'white', border: '1px solid #CBD5E0', borderRadius: '6px' },
          '&.cm-focused': { outline: '2px solid #3182CE' },
          '.cm-scroller': { fontFamily: 'monospace', overflow: 'auto' },
          '.cm-content': { minHeight: '280px' },
        }),
      ],
    });
    editor.current = view;
    view.focus();
    return () => {
      view.destroy();
      editor.current = undefined;
    };
  }, []);

  useEffect(() => {
    editor.current?.dispatch({
      effects: editing.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
        EditorView.contentAttributes.of({ 'aria-disabled': String(disabled) }),
      ]),
    });
  }, [disabled]);

  useEffect(() => {
    const view = editor.current;
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} />;
};
