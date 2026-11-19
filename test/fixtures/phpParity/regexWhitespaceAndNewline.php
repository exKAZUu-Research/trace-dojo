<?php
foreach(["~\u{00a0}~ux","~\u{3000}~ux","~\u{0085}~ux"] as $p){var_dump(preg_match($p,''),preg_match($p,"\u{00a0}\u{3000}\u{0085}"));}
foreach(['~^\R\n$~','~^\R\n$~u','~^\R+$~','~^\R{2}$~','~^\R\R$~'] as $p){foreach(["\r\n","\r\n\n","\r\r\n"] as $s)var_dump(preg_match($p,$s));}

foreach ([" ", "\xA0"] as $separator) {
    var_dump(preg_match('~^\h+foo$~i', $separator . 'FOO'));
}
foreach (["\n", "\x85"] as $separator) {
    var_dump(preg_match('~(?i)^\vfoo$~', $separator . 'FOO'));
    var_dump(preg_match('~^(?i:\Rfoo)$~', $separator . 'FOO'));
}
var_dump(preg_match('~^\xC0foo$~i', "\xC0FOO"), preg_match('~^\xC0foo$~i', "\xE0FOO"));
var_dump(preg_match('~^[\xD7-\xF7]foo$~i', "\xE0FOO"), preg_match('~^[\xD7-\xF7]foo$~i', "\xC0FOO"));
var_dump(preg_match("~^\xe9$~i", "\xc9"), preg_match("~^[\xe0-\xef]$~i", "\xc9"));

foreach (['キャット', 'サッカー', 'hello', 'Yz', 'Yy', "\xC0\xE0", "\xE0\xE0"] as $word) {
    var_dump(preg_match('~(.)\1~i', $word));
}
var_dump(preg_match('~^(?<letter>.)(?i:\k<letter>)$~', 'Aa', $matches), $matches);
var_dump(preg_match('~^\p{Lu}$~i', "\xE0"), preg_match('~^\p{Lu}$~i', "\xC0"));
