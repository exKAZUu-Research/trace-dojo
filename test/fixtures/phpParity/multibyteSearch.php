<?php
$h = "日本語のテキストです。日本語";
var_dump(mb_strripos("ABCabcABC", "abc"), mb_strripos("ÄÖÜäöü", "Ä"), mb_strripos("abc", "x"), mb_strripos("aXbxc", "X", -2), mb_strripos("İi", "i"));
try { mb_strripos("abc", "a", 10); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(mb_strstr($h, "テキスト"), mb_strstr($h, "テキスト", true), mb_strrchr($h, "日本"), mb_strrchr($h, "日本", true), mb_stristr("HeLLo WORLD", "world"), mb_stristr("HeLLo WORLD", "llo", true), mb_strrichr("ÄbcäBC", "ä"), mb_strrichr("ÄbcäBC", "Ä", true), mb_strstr("abc", "x"));
var_dump(mb_strstr("abc", ""), mb_strrchr("abc", ""), mb_stristr("abc", ""), mb_strrichr("abc", ""), mb_strstr("", ""), mb_strstr("", "a"));
var_dump(bin2hex(mb_strstr("a\x80b\xe3\x81c", "b")), bin2hex(mb_strstr("a\x80b\xe3\x81c", "c", true)));
try { mb_strstr("a", "b", false, "nope"); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
foreach ([["Hello World", 0, 10, "..."], ["日本語のテキストです", 0, 10, "…"], ["日本語のテキストです", 0, 10], ["日本語のテキストです", 2, 8, ".."], ["abc", 0, 2, "..."], ["abcdef", 0, 3, "..."], ["abcdef", -3, 5], ["abcdef", 0, 6, "..."], ["abcdef", 1, 0], ["日本", 0, 3], ["abcdef", 0, -2], ["abcdef", 2, -1, "."], ["", 0, 5, "..."], ["a\x80bc", 0, 3, "~"], ["a\x80bc", 0, 10]] as $c) {
  echo json_encode(bin2hex(mb_strimwidth(...$c))), "\n";
}
foreach ([["abc", 4, 1], ["abc", -4, 1], ["abc", 0, -10]] as $c) { try { mb_strimwidth(...$c); } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }
var_dump(mb_ltrim("  \t abc  "), mb_rtrim("  abc \n "), mb_trim("\u{3000}全角\u{3000}"), mb_ltrim("xxabcxx", "x"), mb_rtrim("xxabcxx", "x"), mb_trim("ababcab", "ab"), mb_ltrim("aaa", "a"), mb_rtrim("", "a"), mb_trim("abc", ""), mb_trim("\u{FEFF}x\u{FEFF}"), mb_trim("\x00\x0b x \u{85}"), mb_ltrim("日本日", "日"));
var_dump(bin2hex(mb_trim(" a\x80 ")), bin2hex(mb_trim("\x80a\x80", "\x80")));
var_dump(bin2hex(mb_strstr(mb_convert_encoding("日本語テキスト", "UTF-16"), mb_convert_encoding("テキ", "UTF-16"), false, "UTF-16")), mb_stristr("ABC", "b", false, "ASCII"), bin2hex(mb_ltrim("\x00 \x00a", null, "UTF-16BE")), mb_strimwidth("abcdef", 0, 4, "..", "ISO-8859-1"), mb_rtrim("ab\xa0", null, "latin1"));
