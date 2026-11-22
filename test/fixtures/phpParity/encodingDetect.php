<?php
$tests = ["", "abc", "日本語", "\xe9t\xe9", "\xff", "é\xff", str_repeat("a", 30000) . "é", str_repeat("a", 3000) . "é", "\xef\xbb\xbfabc", "a!b/c", "\x00A\x00B", "Ā", "\u{1F600}", "a\x80", str_repeat("!", 100) . "é", str_repeat("ab", 2000) . "\xe9"];
foreach ($tests as $t) {
  echo bin2hex(substr($t, 0, 8)), " ", json_encode([mb_detect_encoding($t), mb_detect_encoding($t, null, true), mb_detect_encoding($t, "UTF-8"), mb_detect_encoding($t, "UTF-8", true), mb_detect_encoding($t, "ASCII"), mb_detect_encoding($t, "ASCII", true), mb_detect_encoding($t, ["UTF-8", "ISO-8859-1"]), mb_detect_encoding($t, ["ISO-8859-1", "UTF-8"]), mb_detect_encoding($t, "UTF-8, ISO-8859-1", true), mb_detect_encoding($t, "ASCII,UTF-8,ISO-8859-1"), mb_detect_encoding($t, "UTF-16LE, UTF-16BE, UTF-8"), mb_detect_encoding($t, "auto"), mb_detect_encoding($t, "auto, ISO-8859-1", true), mb_detect_encoding($t, "UTF-32, UTF-8")]), "\n";
}
var_dump(mb_detect_encoding("x", "BASE64"), mb_detect_encoding("x", "BASE64, UTF-8"), mb_detect_encoding("x", ","), mb_detect_encoding("x", "8bit, ascii"));
foreach (["", [], "nope", ["UTF-8", "x"]] as $l) { try { var_dump(mb_detect_encoding("x", $l)); } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }
