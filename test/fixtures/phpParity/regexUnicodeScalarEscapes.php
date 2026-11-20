<?php
foreach ([
    '/\x{D800}/u', '/\x{DFFF}/u', '/\o{154000}/u', '/\N{U+D800}/u',
    '/[\N{U+DFFF}]/u', '/\N{U+110000}/u', '/\N{U+FFFFFFFF}/u', '/é\x{D800}/u',
    '/\x{D800}/', '/\N{U+D800}/', '/\x{10FFFF}/u',
] as $pattern) {
    unset($matches);
    var_dump(preg_match($pattern, 'text', $matches), $matches);
}
