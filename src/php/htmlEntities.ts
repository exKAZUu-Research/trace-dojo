// oxlint-disable unicorn/prefer-code-point -- PHP strings hold bytes as code units 0–255, which charCodeAt reads as they are.
import { codePointBytes } from './bytes';

/** The named entities of HTML 4.01, which `htmlentities` writes and `html_entity_decode` reads, by code point. */
export const HTML401_ENTITIES: readonly (readonly [number, string])[] = [
  [34, 'quot'],
  [38, 'amp'],
  [60, 'lt'],
  [62, 'gt'],
  [160, 'nbsp'],
  [161, 'iexcl'],
  [162, 'cent'],
  [163, 'pound'],
  [164, 'curren'],
  [165, 'yen'],
  [166, 'brvbar'],
  [167, 'sect'],
  [168, 'uml'],
  [169, 'copy'],
  [170, 'ordf'],
  [171, 'laquo'],
  [172, 'not'],
  [173, 'shy'],
  [174, 'reg'],
  [175, 'macr'],
  [176, 'deg'],
  [177, 'plusmn'],
  [178, 'sup2'],
  [179, 'sup3'],
  [180, 'acute'],
  [181, 'micro'],
  [182, 'para'],
  [183, 'middot'],
  [184, 'cedil'],
  [185, 'sup1'],
  [186, 'ordm'],
  [187, 'raquo'],
  [188, 'frac14'],
  [189, 'frac12'],
  [190, 'frac34'],
  [191, 'iquest'],
  [192, 'Agrave'],
  [193, 'Aacute'],
  [194, 'Acirc'],
  [195, 'Atilde'],
  [196, 'Auml'],
  [197, 'Aring'],
  [198, 'AElig'],
  [199, 'Ccedil'],
  [200, 'Egrave'],
  [201, 'Eacute'],
  [202, 'Ecirc'],
  [203, 'Euml'],
  [204, 'Igrave'],
  [205, 'Iacute'],
  [206, 'Icirc'],
  [207, 'Iuml'],
  [208, 'ETH'],
  [209, 'Ntilde'],
  [210, 'Ograve'],
  [211, 'Oacute'],
  [212, 'Ocirc'],
  [213, 'Otilde'],
  [214, 'Ouml'],
  [215, 'times'],
  [216, 'Oslash'],
  [217, 'Ugrave'],
  [218, 'Uacute'],
  [219, 'Ucirc'],
  [220, 'Uuml'],
  [221, 'Yacute'],
  [222, 'THORN'],
  [223, 'szlig'],
  [224, 'agrave'],
  [225, 'aacute'],
  [226, 'acirc'],
  [227, 'atilde'],
  [228, 'auml'],
  [229, 'aring'],
  [230, 'aelig'],
  [231, 'ccedil'],
  [232, 'egrave'],
  [233, 'eacute'],
  [234, 'ecirc'],
  [235, 'euml'],
  [236, 'igrave'],
  [237, 'iacute'],
  [238, 'icirc'],
  [239, 'iuml'],
  [240, 'eth'],
  [241, 'ntilde'],
  [242, 'ograve'],
  [243, 'oacute'],
  [244, 'ocirc'],
  [245, 'otilde'],
  [246, 'ouml'],
  [247, 'divide'],
  [248, 'oslash'],
  [249, 'ugrave'],
  [250, 'uacute'],
  [251, 'ucirc'],
  [252, 'uuml'],
  [253, 'yacute'],
  [254, 'thorn'],
  [255, 'yuml'],
  [338, 'OElig'],
  [339, 'oelig'],
  [352, 'Scaron'],
  [353, 'scaron'],
  [376, 'Yuml'],
  [402, 'fnof'],
  [710, 'circ'],
  [732, 'tilde'],
  [913, 'Alpha'],
  [914, 'Beta'],
  [915, 'Gamma'],
  [916, 'Delta'],
  [917, 'Epsilon'],
  [918, 'Zeta'],
  [919, 'Eta'],
  [920, 'Theta'],
  [921, 'Iota'],
  [922, 'Kappa'],
  [923, 'Lambda'],
  [924, 'Mu'],
  [925, 'Nu'],
  [926, 'Xi'],
  [927, 'Omicron'],
  [928, 'Pi'],
  [929, 'Rho'],
  [931, 'Sigma'],
  [932, 'Tau'],
  [933, 'Upsilon'],
  [934, 'Phi'],
  [935, 'Chi'],
  [936, 'Psi'],
  [937, 'Omega'],
  [945, 'alpha'],
  [946, 'beta'],
  [947, 'gamma'],
  [948, 'delta'],
  [949, 'epsilon'],
  [950, 'zeta'],
  [951, 'eta'],
  [952, 'theta'],
  [953, 'iota'],
  [954, 'kappa'],
  [955, 'lambda'],
  [956, 'mu'],
  [957, 'nu'],
  [958, 'xi'],
  [959, 'omicron'],
  [960, 'pi'],
  [961, 'rho'],
  [962, 'sigmaf'],
  [963, 'sigma'],
  [964, 'tau'],
  [965, 'upsilon'],
  [966, 'phi'],
  [967, 'chi'],
  [968, 'psi'],
  [969, 'omega'],
  [977, 'thetasym'],
  [978, 'upsih'],
  [982, 'piv'],
  [8194, 'ensp'],
  [8195, 'emsp'],
  [8201, 'thinsp'],
  [8204, 'zwnj'],
  [8205, 'zwj'],
  [8206, 'lrm'],
  [8207, 'rlm'],
  [8211, 'ndash'],
  [8212, 'mdash'],
  [8216, 'lsquo'],
  [8217, 'rsquo'],
  [8218, 'sbquo'],
  [8220, 'ldquo'],
  [8221, 'rdquo'],
  [8222, 'bdquo'],
  [8224, 'dagger'],
  [8225, 'Dagger'],
  [8226, 'bull'],
  [8230, 'hellip'],
  [8240, 'permil'],
  [8242, 'prime'],
  [8243, 'Prime'],
  [8249, 'lsaquo'],
  [8250, 'rsaquo'],
  [8254, 'oline'],
  [8260, 'frasl'],
  [8364, 'euro'],
  [8465, 'image'],
  [8472, 'weierp'],
  [8476, 'real'],
  [8482, 'trade'],
  [8501, 'alefsym'],
  [8592, 'larr'],
  [8593, 'uarr'],
  [8594, 'rarr'],
  [8595, 'darr'],
  [8596, 'harr'],
  [8629, 'crarr'],
  [8656, 'lArr'],
  [8657, 'uArr'],
  [8658, 'rArr'],
  [8659, 'dArr'],
  [8660, 'hArr'],
  [8704, 'forall'],
  [8706, 'part'],
  [8707, 'exist'],
  [8709, 'empty'],
  [8711, 'nabla'],
  [8712, 'isin'],
  [8713, 'notin'],
  [8715, 'ni'],
  [8719, 'prod'],
  [8721, 'sum'],
  [8722, 'minus'],
  [8727, 'lowast'],
  [8730, 'radic'],
  [8733, 'prop'],
  [8734, 'infin'],
  [8736, 'ang'],
  [8743, 'and'],
  [8744, 'or'],
  [8745, 'cap'],
  [8746, 'cup'],
  [8747, 'int'],
  [8756, 'there4'],
  [8764, 'sim'],
  [8773, 'cong'],
  [8776, 'asymp'],
  [8800, 'ne'],
  [8801, 'equiv'],
  [8804, 'le'],
  [8805, 'ge'],
  [8834, 'sub'],
  [8835, 'sup'],
  [8836, 'nsub'],
  [8838, 'sube'],
  [8839, 'supe'],
  [8853, 'oplus'],
  [8855, 'otimes'],
  [8869, 'perp'],
  [8901, 'sdot'],
  [8968, 'lceil'],
  [8969, 'rceil'],
  [8970, 'lfloor'],
  [8971, 'rfloor'],
  [9001, 'lang'],
  [9002, 'rang'],
  [9674, 'loz'],
  [9824, 'spades'],
  [9827, 'clubs'],
  [9829, 'hearts'],
  [9830, 'diams'],
];

