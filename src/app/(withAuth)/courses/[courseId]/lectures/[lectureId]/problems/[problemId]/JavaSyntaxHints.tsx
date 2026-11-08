import { Box, Portal, useColorModeValue, useMergeRefs, useTooltip } from '@chakra-ui/react';
import {
  cloneElement,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useEffect,
  useRef,
} from 'react';
import { createElement, type createElementProps, Prism, type SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { type Updater, useImmer } from 'use-immer';

import { getJavaSyntaxHint, type JavaSyntaxHintContent } from './javaSyntaxHintContent';

type RendererProps = Parameters<NonNullable<SyntaxHighlighterProps['renderer']>>[0];
type Node = createElementProps['node'];
interface Hint {
  index: number;
  text: string;
  description: JavaSyntaxHintContent;
}
interface HintState {
  active: number;
  open?: number;
  pinned: boolean;
  pressed: boolean;
  dragging: boolean;
}
interface HintController {
  cancelClose: () => void;
  pin: () => void;
  show: (index: number) => void;
  hover: (index: number) => void;
  leave: () => void;
  toggle: (index: number) => void;
  dismiss: () => void;
  press: () => void;
  focus: (index: number) => void;
  move: (index: number) => void;
  scrollTooltip: (direction: 1 | -1, page: boolean) => boolean;
  isTarget: (element: EventTarget) => boolean;
}
type HintKeyAction =
  | { kind: 'move'; index: number }
  | { kind: 'scroll'; direction: 1 | -1; page: boolean }
  | { kind: 'toggle' }
  | { kind: 'dismiss' }
  | { kind: 'leave' };

export const JavaSyntaxHints: React.FC<RendererProps> = ({ rows, stylesheet, useInlineStyles }) => {
  const [state, update] = useImmer<HintState>({ active: 0, pinned: false, pressed: false, dragging: false });
  const popup = useTooltip({
    isOpen: state.open !== undefined && !state.dragging,
    closeOnClick: false,
    closeOnEsc: false,
    closeOnPointerDown: false,
    modifiers: [{ name: 'preventOverflow', options: { altAxis: true, tether: false, padding: 12 } }],
  });
  const targets = useRef(new Map<number, HTMLSpanElement>());
  const tooltip = useRef<HTMLDivElement>(null);
  const hints = new Map<Node, Hint>();
  for (const row of rows) collectHints(row, hints);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useOutsideDismissal(update, targets, tooltip);

  const controller = createHintController(update, closeTimer, targets, tooltip);

  const renderNode = (node: Node, key: string): ReactNode => {
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
    return (
      <HintToken
        key={key}
        controller={controller}
        hint={hint}
        hintCount={hints.size}
        // Chromium starts no drag selection on an inline element that the press focuses.
        tabIndex={state.pressed ? undefined : state.active === hint.index ? 0 : -1}
        targets={targets}
        triggerProps={triggerProps}
      >
        {element}
      </HintToken>
    );
  };

  const content = [...hints.values()].find((hint) => hint.index === state.open)?.description;

  return (
    <>
      {rows.map((row, index) => renderNode(row, String(index)))}
      {popup.isOpen && content && (
        <HintTooltip
          content={content}
          positionerProps={popup.getTooltipPositionerProps()}
          tooltipProps={popup.getTooltipProps()}
          tooltipRef={tooltip}
          onPin={controller.pin}
          onEnter={controller.cancelClose}
          onLeave={controller.leave}
        />
      )}
    </>
  );
};

// code-gauge-allow functionNcss 42 -- One small handler per hint interaction, all sharing the close timer and state updater.
const createHintController = (
  update: Updater<HintState>,
  closeTimer: RefObject<ReturnType<typeof setTimeout> | undefined>,
  targets: RefObject<Map<number, HTMLSpanElement>>,
  tooltip: RefObject<HTMLDivElement | null>
): HintController => {
  const cancelClose = (): void => clearTimeout(closeTimer.current);
  const controller: HintController = {
    cancelClose,
    pin: () => {
      cancelClose();
      update((draft) => {
        draft.pinned = true;
      });
    },

    show: (index) => {
      cancelClose();
      update((draft) => {
        if (!draft.pinned) draft.open = index;
      });
    },
    hover: (index) => {
      // A hover without a pressed button proves that any earlier press ended, even one released outside the page.
      update(releasePress);
      controller.show(index);
    },
    leave: () => {
      cancelClose();
      // Allow the pointer to cross the portal's positioning gap.
      closeTimer.current = setTimeout(() => {
        update((draft) => {
          if (!draft.pinned) draft.open = undefined;
        });
      }, 200);
    },
    toggle: (index) => {
      cancelClose();
      update((draft) => {
        const closing = draft.pinned && draft.open === index;
        draft.active = index;
        draft.open = closing ? undefined : index;
        draft.pinned = !closing;
      });
    },
    dismiss: () => {
      cancelClose();
      update((draft) => {
        draft.open = undefined;
        draft.pinned = false;
      });
    },
    press: () => {
      update((draft) => {
        draft.pressed = true;
      });
    },
    focus: (index) => {
      update((draft) => {
        draft.active = index;
      });
      controller.show(index);
    },
    move: (index) => {
      update((draft) => {
        draft.pinned = false;
        draft.open = index;
      });
      targets.current.get(index)?.focus();
    },
    scrollTooltip: (direction, page) => {
      if (!tooltip.current) return false;
      const distance = page ? tooltip.current.clientHeight * 0.8 : 40;
      tooltip.current.scrollBy({ top: direction * distance });
      return true;
    },
    isTarget: (element) => [...targets.current.values()].some((target) => target === element),
  };
  return controller;
};

// code-gauge-allow functionNcss 39 -- One small listener per document or window event that ends a press or closes the hint.
const useOutsideDismissal = (
  update: Updater<HintState>,
  targets: RefObject<Map<number, HTMLSpanElement>>,
  tooltip: RefObject<HTMLDivElement | null>
): void => {
  useEffect(() => {
    const close = (draft: HintState): void => {
      draft.open = undefined;
      draft.pinned = false;
    };
    const outside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if ([...targets.current.values(), tooltip.current].some((element) => element?.contains(target))) return;
      update(close);
    };
    const release = (): void => {
      update((draft) => {
        releasePress(draft);
        if (globalThis.getSelection()?.isCollapsed === false) close(draft);
      });
    };
    const select = (): void => {
      update((draft) => {
        draft.dragging = draft.pressed && globalThis.getSelection()?.isCollapsed === false;
      });
    };
    const key = (event: globalThis.KeyboardEvent): void => {
      update((draft) => {
        releasePress(draft);
        if (event.key === 'Escape') close(draft);
      });
    };
    const blur = (): void => update(releasePress);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('selectionchange', select);
    document.addEventListener('keydown', key);
    globalThis.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
      document.removeEventListener('selectionchange', select);
      document.removeEventListener('keydown', key);
      globalThis.removeEventListener('blur', blur);
    };
  }, [update, targets, tooltip]);
};

