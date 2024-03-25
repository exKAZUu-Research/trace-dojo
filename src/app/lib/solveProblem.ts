import type { Problem } from '../../problems/generateProblem';
import type { CharacterVariable, History, SolveProblemResult, Variable } from '../../types';

import { Board as BoardClass } from './board';
import { Character as CharacterClass } from './character';

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function executeEval(command: string): (CharacterVariable | Variable)[] {
  const Character = CharacterClass; // eslint-disable-line
  const Board = BoardClass; // eslint-disable-line
  const variableNames = extractVariableNames(command);
  const semicolonEndedCommand = (() => {
    if (command.endsWith(';')) return command;
    return (command += ';');
  })();

  const result = variableNames.map((variableName) => {
    const returnValueCommand = `
      ${variableName};
    `;
    const mergedCommand = semicolonEndedCommand + '\n' + returnValueCommand;
    return { name: variableName, value: eval(mergedCommand) };
  });

  return result;
}

export function selectCharacterVariables(variables: (CharacterVariable | Variable)[]): CharacterVariable[] {
  return variables.filter((variable) => variable.value instanceof CharacterClass) as CharacterVariable[];
}

export function selectOtherVariables(variables: (CharacterVariable | Variable)[]): Variable[] {
  return variables.filter((variable) => !(variable.value instanceof CharacterClass)) as Variable[];
}

export function extractVariableNames(command: string): string[] {
  // 'const' 'let' 'var' で始まる変数名を comand から抽出する
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
  const histories: History[] = [{ step: 0, characterVariables: [], board, otherVariables: [] }];

  for (let i = 0; i < commands.length; i++) {
    if (i < commands.length) {
      let mergedCommand = '';

      for (let j = 0; j <= i; j++) {
        mergedCommand += commands[j];
      }

      const variables = executeEval(mergedCommand);
      const characterVariables = selectCharacterVariables(variables);
      const otherVariables = selectOtherVariables(variables);

      const board = new BoardClass();
      for (const history of histories) {
        if (!history.characterVariables) continue;

        for (const character of history.characterVariables) {
          board.updateGrid(character.value);
        }
      }
      for (const character of characterVariables) {
        board.updateGrid(character.value as CharacterClass);
      }

      histories.push({ step: histories.length + 1, characterVariables, board, otherVariables });
    }
  }

  const result: SolveProblemResult = {
    characterVariables: histories?.at(-1)?.characterVariables,
    otherVariables: histories?.at(-1)?.otherVariables,
    board: histories?.at(-1)?.board || board,
    histories,
  };
  return result;
}

export function isAnswerCorrect(
  problem: Problem,
  answerCharacters: CharacterClass[],
  answerBoard: BoardClass,
  step?: number
): boolean {
  // TODO: `solveProblem()` の代わりに `problem.traceItems` を参照すること。
  const correctAnswer = solveProblem(problem.displayProgram).histories?.at(step || -1);

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
