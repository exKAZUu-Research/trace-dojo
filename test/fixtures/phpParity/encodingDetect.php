<?php
$tests = ["", "abc", "日本語", "\xe9t\xe9", "\xff", "é\xff", str_repeat("a", 30000) . "é", str_repeat("a", 3000) . "é", "\xef\xbb\xbfabc", "a!b/c", "\x00A\x00B", "Ā", "\u{1F600}", "a\x80", str_repeat("!", 100) . "é", str_repeat("ab", 2000) . "\xe9"];
foreach ($tests as $t) {
  echo bin2hex(substr($t, 0, 8)), " ", json_encode([mb_detect_encoding($t), mb_detect_encoding($t, null, true), mb_detect_encoding($t, "UTF-8"), mb_detect_encoding($t, "UTF-8", true), mb_detect_encoding($t, "ASCII"), mb_detect_encoding($t, "ASCII", true), mb_detect_encoding($t, ["UTF-8", "ISO-8859-1"]), mb_detect_encoding($t, ["ISO-8859-1", "UTF-8"]), mb_detect_encoding($t, "UTF-8, ISO-8859-1", true), mb_detect_encoding($t, "ASCII,UTF-8,ISO-8859-1"), mb_detect_encoding($t, "UTF-16LE, UTF-16BE, UTF-8"), mb_detect_encoding($t, "auto"), mb_detect_encoding($t, "auto, ISO-8859-1", true), mb_detect_encoding($t, "UTF-32, UTF-8")]), "\n";
}
var_dump(mb_detect_encoding("x", "BASE64"), mb_detect_encoding("x", "BASE64, UTF-8"), mb_detect_encoding("x", ","), mb_detect_encoding("x", "8bit, ascii"));
foreach (["", [], "nope", ["UTF-8", "x"]] as $l) { try { var_dump(mb_detect_encoding("x", $l)); } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }

foreach ([
  ["\xA4\xA2", 'ISO-2022-JP-MS'],
  ["\x1b\x24(?\x21\x21", 'ISO-2022-JP-MS'],
  ["\xC3\xB1", 'CP50220'],
  ["\x0e\x24!\x0f", 'CP50221'],
  ["\xC5", 'CP50222'],
  ["\x1b\x24(Q\x24\x77", 'ISO-2022-JP-2004'],
  ["\x1b\x24(P\x21\x21", 'ISO-2022-JP-2004'],
  ["\x82\xA0", 'EUC-KR'],
  ["\xB0\xA1", 'EUC-KR'],
  ["\x81\x60", 'CP950'],
  ["\x81\x7f", 'CP950'],
] as [$bytes, $encoding]) {
  echo bin2hex($bytes), " ", json_encode([
    mb_detect_encoding($bytes, $encoding, true),
    mb_detect_encoding($bytes, [$encoding, 'UTF-8', 'ISO-8859-1'], true),
    mb_detect_encoding($bytes, ['EUC-KR', 'CP950', $encoding]),
  ]), "\n";
}

foreach ([
  ["\x80", 'Shift_JIS-2004'],
  ["\xEF\xBF\xBD", 'SJIS-2004'],
  ["\xF0\x40", 'SJIS2004'],
  ["\x8e\xa1\xa1\xa1", 'BIG5'],
  ["\xc8\x40a", 'BIG-5'],
  ["\xa1\x45", 'BIG5'],
] as [$bytes, $encoding]) {
  echo bin2hex($bytes), " ", json_encode([
    mb_detect_encoding($bytes, $encoding, true),
    mb_detect_encoding($bytes, [$encoding, 'CP950', 'UTF-8'], true),
  ]), "\n";
}
