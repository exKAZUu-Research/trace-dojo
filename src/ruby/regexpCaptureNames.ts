export function regexpCaptureNames(source: string): string[] {
  const names: string[] = [];
  let inClass = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (!inClass && source.startsWith('(?<', index)) {
      const match = /^([A-Za-z_]\w*)>/.exec(source.slice(index + 3));
      if (match) names.push(match[1]);
    }
  }
  return names;
}
