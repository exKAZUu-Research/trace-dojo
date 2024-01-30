import type { History, SolveProblemResult } from '../../types';

import { Board as BoardClass } from './Board';
import { Character as CharacterClass } from './Character';

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function executeEval(command: string): CharacterClass[] {
  const Character = CharacterClass; // eslint-disable-line
  const Board = BoardClass; // eslint-disable-line
  const characterVariableName = 'character';
  const charactersVariables = extractVariables(characterVariableName, command);
  const semicolonEndedCommand = (() => {
    if (command.endsWith(';')) return command;
    return (command += ';');
  })();

  const returnValueCommand = `
    [${charactersVariables}];
  `;

  const mergedCommand = semicolonEndedCommand + '\n' + returnValueCommand;

  return eval(mergedCommand);
}

export function extractVariables(variableName: string, command: string): string[] {
  const regex = new RegExp(`${variableName}\\d+`, 'g');
  const matches = command.match(regex);
  if (matches) {
    return [...new Set(matches)];
  }
  return [];
}

export function solveProblem(program: string): SolveProblemResult {
  const commands = parseProgram(program);
  const board = new BoardClass();
  const histories: History[] = [{ step: 0, characters: [], board }];

  for (let i = 0; i < commands.length; i++) {
    if (i < commands.length) {
      let mergedCommand = '';

      for (let j = 0; j <= i; j++) {
        mergedCommand += commands[j];
      }

      const characters = executeEval(mergedCommand);

      const board = new BoardClass();
      for (const history of histories) {
        if (!history.characters) continue;

        for (const character of history.characters) {
          board.updateGrid(character);
        }
      }
      for (const character of characters) {
        board.updateGrid(character);
      }

      histories.push({ step: histories.length + 1, characters, board });
    }
  }

  const result: SolveProblemResult = {
    characters: histories?.at(-1)?.characters,
    board: histories?.at(-1)?.board || board,
    histories,
  };
  return result;
}

export function isAnswerCorrect(
  problemProgram: string,
  answerCharacters: CharacterClass[],
  answerBoard: BoardClass
): boolean {
  const answer = solveProblem(problemProgram);

  if (!answer.characters || !answer.board) return false;

  // 順番は関係なく、id以外のキャラクターの状態が一致しているかチェック
  const isCorrectCharacters: boolean = answer.characters.every((correctCharacter) => {
    const character = answerCharacters.find(
      (answerCharacter) =>
        answerCharacter.name === correctCharacter.name &&
        answerCharacter.x === correctCharacter.x &&
        answerCharacter.y === correctCharacter.y &&
        answerCharacter.direction === correctCharacter.direction &&
        answerCharacter.color === correctCharacter.color &&
        answerCharacter.penDown === correctCharacter.penDown &&
        answerCharacter.path?.join(',') === correctCharacter.path?.join(',')
    );
    return character;
  });

  // すべてのセルの色が一致しているかチェック
  const isCorrectBoard: boolean = answer.board.grid.every((rows, rowIndex) =>
    rows.every((column, columnIndex) => {
      const cell = answerBoard.grid[rowIndex][columnIndex];
      return cell.color === column.color;
    })
  );

  return isCorrectCharacters && isCorrectBoard;
}
