// oxlint-disable unicorn/no-null -- PHP null is represented by JavaScript null.
import { lower, untilNul } from './bytes';
import { literalMatches, spendScan } from './byteSearch';
import { toStr } from './operators';
import { rt } from './runtime';
import { PhpArray, type Value } from './values';

export function allowedTags(value: Value): string {
  if (value === null) return '';
  const text = value instanceof PhpArray ? wrapAllowedTags(value) : toStr(value);
  return lower(untilNul(text));
}

function wrapAllowedTags(values: PhpArray): string {
  const runtime = rt();
  const tags: string[] = [];
  let bytes = 0;
  for (const item of values.values()) {
    const tag = toStr(item);
    bytes += tag.length + 2;
    runtime.ensureStringFits(bytes);
    runtime.spend(Math.ceil((tag.length + 2) / 64));
    tags.push(`<${tag}>`);
  }
  return tags.join('');
}

export function stripTags(text: string, allowed: string): string {
  const allows = indexAllowedTags(allowed);
  let result = '';
  let tag = '';
  let state: 'text' | 'tag' | 'php' | 'declaration' | 'comment' = 'text';
  let quote = '';
  let last = '';
  let depth = 0;
  let brackets = 0;
  let xml = false;
  for (let index = 0; index < text.length; index++) {
    spendScan(index);
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
          if (allows(normalizeTag(tag))) result += tag;
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

function indexAllowedTags(allowed: string): (tag: string) => boolean {
  const tags = new Set<string>();
  let open = -1;
  for (let index = 0; index < allowed.length; index++) {
    spendScan(index);
    if (allowed[index] === '<') open = index;
    else if (allowed[index] === '>' && open !== -1) {
      tags.add(allowed.slice(open, index + 1));
      open = -1;
    }
  }
  const nested = new Map<string, boolean>();
  return (tag) => {
    if (!tag.includes('<', 1)) return tags.has(tag);
    const cached = nested.get(tag);
    if (cached !== undefined) return cached;
    const found = literalMatches(allowed, tag).next().done === false;
    nested.set(tag, found);
    return found;
  };
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
