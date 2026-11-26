import { eastAsianWidth } from 'get-east-asian-width';

/** The width Bash lays a `select` menu out in, as it does without `COLUMNS` in a script. */
const MENU_COLUMNS = 80;
const TAB_SIZE = 8;
/** The `) ` between a menu number and its word. */
const NUMBER_SEPARATOR = ') ';

/**
 * The menu `select` prints to standard error: the words numbered from 1 in columns that fill the width down then
 * across, as Bash's `print_select_list` lays them out with tabs and spaces.
 */
export function formatSelectMenu(words: readonly string[]): string {
  if (words.length === 0) return '\n';
  const indicesLength = String(words.length).length;
  const maxElementLength = Math.max(...words.map(displayWidth)) + indicesLength + NUMBER_SEPARATOR.length + 2;
  let cols = Math.max(1, Math.floor(MENU_COLUMNS / maxElementLength));
  let rows = Math.ceil(words.length / cols);
  cols = Math.ceil(words.length / rows);
  if (rows === 1) {
    rows = cols;
    cols = 1;
  }
  const firstColumnIndicesLength = String(rows).length;
  let menu = '';
  for (let row = 0; row < rows; row++) {
    let position = 0;
    for (let index = row; ; index += rows) {
      const width = position === 0 ? firstColumnIndicesLength : indicesLength;
      menu += `${String(index + 1).padStart(width)}${NUMBER_SEPARATOR}${words[index]}`;
      const elementLength = displayWidth(words[index]) + width + NUMBER_SEPARATOR.length;
      if (index + rows >= words.length) break;
      menu += indent(position + elementLength, position + maxElementLength);
      position += maxElementLength;
    }
    menu += '\n';
  }
  return menu;
}

/** The tabs and spaces that move from one column to another, as Bash's `indent` writes them. */
function indent(from: number, to: number): string {
  let text = '';
  for (let column = from; column < to;) {
    if (Math.floor(to / TAB_SIZE) > Math.floor(column / TAB_SIZE)) {
      text += '\t';
      column += TAB_SIZE - (column % TAB_SIZE);
    } else {
      text += ' ';
      column++;
    }
  }
  return text;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += eastAsianWidth(character.codePointAt(0) as number) === 2 ? 2 : 1;
  return width;
}
