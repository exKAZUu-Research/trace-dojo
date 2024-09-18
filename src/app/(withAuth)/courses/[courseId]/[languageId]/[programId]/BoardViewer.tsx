'use client';

import type { BoxProps } from '@chakra-ui/react';
import React, { useMemo } from 'react';

import {
  TURTLE_GRAPHICS_GRID_COLUMNS as GRID_COLUMNS,
  TURTLE_GRAPHICS_GRID_ROWS as GRID_ROWS,
  TURTLE_GRAPHICS_GRID_SIZE as GRID_SIZE,
  TURTLE_GRAPHICS_GRID_GAP as GRID_GAP,
} from '../../../../../../constants';
import { Box, Grid, GridItem, Image } from '../../../../../../infrastructures/useClient/chakra';
import { type CharacterTrace, charToColor, type TraceItem } from '../../../../../../problems/traceProgram';

const charToBgColor = {
  '#': 'gray.800',
  '.': 'white',
  R: 'red.500',
  G: 'green.500',
  B: 'blue.500',
  Y: 'yellow.500',
  P: 'purple.500',
} as const;

const charToRotateStyle = {
  N: 'rotate(180deg)',
  S: 'rotate(0deg)',
  W: 'rotate(90deg)',
  E: 'rotate(270deg)',
} as const;

type Props = BoxProps & { traceItem: TraceItem | undefined };

export const BoardViewer: React.FC<Props> = ({ traceItem, ...boxProps }) => {
  const board = useMemo(
    () =>
      traceItem?.board
        .trim()
        .split(/\s+/)
        .map((row) => [...row]) ?? [],
    [traceItem?.board]
  );

  const characters = useMemo(() => {
    const characters: CharacterTrace[] = [];
    if (traceItem?.vars) {
      for (const v of Object.values(traceItem.vars)) {
        if (typeof v === 'number' || typeof v === 'string') continue;
        characters.push(v);
      }
    }
    return characters;
  }, [traceItem?.vars]);

  console.debug('characters', characters);

  return (
    <Grid
      bg="gray.100"
      gap={`${GRID_GAP}px`}
      p={`${GRID_GAP}px`}
      position="relative"
      rounded="md"
      templateColumns={`repeat(${GRID_COLUMNS}, ${GRID_SIZE}px)`}
      templateRows={`repeat(${GRID_ROWS}, ${GRID_SIZE}px)`}
      userSelect="none"
      w="min-content"
      {...boxProps}
    >
      {[...board].map((row, rowIndex) =>
        row.map((cell, columnIndex) => (
          <GridItem
            key={`${rowIndex} ${columnIndex}`}
            backgroundColor={charToBgColor[cell as keyof typeof charToBgColor]}
            gridColumnStart={columnIndex + 1}
            gridRowStart={GRID_ROWS - rowIndex}
            rounded="sm"
          />
        ))
      )}
      {characters.map((character) => (
        <Box
          key={'character' + character.x + character.y}
          h={GRID_SIZE + 'px'}
          left={GRID_GAP + character.x * (GRID_SIZE + GRID_GAP) + 'px'}
          position="absolute"
          top={GRID_GAP + (GRID_ROWS - character.y - 1) * (GRID_SIZE + GRID_GAP) + 'px'}
          w={GRID_SIZE + 'px'}
        >
          <Box p="0.2rem" transform={charToRotateStyle[character.dir as keyof typeof charToRotateStyle]}>
            <Image
              alt={'character' + character.x + character.y}
              src={`/character/${charToColor[character.color as keyof typeof charToColor]}.png`}
              width={GRID_SIZE}
            />
          </Box>
        </Box>
      ))}
    </Grid>
  );
};