const releasePress = (draft: HintState): void => {
  draft.pressed = false;
  draft.dragging = false;
};

interface HintTokenProps {
  children: ReactNode;
  controller: HintController;
  hint: Hint;
  hintCount: number;
  tabIndex: number | undefined;
  targets: RefObject<Map<number, HTMLSpanElement>>;
  triggerProps: { ref?: Ref<HTMLElement> } & Record<string, unknown>;
}

// code-gauge-allow functionCognitiveComplexity 21 -- One branch per hint key action and pointer or focus event of the token.
// code-gauge-allow functionNcss 32 -- One branch per hint key action and pointer or focus event of the token.
const HintToken: React.FC<HintTokenProps> = ({
  children,
  controller,
  hint,
  hintCount,
  tabIndex,
  targets,
  triggerProps,
}) => {
  const ref = useMergeRefs(triggerProps.ref, (target: HTMLSpanElement | null) => {
    if (target) targets.current.set(hint.index, target);
    else targets.current.delete(hint.index);
  });
  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    const action = hintKeyAction(event, hint.index, hintCount);
    if (!action) return;
    if (action.kind === 'leave') {
      controller.dismiss();
      return;
    }
    if (action.kind === 'scroll' && !controller.scrollTooltip(action.direction, action.page)) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === 'move') controller.move(action.index);
    else if (action.kind === 'toggle') controller.toggle(hint.index);
    else if (action.kind === 'dismiss') controller.dismiss();
  };
  return (
    <span
      {...triggerProps}
      ref={ref}
      className="java-syntax-hint"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Native buttons prevent selecting code text across targets.
      role="button"
      aria-label={`${hint.text} の説明`}
      tabIndex={tabIndex}
      onPointerEnter={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (event.buttons === 0) controller.hover(hint.index);
      }}
      onPointerDown={controller.press}
      onPointerLeave={controller.leave}
      onFocus={() => controller.focus(hint.index)}
      onBlur={(event: FocusEvent<HTMLSpanElement>) => {
        if (event.relatedTarget && !controller.isTarget(event.relatedTarget)) controller.dismiss();
      }}
      onClick={() => {
        if (globalThis.getSelection()?.isCollapsed) controller.toggle(hint.index);
      }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </span>
  );
};

