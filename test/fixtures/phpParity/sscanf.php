<?php
var_dump(sscanf("age: 25 name: Bob", "age: %d name: %s"));
var_dump(sscanf("", "%d"), sscanf("", "%d", $x), $x, sscanf("abc", "%d"), sscanf("abc", "%d", $y), $y);
var_dump(sscanf("12 apples", "%d %s %s"));
var_dump(sscanf("0x1f 017 0x 019 -0 +5 08 9", "%i %i %i %i %i %i %i"));
var_dump(sscanf("ff 0x1F -1a 0", "%x %X %x %x"));
var_dump(sscanf("-5 18446744073709551615 99999999999999999999 9223372036854775808", "%u %u %u %u"));
var_dump(sscanf("99999999999999999999 -99999999999999999999 123456", "%d %d %3d"));
var_dump(sscanf("3.14 -.5 1e3 1.5e 2e+ .x 7.", "%f %f %e %g %f %f"));
var_dump(sscanf("hello world", "%s%n %c%c%3c %n"));
var_dump(sscanf("abc123def", "%[a-z]%[0-9]%[^0-9]"), sscanf("a-b]c", "%[]a-]%c"), sscanf("xyz", "%[a-]"), sscanf("zzz", "%[^z]"));
var_dump(sscanf("12:34:56", "%2d:%2d:%2d"), sscanf("2024-01-15", "%4d-%2d-%2d"));
var_dump(sscanf("a b c", "%3\$s %1\$s %2\$s"), sscanf("a b", "%*s %s"), sscanf("10%", "%d%%"), sscanf("10x", "%d%%"));
var_dump(sscanf("12 34", "%d %d", $a, $b), $a, $b);
var_dump(sscanf("12", "%d %d", $c, $d), $c, $d);
var_dump(sscanf("  42", "%ld"), sscanf("42", "%hd"), sscanf("4.5", "%lf"), sscanf("x", "%c"), sscanf("  x", "%c"), sscanf("ab", "%5c"));
foreach (["%z", "%", "%[", "%[^", "%[]", "%1\$d %d", "%d %1\$d", "%0\$d", "%300\$d", "%1\$d %1\$d"] as $f) { try { var_dump(sscanf("1 2", $f)); } catch (ValueError $e) { echo bin2hex($e->getMessage()), " ", $e->getMessage(), "\n"; } }
try { sscanf("1 2", "%d %d", $p); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { sscanf("1 2", "%d", $p, $q); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { sscanf("1 2", "%2\$d", $p); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
var_dump(sscanf("1 2", "%2\$d %1\$d", $p, $q), $p, $q);
var_dump(sscanf("5", "%3\$d"));
var_dump(sscanf("a\0b", "%s"), sscanf("ab", "a\0x"), sscanf("abc", "a%sz"), sscanf("abc", "abd%s"), sscanf("abc", "abcd"));
var_dump(array_map('bin2hex', sscanf("\x80A\xff", "%[a-\xff]%s")), array_map('bin2hex', sscanf("\x90\x85z", "%[\x80-\xa0]%s")), sscanf("abc", "%[c-a]"), sscanf("a]b", "%[^]]"), sscanf("x-y", "%[-x]"));
