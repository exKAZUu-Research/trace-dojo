import type { NextPage } from 'next';

import { TurtleGraphics } from '../../../components/organisms/TurtleGraphics';

const SamplePage: NextPage = async () => {
  const initialCharacters = [
    { id: 1, name: 'Turtle1', x: 0, y: 0, direction: 'up', color: 'blue', penDown: true, path: ['0,0'] },
    { id: 2, name: 'Turtle2', x: 2, y: 2, direction: 'up', color: 'red', penDown: true, path: ['2,2'] },
    { id: 3, name: 'Turtle3', x: 3, y: 3, direction: 'down', color: 'green', penDown: true, path: ['3,3'] },
    // Add more characters as needed
  ];

  return (
    <div>
      <TurtleGraphics characters={initialCharacters} />
    </div>
  );
};

export default SamplePage;