const hintKeyAction = (
  event: KeyboardEvent<HTMLSpanElement>,
  index: number,
  count: number
): HintKeyAction | undefined => {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
  switch (event.key) {
    case 'ArrowRight': {
      return { kind: 'move', index: (index + 1) % count };
    }
    case 'ArrowLeft': {
      return { kind: 'move', index: (index + count - 1) % count };
    }
    case 'Home': {
      return { kind: 'move', index: 0 };
    }
    case 'End': {
      return { kind: 'move', index: count - 1 };
    }
    case 'ArrowUp':
    case 'PageUp': {
      return { kind: 'scroll', direction: -1, page: event.key === 'PageUp' };
    }
    case 'ArrowDown':
    case 'PageDown': {
      return { kind: 'scroll', direction: 1, page: event.key === 'PageDown' };
    }
    case 'Enter':
    case ' ': {
      return { kind: 'toggle' };
    }
    case 'Escape': {
      return { kind: 'dismiss' };
    }
    case 'Tab': {
      return { kind: 'leave' };
    }
    default: {
      return undefined;
    }
  }
};

const HintTooltip: React.FC<{
  content: JavaSyntaxHintContent;
  positionerProps: Record<string, unknown>;
  tooltipProps: Record<string, unknown>;
  tooltipRef: RefObject<HTMLDivElement | null>;
  onPin: () => void;
  onEnter: () => void;
  onLeave: () => void;
}> = ({ content, positionerProps, tooltipProps, tooltipRef, onPin, onEnter, onLeave }) => {
  const cardBackground = useColorModeValue('white', 'gray.800');
  const cardForeground = useColorModeValue('gray.800', 'gray.100');
  const codeBackground = useColorModeValue('gray.50', 'gray.900');
  const cardBorder = useColorModeValue('gray.200', 'gray.600');
  return (
    <Portal>
      <Box {...positionerProps} zIndex="tooltip" pointerEvents="none">
        <Box
          {...tooltipProps}
          ref={tooltipRef}
          pointerEvents="auto"
          bg={cardBackground}
          color={cardForeground}
          border="1px solid"
          borderColor={cardBorder}
          borderRadius="xl"
          boxShadow="lg"
          p={4}
          w="26rem"
          maxW="calc(100vw - 24px)"
          maxH="calc(100dvh - 24px)"
          overflowY="auto"
          overscrollBehavior="contain"
          fontSize="sm"
          lineHeight="1.6"
          fontWeight="normal"
          textAlign="left"
          whiteSpace="normal"
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.pointerType === 'touch') onPin();
          }}
          onPointerEnter={onEnter}
          onPointerLeave={onLeave}
        >
          <Box as="p" mb={3}>
            {content.meaning}
          </Box>
          <HintCode label="書き方" code={content.syntax} background={codeBackground} />
          <HintCode label="例" code={content.example} background={codeBackground} />
          <Box as="p" mt={3}>
            {content.explanation}
          </Box>
        </Box>
      </Box>
    </Portal>
  );
};

const HintCode: React.FC<{ label: string; code: string; background: string }> = ({ label, code, background }) => {
  const theme = useColorModeValue(oneLight, oneDark);
  return (
    <Box mt={3}>
      <Box fontSize="xs" fontWeight="semibold" mb={1}>
        {label}
      </Box>
      <Box bg={background} borderRadius="md" px={3} py={2} fontFamily="mono" fontSize="sm" lineHeight="1.5">
        <Prism
          language="java"
          style={theme}
          wrapLongLines
          customStyle={{
            background: 'transparent',
            margin: 0,
            padding: 0,
            fontFamily: 'inherit',
            fontSize: 'inherit',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
          codeTagProps={{ style: { background: 'transparent', fontFamily: 'inherit', whiteSpace: 'pre-wrap' } }}
        >
          {code}
        </Prism>
      </Box>
    </Box>
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
