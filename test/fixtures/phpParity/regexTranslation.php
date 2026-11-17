<?php
// 67
var_dump(preg_replace("/(a)/", "\\$1|\\\\$1|\\\\\\$1", "a"));
// 68
var_dump(preg_match('/^\w$/u', "é"), preg_match('/\d/u', "１"), preg_match('/\bé/u', " é"), preg_match('/[[:alpha:]]/u', "é"));
// 69
var_dump(preg_match('/\s/', "\xA0"), preg_match('/[\S]/', "\xA0"));
// 70
var_dump(preg_match('/^.$/', "\r"), preg_match('/^a$/m', "a\r\n"), preg_match_all('/^/m', "a\nb\n"));
// 71
var_dump(preg_match('/\Qa.b\E/', 'axb'), preg_match('/\N/', "\n"), preg_match('/a{,3}/', 'aa', $m), $m);
// 72
var_dump(preg_match('/(a/', 'a'), preg_match('/[z-a]/', 'a'), preg_match('/*a/', 'a'), preg_match('/(a)\2/', 'a'), preg_match('/\p{Foo}/u', 'a'));
// 73
var_dump(preg_match('/(a)(?<b>b)/n', 'ab', $m), $m);
// 74
var_dump(preg_match('/a/u', 'a', $m, 0, 5), preg_last_error_msg(), preg_match('/本/u', '日本', $m, 0, 1), preg_last_error_msg());
// small
var_dump(preg_match("\0a\0", 'a'), preg_match("/a/\0", 'a'));
try { preg_match_all('/a/', 'a', $m, 3); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }

$errs = ['/(a/', '/a)/', '/[a/', '/a{2,1}/', '/[z-a]/', '/(a)\2/', '/\p{Foo}/u', '/*a/', '/a**/', '/a{,3}/', '/a{ 1 , 2 }/', '/(?<n>a)\k<m>/', '/a\\/', '/[[:foo:]]/', '/(?P=x)/', '/\c/', '/a{99999999}/', '/(?<1a>x)/', '/x{2}{3}/', '/(?:a/', '/\x{110000}/u', '/\8/', '/a|*b/', '/[\d-z]/', '/ab(c/x', "/日(本/u", '/\g{5}/', '/\k/', '/(a)(?<n>b)\g{-3}/'];
foreach ($errs as $p) { echo $p, ' => '; var_dump(preg_match($p, 'a')); }

$chars = ["\u{0301}", "²", "\u{203F}", "_", "\u{00AD}", "€", "\u{2028}", "\u{0085}", "\u{3000}", "\u{FF21}", "\u{FF41}", "ａ", "Ⅻ", "\u{200B}", "\t"];
foreach (['alpha','alnum','word','graph','print','punct','cntrl','space','blank','xdigit','upper','lower'] as $c) {
  echo str_pad($c, 7), ' ';
  foreach ($chars as $ch) echo preg_match("/[[:$c:]]/u", $ch);
  echo "\n";
}
foreach (['\w','\d','\s','\h','\v'] as $c) { echo $c, ' '; foreach ($chars as $ch) echo preg_match("/$c/u", $ch); echo "\n"; }
var_dump(preg_match('/[[:^alpha:]]/', 'a1'), preg_match('/[[:^alpha:]]/u', 'é1', $m), $m);
var_dump(preg_match('/\W+/u', ' é,', $m), $m, preg_match('/[\W\d]+/u', 'é,1é', $m), $m, preg_match('/[^\W\d]+/u', ',é1', $m), $m);

foreach (['/^*a/', '/\b+a/', '/a$?/', '/(?=a)*a/', '/a\i/', '/a\y/', '/a\T/', '/A/', '/\L/', '/a\m/', '/\j/', '/[\i]/', '/a{2}*/', '/\x41\x4/', '/\101\0101/', '/\e\a/', '/[a-\d]/', '/[\w-]/', '/[%--]/', '/(?<n>a)(?<n>b)/', '/\p{han}/u', '/\p{Greek}/u', '/\p{L&}/u', '/[\p{Xan}]/u', '/\o{101}/', '/(a)\10/', '/a]b/u', '/\#/u', '/\N{U+41}/u', '/\cA/'] as $p) { echo $p, ' => '; var_dump(preg_match($p, "aA^\x01\x1b\x07\x41\x04\x08A\x41\x8\n]#ab%,-漢")); }

foreach (['/\xz/', '/a\x/', '/\x{zz}/', '/\x{}/', '/[\xz]/', '/[\x{41}]/', '/\o{}/', '/\o/', '/\pZ/u', '/\p{/u', '/\p{L/u', '/[\E]]/', '/[\Q\E]]/', '/\ca/', '/\c/', '/[\c]]/', '/\x{100}/u', '/\o{777}/', '/[\x{100}]/'] as $p) { echo $p, ' => '; var_dump(preg_match($p, "a]\x01z")); }

