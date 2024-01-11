import React from 'react';

interface CharacterProps {
  character: {
    id: number;
    name: string;
    x: number;
    y: number;
    direction: string;
    color: string;
    penDown: boolean;
    path: string[];
  };
  onMoveForward: (id: number) => void;
}

export const Character: React.FC<CharacterProps> = ({ character, onMoveForward }) => {
  const gridSize = 40;

  const characterStyle: React.CSSProperties = {
    position: 'absolute',
    top: character.y * gridSize + 'px',
    left: character.x * gridSize + 'px',
    width: gridSize + 'px',
    height: gridSize + 'px',
    backgroundColor: character.color,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    textAlign: 'center',
  };

  // 軌跡を描画
  // TODO: 初期位置が軌跡として表示されない問題の解消
  {
    character.path.map((position) => {
      const [x, y] = position.split(',').map(Number);
      // TODO: 12（グリッドの列数）を定数にする
      const gridCell = document.querySelectorAll('.grid-cell')[x + y * 12];
      (gridCell as HTMLElement).style.backgroundColor = character.color;
      (gridCell as HTMLElement).style.opacity = '0.5';
    });
  }

  return (
    <div style={characterStyle}>
      <button onClick={() => onMoveForward(character.id)}>{character.name}</button>
    </div>
  );
};
