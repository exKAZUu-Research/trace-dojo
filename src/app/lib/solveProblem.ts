import type { CharacterVariable, History, SolveProblemResult } from '../../types';

import { Board as BoardClass } from './Board';
import { Character as CharacterClass } from './Character';
import { Variable as VariableClass } from './Variable';

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function getVariableValue(command: string, variableName: string): string {
  const Character = CharacterClass; // eslint-disable-line
  const Variable = VariableClass; // eslint-disable-line

  const semicolonEndedCommand = (() => {
    if (command.endsWith(';')) return command;
    return (command += ';');
  })();

  const returnValueCommand = `
${variableName};
  `;

  const mergedCommand = semicolonEndedCommand + '\n' + returnValueCommand;

  return eval(mergedCommand);
}

export function executeEval(command: string): CharacterVariable[] {
  const Character = CharacterClass; // eslint-disable-line
  const Board = BoardClass; // eslint-disable-line
  const characterVariableName = 'character';
  const charactersVariables = extractVariables(characterVariableName, command);
  const semicolonEndedCommand = (() => {
    if (command.endsWith(';')) return command;
    return (command += ';');
  })();

  const result = charactersVariables.map((variableName) => {
    const returnValueCommand = `
      ${variableName};
    `;
    const mergedCommand = semicolonEndedCommand + '\n' + returnValueCommand;
    return { name: variableName, value: eval(mergedCommand) };
  });

  return result;
}

export function extractVariables(variableName: string, command: string): string[] {
  const regex = new RegExp(`${variableName}\\d+`, 'g');
  const matches = command.match(regex);
  if (matches) {
    return [...new Set(matches)];
  }
  return [];
}

export function extractVariableNames(command: string): string[] {
  // 'const' 'let' 'var' で始まる変数宣言を comand から抽出
  const regex = /(?:const|let|var)\s+(\w+)\s*=\s*(.*?);/g;
  const matches = [...command.matchAll(regex)];

  if (matches) {
    return matches.map((match) => {
      return match[1];
    });
  }
  return [];
}

export function solveProblem(program: string): SolveProblemResult {
  const commands = parseProgram(program);
  const board = new BoardClass();
  const histories: History[] = [{ step: 0, characterVariables: [], board, variables: [] }];

  for (let i = 0; i < commands.length; i++) {
    if (i < commands.length) {
      let mergedCommand = '';

      for (let j = 0; j <= i; j++) {
        mergedCommand += commands[j];
      }

      const characterVariables = executeEval(mergedCommand);

      // TODO: extractVariableNames と extractVariablesをまとめたい
      // TODO: executeEval と getVariableValue をまとめたい
      // TODO: Vraiableクラス必要？
      const variableNames = extractVariableNames(mergedCommand).filter((name) => !name.startsWith('character'));

      const variables = variableNames.map((name) => {
        const value = getVariableValue(mergedCommand, name);
        return new VariableClass({ name, value });
      });

      const board = new BoardClass();
      for (const history of histories) {
        if (!history.characterVariables) continue;

        for (const character of history.characterVariables) {
          board.updateGrid(character.value);
        }
      }
      for (const character of characterVariables) {
        board.updateGrid(character.value);
      }

      histories.push({ step: histories.length + 1, characterVariables, board, variables });
    }
  }

  const result: SolveProblemResult = {
    characterVariables: histories?.at(-1)?.characterVariables,
    variables: histories?.at(-1)?.variables,
    board: histories?.at(-1)?.board || board,
    histories,
  };
  return result;
}

export function isAnswerCorrect(
  problemProgram: string,
  answerCharacters: CharacterClass[],
  answerBoard: BoardClass,
  step?: number
): boolean {
  const correctAnswer = solveProblem(problemProgram).histories?.at(step || -1);

  if (!correctAnswer || !correctAnswer.characterVariables) return false;

  // 順番は関係なく、id以外のキャラクターの状態が一致しているかチェック
  const isCorrectCharacters: boolean = correctAnswer.characterVariables.every((characterVariable) => {
    const correctCharacter = characterVariable.value;

    const character = answerCharacters.find(
      (answerCharacter) =>
        answerCharacter.name === correctCharacter.name &&
        answerCharacter.x === correctCharacter.x &&
        answerCharacter.y === correctCharacter.y &&
        answerCharacter.direction === correctCharacter.direction &&
        answerCharacter.color === correctCharacter.color &&
        answerCharacter.penDown === correctCharacter.penDown
    );
    return character;
  });

  // すべてのセルの色が一致しているかチェック
  const isCorrectBoard: boolean = correctAnswer.board.grid.every((rows, rowIndex) =>
    rows.every((column, columnIndex) => {
      const cell = answerBoard.grid[rowIndex][columnIndex];
      return cell.color === column.color;
    })
  );

  return isCorrectCharacters && isCorrectBoard;
}
