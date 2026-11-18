<?php
function t($f) { try { var_dump($f()); } catch (\Throwable $e) { echo get_class($e), ": ", $e->getMessage(), "\n"; } }
t(fn() => implode(["a"], 5));
t(fn() => implode(["a"], ["b"]));
t(fn() => implode(",", 5));
t(fn() => implode(",", null));
t(fn() => implode(5));
t(fn() => implode(5, ["a", "b"]));
t(fn() => implode(["a", 1.5, true, null]));
t(fn() => mb_str_pad('abc', 2, ''));
t(fn() => mb_str_pad('abc', 2, ' ', 9));
t(fn() => mb_str_pad('abc', 2, '', 9, 'FOO'));
t(fn() => mb_str_pad('abc', 5, 'x', 9, 'FOO'));
t(fn() => mb_str_pad('abc', 5, '', 1, 'FOO'));
t(fn() => mb_convert_case('abc', 9, 'FOO'));
t(fn() => mb_str_split('abc', 0, 'FOO'));
t(fn() => mb_substr_count('abc', '', 'FOO'));
t(fn() => mb_ord('', 'FOO'));
t(fn() => mb_strpos('abc', 'a', 9, 'FOO'));
t(fn() => mb_chr(65, 'FOO'));
t(fn() => mb_trim(' a ', null, 'FOO'));
t(fn() => mb_strlen('abc', ''));
t(fn() => mb_strlen('abc', 'pass'));
t(fn() => mb_strlen('abc', 'auto'));
t(fn() => mb_strlen('abc', 'latin1'));
t(fn() => mb_strlen('abc', 'ascii'));
t(fn() => mb_strlen('abc', 'UTF8'));
t(fn() => mb_strlen('abc', 'UTF-8 '));
t(fn() => mb_strlen('abc', null));
foreach (["ǆemal ǉ ǌ ǳ", "ßa", "ﬁx ﬂow", "ŉa", "ǰa", "ᾀa ᾳ ᾲ ᾷ Ᾰ", "ابc", "1abc a1b", "hello.world o'neil foo-bar x_y", "ΟΔΟΣ ΟΔΟΣ.", "ⓐbc", "ꭰꭱ Ꭰ", "ı İ", "ა ბ", "ǅa", "ǄA"] as $x) {
  echo mb_convert_case($x, MB_CASE_TITLE), "|", mb_convert_case($x, MB_CASE_TITLE_SIMPLE), "|", mb_ucfirst($x), "|", mb_lcfirst($x), "\n";
  echo mb_convert_case($x, MB_CASE_UPPER), "|", mb_convert_case($x, MB_CASE_UPPER_SIMPLE), "|", mb_convert_case($x, MB_CASE_LOWER), "|", mb_convert_case($x, MB_CASE_LOWER_SIMPLE), "\n";
  echo mb_convert_case($x, MB_CASE_FOLD), "|", mb_convert_case($x, MB_CASE_FOLD_SIMPLE), "|", mb_strtoupper($x), "|", mb_strtolower($x), "\n";
}

foreach (["\u{1FD3}" => "\u{0390}", "\u{1FE3}" => "\u{03B0}", "\u{FB05}" => "\u{FB06}"] as $source => $folded) {
    var_dump(mb_convert_case($source, MB_CASE_FOLD_SIMPLE, 'UTF-8') === $folded);
    var_dump(mb_stripos("z$source", $folded, 0, 'UTF-8'));
}
