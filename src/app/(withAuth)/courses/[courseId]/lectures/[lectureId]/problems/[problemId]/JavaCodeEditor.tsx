'use client';

import { indentWithTab, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { java } from '@codemirror/lang-java';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type React from 'react';
import { useEffect, useImperativeHandle, useRef } from 'react';

import styles from './JavaCodeEditor.module.css';

export interface JavaCodeEditorHandle {
  undo: () => void;
  redo: () => void;
}

export interface EditorHistoryAvailability {
  canUndo: boolean;
  canRedo: boolean;
}

interface Props {
  ref?: React.Ref<JavaCodeEditorHandle>;
  onHistoryChange: (availability: EditorHistoryAvailability) => void;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export const JavaCodeEditor: React.FC<Props> = ({ ref, value, disabled, onChange, onHistoryChange }) => {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(undefined);
  const editing = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const initialValue = useRef(value);
  const onHistoryChangeRef = useRef(onHistoryChange);

  useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        const view = editor.current;
        if (disabled || !view || view.state.readOnly) return;
        undo(view);
        view.focus();
      },
      redo: () => {
        const view = editor.current;
        if (disabled || !view || view.state.readOnly) return;
        redo(view);
        view.focus();
      },
    }),
    [disabled]
  );

  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
  }, [onHistoryChange]);

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
        EditorView.contentAttributes.of({ 'aria-label': 'Javaコード' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          onHistoryChangeRef.current({ canUndo: undoDepth(update.state) > 0, canRedo: redoDepth(update.state) > 0 });
        }),
        EditorView.theme({
          '&': { backgroundColor: 'white', border: '1px solid #CBD5E0', borderRadius: '6px' },
          '&.cm-focused': { outline: '2px solid #3182CE' },
          '.cm-scroller': {
            fontFamily: '"JetBrains Mono", var(--chakra-fonts-mono, monospace)',
            fontVariantLigatures: 'none',
            overflow: 'auto',
          },
          '.cm-content': { minHeight: '280px' },
        }),
      ],
    });
    editor.current = view;
    onHistoryChangeRef.current({ canUndo: false, canRedo: false });
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
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: isolateHistory.of('full'),
      });
    }
  }, [value]);

  return <div ref={host} className={styles.editor} />;
};
