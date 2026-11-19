export function sourceColumns(source: string): Uint32Array {
  const columns = new Uint32Array(source.length + 1);
  let column = 0;
  for (let index = 0; index < source.length;) {
    const point = source.codePointAt(index)!;
    const width = point > 0xff_ff ? 2 : 1;
    columns[index] = column;
    if (width === 2) columns[index + 1] = column;
    column = point === 10 ? 0 : point === 9 ? column + 8 - (column % 8) : column + 1;
    index += width;
    columns[index] = column;
  }
  return columns;
}
