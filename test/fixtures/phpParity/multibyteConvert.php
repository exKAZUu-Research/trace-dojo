<?php
$s = "Héllo 日本 😀";
foreach (['UTF-8', 'ASCII', 'ISO-8859-1', 'latin1', 'UTF-16', 'UTF-16BE', 'UTF-16LE', 'UTF-32', 'UTF-32LE', 'utf32', 'US-ASCII'] as $to) {
  $c = mb_convert_encoding($s, $to);
  echo $to, " ", bin2hex($c), " ", bin2hex(mb_convert_encoding($c, 'UTF-8', $to)), "\n";
}
echo bin2hex(mb_convert_encoding("\xe9t\xe9", "UTF-8", "ISO-8859-1")), "\n";
echo bin2hex(mb_convert_encoding("\xff\xfeA\x00B\x00", "UTF-8", "UTF-16")), " ", bin2hex(mb_convert_encoding("\xfe\xff\x00A", "UTF-8", "UTF-16")), " ", bin2hex(mb_convert_encoding("\x00A\x00", "UTF-8", "UTF-16")), " ", bin2hex(mb_convert_encoding("\xd8\x00\x00A\xdc\x00\xd8\x3d\xde\x00", "UTF-8", "UTF-16BE")), " ", bin2hex(mb_convert_encoding("\xd8\x00\xd8\x00\xdc\x00", "UTF-8", "UTF-16BE")), " ", bin2hex(mb_convert_encoding("\xd8\x00", "UTF-8", "UTF-16BE")), "\n";
echo bin2hex(mb_convert_encoding("\xff\xfe\x00\x00A\x00\x00\x00", "UTF-8", "UTF-32")), " ", bin2hex(mb_convert_encoding("\x00\x11\x00\x00\x00\x00\xd8\x00ab", "UTF-8", "UTF-32")), "\n";
echo bin2hex(mb_convert_encoding("a\x80b\xe3\x81c\xf0\x9f\x98", "UTF-16")), "\n";
var_dump(mb_substitute_character(), mb_substitute_character("none"), mb_convert_encoding("a\x80b日", "ASCII"), mb_substitute_character(), mb_substitute_character("long"), mb_convert_encoding("a\x80b日😀", "ASCII"), mb_substitute_character("entity"), mb_convert_encoding("a\x80b日", "ISO-8859-1"), mb_substitute_character(0x3013), mb_convert_encoding("a\x80b日", "ASCII"), bin2hex(mb_convert_encoding("a\x80b", "UTF-8")), mb_substitute_character(), mb_substitute_character("LONG"), mb_substitute_character());
try { mb_substitute_character("x"); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { mb_substitute_character(0xD800); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { mb_substitute_character(-1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
mb_substitute_character(63);
var_dump(mb_convert_encoding(["a" => "日", "日" => ["x\x80"], 5 => 1.5, 6 => null, 7 => true], "ASCII"));
var_dump(mb_convert_encoding("日本", "UTF-8", "ASCII, UTF-8"), mb_convert_encoding("abc", "UTF-8", "auto"), mb_convert_encoding("\xe9", "UTF-8", ["UTF-8", "ISO-8859-1"]), bin2hex(mb_convert_encoding("\xe9", "UTF-8", "UTF-8, ISO-8859-1")));
foreach ([["a", "nope"], ["a", "UTF-8", "nope"], ["a", "UTF-8", ""], ["a", "UTF-8", "UTF-8,"], ["a", "UTF-8", []], ["a", "UTF-8", ["x"]], ["a", "UTF-8", " utf-8 , ascii "]] as $c) { try { var_dump(mb_convert_encoding(...$c)); } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }
var_dump(bin2hex(mb_scrub("a\x80b\xe3\x81c")), mb_scrub("ok"), bin2hex(mb_scrub("a\x80", "ASCII")), mb_scrub("é", "ISO-8859-1"));
var_dump(mb_check_encoding("abc"), mb_check_encoding("\x80"), mb_check_encoding("日本", "ASCII"), mb_check_encoding("\xe9", "ISO-8859-1"), mb_check_encoding("\xd8\x00", "UTF-16"), mb_check_encoding(["a" => ["b", 1, 2.5, null, true]]), mb_check_encoding(["\x80" => 1]), mb_check_encoding([new stdClass]), mb_check_encoding("\xed\xa0\x80"), mb_check_encoding("\xf4\x90\x80\x80"), mb_check_encoding("\xc0\xaf"));
try { mb_check_encoding("a", "nope"); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(mb_check_encoding());