const QUOTE_SINGLE = 1n;
const QUOTE_DOUBLE = 2n;
const IGNORE = 4n;
const SUBSTITUTE = 8n;
const DISALLOWED = 128n;
enum Doctype {
  Html401 = 0,
  Xml1 = 16,
  Xhtml = 32,
  Html5 = 48,
}
const REPLACEMENT = codePointBytes(0xff_fd);
const ENTITY_BY_CODE = new Map(HTML401_ENTITIES.map(([code, name]) => [code, name]));
const CODE_BY_ENTITY = new Map(HTML401_ENTITIES.map(([code, name]) => [name, code]));
const NAME = /([\dA-Za-z]+);/y;
const DIGITS = /\d+/y;
const HEX_DIGITS = /[\dA-Fa-f]+/y;
const BASIC_ENTITIES = new Map([
  [38, 'amp'],
  [60, 'lt'],
  [62, 'gt'],
  [34, 'quot'],
]);
const BASIC_CODES = new Map([...BASIC_ENTITIES].map(([code, name]) => [name, code]));

/**
 * Escapes UTF-8 text as `htmlspecialchars` (`all` false) or `htmlentities` (`all` true) does. HTML5 uses the
 * HTML 4.01 entities plus `&apos;`.
 */
// code-gauge-allow functionCognitiveComplexity 23 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
export function escapeHtml(text: string, flags: bigint, all: boolean, doubleEncode: boolean): string {
  const doctype = doctypeOf(flags);
  let result = '';
  for (let index = 0; index < text.length;) {
    const [length, code] = nextChar(text, index);
    const char = text.slice(index, index + length);
    index += length;
    if (code === undefined) {
      if (flags & IGNORE) continue;
      if (!(flags & SUBSTITUTE)) return '';
      result += REPLACEMENT;
    } else if (code === 0x26) {
      const entityLength = doubleEncode ? 0 : validEntityLength(text, index, flags);
      result += entityLength > 0 ? text.slice(index - 1, index + entityLength) : '&amp;';
      index += entityLength;
    } else {
      const name = entityFor(code, flags, all);
      if (name) result += `&${name};`;
      else if (flags & DISALLOWED && !isAllowed(code, doctype)) result += REPLACEMENT;
      else result += char;
    }
  }
  return result;
}

