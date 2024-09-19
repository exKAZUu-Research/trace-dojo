'use client';

import type { BoxProps } from '@chakra-ui/react';
import React, { useMemo } from 'react';

import {
  TURTLE_GRAPHICS_BOARD_COLUMNS as COLUMNS,
  TURTLE_GRAPHICS_BOARD_ROWS as ROWS,
  TURTLE_GRAPHICS_BOARD_CELL_SIZE_PX as CELL_SIZE_PX,
  TURTLE_GRAPHICS_BOARD_GAP_PX as GAP_PX,
  TURTLE_GRAPHICS_BOARD_PADDING_PX as PADDING_PX,
} from '../../../../../constants';
import { Box, Grid, GridItem, Img } from '../../../../../infrastructures/useClient/chakra';
import { charToColor } from '../../../../../problems/traceProgram';
import type { CharacterTrace, TraceItemVar } from '../../../../../problems/traceProgram';

const CHAR_TO_BG_COLOR = {
  '#': 'gray.600',
  '.': 'white',
  R: 'red.500',
  G: 'green.500',
  B: 'blue.500',
  Y: 'yellow.500',
  P: 'purple.500',
} as const;

const CHAR_TO_HOVERED_BG_COLOR = {
  '#': 'gray.900',
  '.': 'gray.100',
  R: 'red.600',
  G: 'green.600',
  B: 'blue.600',
  Y: 'yellow.600',
  P: 'purple.600',
} as const;

const DIR_TO_TRANSFORM_FUNCTION = {
  N: 'rotate(180deg)',
  S: 'rotate(0deg)',
  W: 'rotate(90deg)',
  E: 'rotate(270deg)',
} as const;

type Props = BoxProps & {
  board: string | undefined;
  vars: TraceItemVar | undefined;
  focusedCell?: { x: number; y: number };
  enableTransitions?: boolean;
  onCellClick?: (x: number, y: number) => void;
  onCellRightClick?: (x: number, y: number) => void;
  onCharacterClick?: (key: string) => void;
};

export const BoardViewer: React.FC<Props> = ({
  board,
  enableTransitions,
  focusedCell,
  onCellClick,
  onCellRightClick,
  onCharacterClick,
  vars,
  ...boxProps
}) => {
  const rows = useMemo(
    () =>
      board
        ?.trim()
        .split(/\s+/)
        .map((row) => [...row]) ?? [],
    [board]
  );

  const characters = useMemo(() => {
    const characters: (CharacterTrace & { key: string })[] = [];
    if (vars) {
      for (const [key, v] of Object.entries(vars)) {
        if (typeof v === 'number' || typeof v === 'string') continue;
        characters.push({ ...v, key });
      }
    }
    return characters;
  }, [vars]);

  console.debug('characters', characters);

  return (
    <Grid
      bg="gray.200"
      gap={`${GAP_PX}px`}
      p={`${PADDING_PX}px`}
      position="relative"
      rounded="md"
      templateColumns={`repeat(${COLUMNS}, ${CELL_SIZE_PX}px)`}
      templateRows={`repeat(${ROWS}, ${CELL_SIZE_PX}px)`}
      userSelect="none"
      w="min-content"
      {...boxProps}
    >
      {[...rows].map((row, rowIndex) =>
        row.map((cell, columnIndex) => (
          <GridItem
            key={`${rowIndex} ${columnIndex}`}
            _hover={
              onCellClick || onCellRightClick
                ? { bgColor: CHAR_TO_HOVERED_BG_COLOR[cell as keyof typeof CHAR_TO_BG_COLOR] }
                : undefined
            }
            bgColor={CHAR_TO_BG_COLOR[cell as keyof typeof CHAR_TO_BG_COLOR]}
            gridColumnStart={columnIndex + 1}
            gridRowStart={ROWS - rowIndex}
            rounded="sm"
            onClick={() => void onCellClick?.(columnIndex, rowIndex)}
            onContextMenu={(event) => {
              event.preventDefault();
              onCellRightClick?.(columnIndex, rowIndex);
            }}
          />
        ))
      )}

      {characters.map((character) => (
        <Box
          key={character.key}
          left={`${PADDING_PX}px`}
          position="absolute"
          style={{
            transform: `translate(${CELL_SIZE_PX / 2 + character.x * (CELL_SIZE_PX + GAP_PX)}px, ${CELL_SIZE_PX / 2 + (ROWS - character.y - 1) * (CELL_SIZE_PX + GAP_PX)}px) translate(-50%, -50%)`,
          }}
          top={`${PADDING_PX}px`}
          transitionDuration={enableTransitions ? 'normal' : undefined}
          transitionProperty={enableTransitions ? 'transform' : undefined}
          willChange={enableTransitions ? 'transform' : undefined}
          onClick={() => void onCharacterClick?.(character.key)}
          onContextMenu={(event) => {
            event.preventDefault();
            onCellRightClick?.(character.x, character.y);
          }}
        >
          <Img
            alt={'character' + character.x + character.y}
            src={`/character/${charToColor[character.color as keyof typeof charToColor]}.png`}
            transform={DIR_TO_TRANSFORM_FUNCTION[character.dir as keyof typeof DIR_TO_TRANSFORM_FUNCTION]}
            w={`${(0.75 * CELL_SIZE_PX).toFixed(3)}px`}
          />
        </Box>
      ))}

      {focusedCell && (
        <Box
          borderColor="yellow.500"
          borderWidth="4px"
          h={`${CELL_SIZE_PX + 12}px`}
          left={`${PADDING_PX}px`}
          pointerEvents="none"
          position="absolute"
          rounded="md"
          style={{
            transform: `translate(${CELL_SIZE_PX / 2 + focusedCell.x * (CELL_SIZE_PX + GAP_PX)}px, ${CELL_SIZE_PX / 2 + (ROWS - focusedCell.y - 1) * (CELL_SIZE_PX + GAP_PX)}px) translate(-50%, -50%)`,
          }}
          top={`${PADDING_PX}px`}
          w={`${CELL_SIZE_PX + 12}px`}
        />
      )}
    </Grid>
  );
};
