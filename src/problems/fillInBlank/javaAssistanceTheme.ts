import { EditorView } from '@codemirror/view';

const proseFont = 'var(--chakra-fonts-body, sans-serif)';
const codeFont = '"JetBrains Mono", var(--chakra-fonts-mono, monospace)';

export const javaAssistanceTheme = EditorView.theme({
  '.cm-tooltip': {
    backgroundColor: '#ffffff',
    color: '#1f2328',
    border: '1px solid #d0d7de',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(31, 35, 40, 0.14)',
    fontSize: '0.875rem',
    lineHeight: '1.5',
    maxWidth: 'min(36rem, calc(100vw - 24px))',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: codeFont,
    padding: '4px',
    minWidth: '0',
    maxWidth: 'min(36rem, calc(100vw - 24px))',
    maxHeight: 'min(15rem, 40vh)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '6px 8px',
    borderRadius: '4px',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li:hover': { backgroundColor: '#f6f8fa' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected="true"]': {
    backgroundColor: '#ddf4ff',
    color: '#1f2328',
    outline: '1px solid #0969da',
    outlineOffset: '-1px',
  },
  '.cm-completionLabel': { fontWeight: '500' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-completionDetail': { fontStyle: 'normal', color: '#57606a', marginLeft: '0.75em' },
  '.cm-completionIcon': { opacity: '1', width: '1.25em', paddingRight: '0.5em', boxSizing: 'content-box' },
  '.cm-tooltip.cm-completionInfo': {
    fontFamily: proseFont,
    padding: '10px 12px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxWidth: 'min(22rem, calc(100vw - 24px))',
  },
  '.cm-tooltip-lint': { fontFamily: proseFont, padding: '4px', minWidth: '0' },
  '.cm-diagnostic': { padding: '8px 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid #d0d7de' },
  '.cm-diagnostic-error': { borderLeft: '3px solid #cf222e' },
  '.cm-diagnosticSource': { fontSize: '0.75rem', opacity: '1', color: '#57606a', marginTop: '4px' },
  '.cm-panel.cm-panel-lint': {
    backgroundColor: '#f6f8fa',
    color: '#1f2328',
    fontFamily: proseFont,
    fontSize: '0.875rem',
  },
  '.cm-panel.cm-panel-lint ul [aria-selected], .cm-panel.cm-panel-lint ul:focus [aria-selected]': {
    backgroundColor: '#ddf4ff',
    color: '#1f2328',
  },
  '.cm-panel.cm-panel-lint ul:focus [aria-selected]': { outline: '1px solid #0969da', outlineOffset: '-1px' },
  '@media (forced-colors: active)': {
    '.cm-tooltip': { borderColor: 'CanvasText' },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected="true"], .cm-panel.cm-panel-lint ul:focus [aria-selected]':
      {
        backgroundColor: 'Highlight',
        color: 'HighlightText',
        forcedColorAdjust: 'none',
        outlineColor: 'Highlight',
      },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected="true"] .cm-completionDetail, .cm-panel.cm-panel-lint ul:focus [aria-selected] .cm-diagnosticSource':
      {
        color: 'HighlightText',
      },
  },
});