/** Decodes the entities of UTF-8 text as `html_entity_decode` (`all` true) or `htmlspecialchars_decode` does. */
export function decodeHtml(text: string, flags: bigint, all: boolean): string {
  const doctype = doctypeOf(flags);
  let result = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '&' || index + 3 >= text.length) {
      result += text[index];
      continue;
    }
    const entity =
      text[index + 1] === '#' ? numericEntity(text, index + 2) : namedEntity(text, index + 1, doctype, all);
    if (
      entity === undefined ||
      (text[index + 1] === '#' && !numericDecodable(entity.code, doctype, all)) ||
      !quoteAllowed(entity.code, flags)
    ) {
      result += '&';
      continue;
    }
    result += codePointBytes(entity.code);
    index = entity.end;
  }
  return result;
}

function doctypeOf(flags: bigint): Doctype {
  return Number(flags & 48n) as Doctype;
}

/** The length and code point of the UTF-8 character at `index`, without a code point when invalid, as PHP's get_next_char reads them. */
// code-gauge-allow functionCognitiveComplexity 17 -- Transcribes PHP's algorithm for this function step by step, whose branches mirror PHP's.
function nextChar(text: string, index: number): [number, number | undefined] {
  const lead = text.charCodeAt(index);
  if (lead < 0x80) return [1, lead];
  if (lead < 0xc2 || lead > 0xf4) return [1, undefined];
  const size = lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  const available = text.length - index;
  let code = lead & (0xff >> (size + 1));
  for (let offset = 1; offset < size; offset++) {
    const byte = text.charCodeAt(index + offset);
    if (offset >= available || byte < 0x80 || byte > 0xbf) return [invalidLength(text, index, size), undefined];
    code = (code << 6) | (byte & 0x3f);
  }
  if (size === 3 && (code < 0x8_00 || (code >= 0xd8_00 && code <= 0xdf_ff))) return [3, undefined];
  if (size === 4 && (code < 0x1_00_00 || code > 0x10_ff_ff)) return [4, undefined];
  return [size, code];
}

/** How many bytes PHP skips for a truncated or broken sequence: up to the first byte that could start a character. */
function invalidLength(text: string, index: number, size: number): number {
  for (let offset = 1; offset < size; offset++) {
    const byte = text.charCodeAt(index + offset);
    if (index + offset >= text.length || byte < 0x80 || (byte >= 0xc2 && byte <= 0xf4)) return offset;
  }
  return size;
}

