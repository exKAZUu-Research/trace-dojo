import type { CharacterVariable, History, SolveProblemResult, Variable } from '../../types';

import { Board as BoardClass } from './Board';
import type { Character } from './Character';
import { Character as CharacterClass } from './Character';

export function parseProgram(program: string): string[] {
  return program
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function instrumentCode(code: string): string {
  // generateCodeからコードを受け取って、トレースできるコードを返す関数
  const sidRegex = /\/\* (\d+) \*\//;
  const assignmentRegex = /([\w.]+)(?: = |\+\+|--)/;
  const modifiedCodeLines: string[] = [];
  const lines = code.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trimStart();
    let modifiedCodeLine = trimmedLine;
    const statementMatch = trimmedLine.match(sidRegex);
    if (statementMatch) {
      const sid = statementMatch[1];

      // ' = 'を含むline
      const assignmentMatch = line.match(assignmentRegex);
      if (assignmentMatch) {
        const variableName = assignmentMatch[1].trim();

        modifiedCodeLine = modifiedCodeLine.replace(sidRegex, `log(${sid}, '${variableName}', ${variableName});`);
      }
    }
    modifiedCodeLines.push(modifiedCodeLine);
  }
  return modifiedCodeLines.join('\n');
}

type Trace = {
  sid: number;
  variableName: string;
  variableValue: Character | string;
};

export function traceCode(code: string): Trace[] {
  const Character = CharacterClass; // eslint-disable-line
  const Board = BoardClass; // eslint-disable-line
  const codeForTracing = `
const traceList = [];

${code}

function log(sid, variableName, variableValue) {
  if (typeof value === 'number' && (!isFinite(value) || isNaN(value) || (modulo && value < 0))) {
    process.exit(1);
  }
  traceList.push({
    sid,
    variableName,
    variableValue
  });
}

JSON.stringify(traceList);
`.replaceAll(/\s+/g, ' ');
  const ret: Trace[] = JSON.parse(eval(codeForTracing));
  return ret;
}

function traceToVariablesList(traceList: Trace[]): (CharacterVariable | Variable)[][] {
  const lineCount = traceList.at(-1)?.sid ?? 0;
  const variablesList: (CharacterVariable | Variable)[][] = [];
  let index = 0;
  for (let i = 0; i < lineCount; i++) {
    const variables = variablesList.at(-1) ?? ([] as (CharacterVariable | Variable)[]);
    while (traceList[index].sid <= i) {
      const { variableName, variableValue } = traceList[index];
      const variablesIndex = variables.findIndex((variable) => variable.name === variableName);
      if (variablesIndex === -1) {
        if (variableValue instanceof CharacterClass) {
          console.log('character');
          variables.push({ name: variableName, value: variableValue } as CharacterVariable);
        } else {
          variables.push({ name: variableName, value: variableValue } as Variable);
        }
      } else {
        variables[variablesIndex].value = variableValue;
      }
      index++;
    }
    variablesList.push([...variables]);
  }
  return variablesList;
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
  const board = new BoardClass();
  const histories: History[] = [{ step: 0, characterVariables: [], board, otherVariables: [] }];

  const traceList = traceCode(instrumentCode(program));
  const variablesList = traceToVariablesList(traceList);

  for (const variables of variablesList) {
    console.log('variables', variables);
    const characterVariables = selectCharacterVariables(variables);
    const otherVariables = selectOtherVariables(variables);
    console.log('characterVariables', characterVariables);
    console.log('otherVariables', otherVariables);

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

  console.log(histories);

  const result: SolveProblemResult = {
    characterVariables: histories?.at(-1)?.characterVariables,
    otherVariables: histories?.at(-1)?.otherVariables,
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
