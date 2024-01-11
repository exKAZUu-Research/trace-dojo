import type { NextPage } from 'next';

import { TurtleGraphics } from '../../../components/organisms/TurtleGraphics';

const SamplePage: NextPage = async () => {
  const initialCharacters = [
    { id: 1, name: 'Turtle1', x: 0, y: 0, direction: 'up', color: 'blue', penDown: true, path: [] },
    { id: 2, name: 'Turtle2', x: 2, y: 2, direction: 'up', color: 'red', penDown: true, path: [] },
    { id: 3, name: 'Turtle3', x: 3, y: 3, direction: 'down', color: 'green', penDown: true, path: [] },
    // Add more characters as needed
  ];

  return (
    <div>
      <h1>Turtle Graphics App</h1>
      <TurtleGraphics characters={initialCharacters} />
    </div>
  );
};

export default SamplePage;
