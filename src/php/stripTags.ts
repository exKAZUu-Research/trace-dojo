// oxlint-disable unicorn/no-null -- PHP null is represented by JavaScript null.
import { lower } from './bytes';
import { toStr } from './operators';
import { PhpArray, type Value } from './values';

export function allowedTags(value: Value): string {
  if (value === null) return '';
  const text =
    value instanceof PhpArray
      ? value
          .values()
          .map((item) => `<${toStr(item)}>`)
          .join('')
      : toStr(value);
  return lower(text);
}

export function stripTags(text: string, allowed: string): string {
  let result = '';
  let tag = '';
  let state: 'text' | 'tag' | 'php' | 'declaration' | 'comment' = 'text';
  let quote = '';
  let last = '';
  let depth = 0;
  let brackets = 0;
  let xml = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (state === 'text') {
      if (char === '\0') continue;
      if (char === '<' && !space(text[index + 1] ?? '')) {
        state = 'tag';
        tag = '<';
        last = '<';
      } else if (char === '>' && depth > 0) depth--;
      else result += char;
    } else if (state === 'tag') {
      if (char === '\0') continue;
      if (char === '<') {
        if (!quote) {
          if (space(text[index + 1] ?? '')) tag += char;
          else depth++;
        }
      } else if (char === '>') {
        if (depth > 0) depth--;
        else if (!quote && !(xml && text[index - 1] === '-')) {
          tag += '>';
          if (allowed.includes(normalizeTag(tag))) result += tag;
          tag = '';
          state = 'text';
          xml = false;
          last = '>';
        }
      } else if (char === '"' || char === "'") {
        if (!quote || quote === char) quote = quote ? '' : char;
        tag += char;
      } else if (char === '!' && text[index - 1] === '<') {
        state = 'declaration';
        last = char;
      } else if (char === '?' && text[index - 1] === '<') {
        state = 'php';
        brackets = 0;
      } else tag += char;
    } else if (state === 'php') {
      if (char === '(' && last !== '"' && last !== "'") {
        last = char;
        brackets++;
      } else if (char === ')' && last !== '"' && last !== "'") {
        last = char;
        brackets--;
      } else if (char === '>') {
        if (depth > 0) depth--;
        else if (!quote && !brackets && last !== '"' && text[index - 1] === '?') {
          state = 'text';
          tag = '';
          quote = '';
        }
      } else if ((char === '"' || char === "'") && text[index - 1] !== '\\') {
        if (last === char) last = '';
        else if (last !== '\\') last = char;
        if (!quote || quote === char) quote = quote ? '' : char;
      } else if ((char === 'l' || char === 'L') && lower(text.slice(index - 4, index + 1)) === '<?xml') {
        state = 'tag';
        xml = true;
      }
    } else if (state === 'declaration') {
      if (char === '>') {
        if (depth > 0) depth--;
        else if (!quote) {
          state = 'text';
          tag = '';
        }
      } else if ((char === '"' || char === "'") && text[index - 1] !== '\\') {
        if (!quote || quote === char) quote = quote ? '' : char;
      } else if (char === '-' && text.slice(index - 2, index) === '!-') state = 'comment';
      else if ((char === 'e' || char === 'E') && lower(text.slice(index - 6, index + 1)) === 'doctype') state = 'tag';
    } else if (char === '>' && !quote && text.slice(index - 2, index) === '--') {
      state = 'text';
      tag = '';
    }
  }
  return result;
}

function space(char: string): boolean {
  return char !== '' && ' \t\n\r\v\f'.includes(char);
}

function normalizeTag(tag: string): string {
  let normalized = '';
  let started = false;
  for (let index = 0; index < tag.length; index++) {
    const char = lower(tag[index]);
    if (char === '>') break;
    if (char === '<') normalized += char;
    else if (space(char)) {
      if (started) break;
    } else {
      started = true;
      if (char !== '/' || (tag[index - 1] !== '<' && tag[index + 1] !== '>')) normalized += char;
    }
  }
  return `${normalized}>`;
}
