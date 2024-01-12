'use client';

import type { NextPage } from 'next';

import { TurtleGraphics } from '../../../components/organisms/TurtleGraphics';
import { Character } from '../../lib/Character';

const SamplePage: NextPage = () => {
  const initialCharacters = [
    new Character(1, 'Turtle1', 0, 0, 'up', 'blue', false, ['0,0']),
    new Character(2, 'Turtle2', 3, 3, 'up', 'red', true, ['3,3']),
  ];

  return (
    <div>
      <TurtleGraphics characters={initialCharacters} />
    </div>
  );
};

export default SamplePage;