/** The length after `&` of the valid entity at `index` that `double_encode` false keeps, or 0. */
function validEntityLength(text: string, index: number, flags: bigint): number {
  const doctype = doctypeOf(flags);
  if (text[index] === '#') {
    const entity = numericEntity(text, index + 1);
    if (!entity || (flags & DISALLOWED && !numericAllowed(entity.code, doctype))) return 0;
    return entity.end + 1 - index;
  }
  const entity = namedEntity(text, index, doctype, true);
  return entity ? entity.end + 1 - index : 0;
}

/** The code point and the index of `;` of the numeric entity whose digits start at `index`. */
function numericEntity(text: string, index: number): { code: number; end: number } | undefined {
  const hex = text[index] === 'x' || text[index] === 'X';
  const pattern = hex ? HEX_DIGITS : DIGITS;
  pattern.lastIndex = hex ? index + 1 : index;
  const digits = pattern.exec(text)?.[0];
  if (!digits) return undefined;
  const end = index + (hex ? 1 : 0) + digits.length;
  const code = Number.parseInt(digits, hex ? 16 : 10);
  if (text[end] !== ';' || code > 0x10_ff_ff) return undefined;
  return { code, end };
}

/** The code point and the index of `;` of the named entity whose name starts at `index`, if the doctype knows it. */
function namedEntity(
  text: string,
  index: number,
  doctype: Doctype,
  all: boolean
): { code: number; end: number } | undefined {
  NAME.lastIndex = index;
  const name = NAME.exec(text)?.[1];
  if (!name) return undefined;
  let code = (all && doctype !== Doctype.Xml1 ? CODE_BY_ENTITY : BASIC_CODES).get(name);
  if (name === 'apos' && doctype !== Doctype.Html401) code = 0x27;
  return code === undefined ? undefined : { code, end: index + name.length };
}

function numericDecodable(code: number, doctype: Doctype, all: boolean): boolean {
  if (!all && ![0x22, 0x26, 0x27, 0x3c, 0x3e].includes(code)) return false;
  return isAllowed(code, doctype) && !(doctype === Doctype.Html5 && code === 0x0d);
}

function quoteAllowed(code: number, flags: bigint): boolean {
  if (code === 0x27) return (flags & QUOTE_SINGLE) !== 0n;
  if (code === 0x22) return (flags & QUOTE_DOUBLE) !== 0n;
  return true;
}

function entityFor(code: number, flags: bigint, all: boolean): string | undefined {
  if (!quoteAllowed(code, flags)) return undefined;
  const doctype = doctypeOf(flags);
  if (code === 0x27) return doctype === Doctype.Html401 || (all && doctype === Doctype.Xhtml) ? '#039' : 'apos';
  return (all && doctype !== Doctype.Xml1 ? ENTITY_BY_CODE : BASIC_ENTITIES).get(code);
}

/** Whether a document type allows a code point as a character, as PHP's unicode_cp_is_allowed says. */
function isAllowed(code: number, doctype: Doctype): boolean {
  if (doctype === Doctype.Xml1 || doctype === Doctype.Xhtml) {
    return (
      (code >= 0x20 && code <= 0xd7_ff) ||
      code === 0x0a ||
      code === 0x09 ||
      code === 0x0d ||
      (code >= 0xe0_00 && code <= 0x10_ff_ff && code !== 0xff_fe && code !== 0xff_ff)
    );
  }
  const control =
    doctype === Doctype.Html5 ? code >= 0x09 && code <= 0x0d && code !== 0x0b : [0x09, 0x0a, 0x0d].includes(code);
  return (code >= 0x20 && code <= 0x7e) || control || (code >= 0xa0 && code <= 0xd7_ff) || isAllowedHigh(code);
}

function isAllowedHigh(code: number): boolean {
  return code >= 0xe0_00 && code <= 0x10_ff_ff && (code & 0xff_ff) < 0xff_fe && (code < 0xfd_d0 || code > 0xfd_ef);
}

/** Whether `double_encode` false with ENT_DISALLOWED keeps a numeric entity, as PHP's numeric_entity_is_allowed says. */
function numericAllowed(code: number, doctype: Doctype): boolean {
  if (doctype === Doctype.Html401) return true;
  if (doctype === Doctype.Html5) {
    return (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x09 && code <= 0x0c && code !== 0x0b) ||
      (code >= 0xa0 && (code & 0xff_ff) < 0xff_fe && (code < 0xfd_d0 || code > 0xfd_ef))
    );
  }
  return isAllowed(code, doctype);
}
