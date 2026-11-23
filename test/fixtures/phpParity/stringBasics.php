<?php
echo str_rot13("Hello, World! xyz ABC 123"), "\n";
var_dump(substr_compare("Hello", "ello", 1), substr_compare("Hello", "ELLO", 1, null, true), substr_compare("abcde", "bc", 1, 2), substr_compare("abcde", "de", -2), substr_compare("abcde", "bd", 1, 3), substr_compare("abcde", "cd", 1, 2), substr_compare("abcde", "BC", 1, 3, true), substr_compare("a", "abc", 0), substr_compare("abc", "a", 0), substr_compare("abc", "b", 1, 0), substr_compare("abc", "", 3), substr_compare("abc", "x", -10));
try { substr_compare("abc", "b", 1, -1); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { substr_compare("abc", "b", 4); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(strpbrk("This is a test", "st"), strpbrk("This is a test", "xyz"), strpbrk("abc", "c"));
try { strpbrk("abc", ""); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(bin2hex(addcslashes("foo[bar]\n\t\x01\xff zoo", 'A..Z')), addcslashes("foo[bar]\n\t\x01\xff\x7f zoo", "\0..\37!@\177..\377"), addcslashes("abc", ""), addcslashes("", "a"), addcslashes("zoo['.']", 'z..A'), addcslashes("a\\b\"c", "\\\"abc"), addcslashes("\x07\x08\x0b\x0c\r", "\0..\37"));
var_dump(bin2hex(stripcslashes('a\nb\tc\x41\x4g\101\7777\\\\\q\0\a\b\f\v\r\x')), stripcslashes('\\'), stripcslashes('abc\\'), stripcslashes('\x'), stripcslashes('\xZ1'), stripcslashes('\08'));
var_dump(quotemeta("1+1=2? [a] (b) ^\$ . * \\ x"), quotemeta(""));
var_dump(strcoll("a", "b"), strcoll("b", "a"), strcoll("", ""), strcoll("abc", "ab"), strcoll("A", "a"), strcoll("\xff", "a"), strcoll("ab", "abc"));
echo utf8_encode("caf\xe9"), "\n";
var_dump(bin2hex(utf8_decode("café ñ €")), utf8_decode("\xff\xc3"), bin2hex(utf8_decode("\xc2\x80\xc3\xbf\xe0\x80a\xf0\x9f\x98\x80")));
