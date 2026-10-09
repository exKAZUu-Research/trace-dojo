import { Box, Portal, useStyleConfig, useTooltip } from '@chakra-ui/react';
import {
  cloneElement,
  useEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { createElement, type createElementProps, type SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { useImmer } from 'use-immer';
import { getJavaSyntaxHint } from './javaSyntaxHintContent';

type RendererProps = Parameters<NonNullable<SyntaxHighlighterProps['renderer']>>[0];
type Node = createElementProps['node'];
interface Hint {
  index: number;
  text: string;
  description: string;
}

export const JavaSyntaxHints: React.FC<RendererProps> = ({ rows, stylesheet, useInlineStyles }) => {
  const [state, update] = useImmer<{ active: number; open?: number; pinned: boolean; selecting: boolean }>({
    active: 0,
    pinned: false,
    selecting: false,
  });
  const popup = useTooltip({
    isOpen: state.open !== undefined && !state.selecting,
    closeOnClick: false,
    closeOnEsc: false,
    closeOnPointerDown: false,
  });
  const tooltipStyles = useStyleConfig('Tooltip');
  const targets = useRef(new Map<number, HTMLSpanElement>());
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hints = new Map<Node, Hint>();
  for (const row of rows) collectHints(row, hints);

  const cancelClose = (): void => clearTimeout(closeTimer.current);
  const dismiss = (): void => {
    cancelClose();
    update((draft) => {
      draft.open = undefined;
      draft.pinned = false;
    });
  };
  const leave = (): void => {
    cancelClose();
    // Allow the pointer to cross the portal's positioning gap.
    closeTimer.current = setTimeout(() => {
      update((draft) => {
        if (!draft.pinned) draft.open = undefined;
      });
    }, 200);
  };
  const show = (index: number): void => {
    cancelClose();
    update((draft) => {
      if (!draft.pinned) draft.open = index;
    });
  };
  const toggle = (index: number): void => {
    cancelClose();
    update((draft) => {
      const closing = draft.pinned && draft.open === index;
      draft.active = index;
      draft.open = closing ? undefined : index;
      draft.pinned = !closing;
    });
  };

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if ([...targets.current.values(), tooltip.current].some((element) => element?.contains(target))) return;
      update((draft) => {
        draft.open = undefined;
        draft.pinned = false;
      });
    };
    const release = (): void => {
      update((draft) => {
        draft.selecting = false;
        if (globalThis.getSelection()?.isCollapsed === false) {
          draft.open = undefined;
          draft.pinned = false;
        }
      });
    };
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape')
        update((draft) => {
          draft.open = undefined;
          draft.pinned = false;
        });
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
      document.removeEventListener('keydown', escape);
      clearTimeout(closeTimer.current);
    };
  }, [update]);

  const renderNode = (node: Node, key: string): React.ReactNode => {
    const element = createElement({ node, stylesheet, useInlineStyles, key });
    if (node.type === 'text') return element;
    const hint = hints.get(node);
    if (!hint) {
      return cloneElement(
        element as ReactElement,
        undefined,
        node.children?.map((child, index) => renderNode(child, `${key}-${index}`))
      );
    }
    const triggerProps = state.open === hint.index ? popup.getTriggerProps() : {};
    const setTarget = (target: HTMLSpanElement | null): void => {
      if (typeof triggerProps.ref === 'function') triggerProps.ref(target);
      else if (triggerProps.ref) triggerProps.ref.current = target;
      if (target) targets.current.set(hint.index, target);
      else targets.current.delete(hint.index);
    };
    return (
      <span
        key={key}
        {...triggerProps}
        ref={setTarget}
        className="java-syntax-hint"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Native buttons prevent selecting code text across targets.
        role="button"
        aria-label={`${hint.text} の説明`}
        tabIndex={state.active === hint.index ? 0 : -1}
        onPointerEnter={(event: ReactPointerEvent<HTMLSpanElement>) => {
          if (event.buttons === 0) show(hint.index);
        }}
        onPointerDown={() => {
          update((draft) => {
            draft.selecting = true;
          });
        }}
        onPointerLeave={leave}
        onFocus={() => {
          update((draft) => {
            draft.active = hint.index;
          });
          show(hint.index);
        }}
        onBlur={(event: FocusEvent<HTMLSpanElement>) => {
          if (event.relatedTarget && ![...targets.current.values()].some((target) => target === event.relatedTarget))
            dismiss();
        }}
        onClick={() => {
          if (!globalThis.getSelection()?.isCollapsed) return;
          toggle(hint.index);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          const next =
            event.key === 'ArrowRight'
              ? (hint.index + 1) % hints.size
              : event.key === 'ArrowLeft'
                ? (hint.index + hints.size - 1) % hints.size
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? hints.size - 1
                    : undefined;
          if (next !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            update((draft) => {
              draft.pinned = false;
              draft.open = next;
            });
            targets.current.get(next)?.focus();
          } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            toggle(hint.index);
          } else if (event.key === 'Tab') {
            dismiss();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        }}
      >
        {element}
      </span>
    );
  };

  return (
    <>
      {rows.map((row, index) => renderNode(row, String(index)))}
      {popup.isOpen && (
        <Portal>
          <Box {...popup.getTooltipPositionerProps()} zIndex="tooltip" pointerEvents="none">
            <Box
              {...popup.getTooltipProps()}
              ref={tooltip}
              __css={tooltipStyles}
              pointerEvents="auto"
              maxW="24rem"
              onPointerEnter={cancelClose}
              onPointerLeave={leave}
            >
              {[...hints.values()].find((hint) => hint.index === state.open)?.description}
            </Box>
          </Box>
        </Portal>
      )}
    </>
  );
};

const collectHints = (node: Node, hints: Map<Node, Hint>): void => {
  const classes: string[] = node.properties?.className ?? [];
  if (classes.some((name) => ['comment', 'string', 'char', 'linenumber'].includes(name))) return;
  if (node.children?.every((child) => child.type === 'text')) {
    const text = node.children.map((child) => child.value ?? '').join('');
    const description = getJavaSyntaxHint(text, classes);
    if (description) hints.set(node, { index: hints.size, text, description });
  } else {
    for (const child of node.children ?? []) collectHints(child, hints);
  }
};
