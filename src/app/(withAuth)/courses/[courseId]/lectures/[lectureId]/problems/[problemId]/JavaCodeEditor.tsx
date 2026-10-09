'use client';

import { Box, HStack, IconButton } from '@chakra-ui/react';
import { indentWithTab, isolateHistory, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { java } from '@codemirror/lang-java';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import type React from 'react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { MdOutlineZoomIn, MdOutlineZoomOut } from 'react-icons/md';

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
  const [fontSize, setFontSize] = useState(8);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(undefined);
  const editing = useRef(new Compartment());
  const fontSizeTheme = useRef(new Compartment());
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
        syntaxHighlighting(
          HighlightStyle.define([
            { tag: tags.comment, color: '#6e7781' },
            { tag: [tags.keyword, tags.operator], color: '#cf222e' },
            { tag: tags.string, color: '#0a3069' },
            { tag: [tags.number, tags.bool, tags.null, tags.constant(tags.variableName)], color: '#0550ae' },
            { tag: tags.function(tags.variableName), color: '#8250df' },
            { tag: [tags.typeName, tags.className], color: '#953800' },
          ])
        ),
        keymap.of([indentWithTab]),
        editing.current.of([]),
        fontSizeTheme.current.of([]),
        EditorView.contentAttributes.of({ 'aria-label': 'Javaコード' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          onHistoryChangeRef.current({ canUndo: undoDepth(update.state) > 0, canRedo: redoDepth(update.state) > 0 });
        }),
        EditorView.theme({
          '&': { backgroundColor: 'white', color: '#1f2328' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily: '"JetBrains Mono", var(--chakra-fonts-mono, monospace)',
            fontVariantLigatures: 'none',
            lineHeight: '1.4',
            overflow: 'auto',
          },
          '.cm-content': { minHeight: '280px' },
          '.cm-gutters': { backgroundColor: 'white', color: '#6e7781', border: 'none' },
          '.cm-activeLine': { backgroundColor: 'rgba(165, 185, 205, 0.1)' },
          '.cm-activeLineGutter': { backgroundColor: '#f6f8fa' },
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
            {
              backgroundColor: '#b6e3ff',
            },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1f2328' },
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

  useEffect(() => {
    editor.current?.dispatch({
      effects: fontSizeTheme.current.reconfigure(
        EditorView.theme({ '.cm-scroller': { fontSize: `${fontSize / 8}rem` } })
      ),
    });
  }, [fontSize]);

  return (
    <Box className={styles.editor}>
      <div ref={host} className={styles.host} />
      <HStack position="absolute" top="8px" right="8px" spacing="4px" zIndex={1} pointerEvents="none">
        <IconButton
          aria-label="コードを縮小"
          title="コードを縮小"
          type="button"
          icon={<MdOutlineZoomOut size={20} />}
          size="sm"
          width="32px"
          height="32px"
          variant="ghost"
          bg="rgba(255, 255, 255, 0.8)"
          pointerEvents="auto"
          isDisabled={fontSize === 6}
          onClick={() => setFontSize((size) => Math.max(6, size - 1))}
        />
        <IconButton
          aria-label="コードを拡大"
          title="コードを拡大"
          type="button"
          icon={<MdOutlineZoomIn size={20} />}
          size="sm"
          width="32px"
          height="32px"
          variant="ghost"
          bg="rgba(255, 255, 255, 0.8)"
          pointerEvents="auto"
          isDisabled={fontSize === 16}
          onClick={() => setFontSize((size) => Math.min(16, size + 1))}
        />
      </HStack>
    </Box>
  );
};
