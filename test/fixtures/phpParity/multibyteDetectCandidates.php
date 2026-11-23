<?php
var_dump(mb_detect_encoding('a', 'SJIS'));
var_dump(mb_detect_encoding('こんにちは', 'Shift_JIS'));
var_dump(mb_detect_encoding('abc', 'ASCII, Shift_JIS', true));
var_dump(mb_detect_encoding('abc', ['x-euc-jp', 'ASCII'], true));
var_dump(mb_detect_encoding("\x82\xA0", ['ASCII', 'Shift_JIS', 'UTF-8'], true));
var_dump(mb_detect_encoding("\xA4\xA2", ['ASCII', 'EUC-JP'], true));
var_dump(mb_detect_encoding("\xA4\x40", ['ASCII', 'BIG5'], true));
var_dump(mb_detect_encoding("\x82", 'SJIS', true));
var_dump(mb_detect_encoding("\x82", 'SJIS', false));
var_dump(mb_detect_encoding('こんにちは', ['UTF-8', 'EUC-JP'], true));
var_dump(mb_detect_encoding('a', 'ISO-2022-KR'));
var_dump(mb_detect_encoding('a', ['Base64', 'x-uuencode']));
try { mb_detect_encoding('a', 'SJIS, bogus'); }
catch (ValueError $error) { echo $error->getMessage(), "\n"; }

foreach ([
    ['UCS-2BE', "\x65\xE5"],
    ['UCS-2LE', "\xE5\x65"],
    ['UCS-4BE', "\x00\x00\x65\xE5"],
    ['UCS-4LE', "\xE5\x65\x00\x00"],
    ['UCS-2', "\xFF\xFE\xE5\x65"],
] as [$candidate, $bytes]) {
    var_dump(mb_detect_encoding($bytes, $candidate, true));
}
var_dump(mb_detect_encoding("\x00\x65\xE5", 'UCS-2BE', true));

foreach (['SJIS', 'CP932'] as $candidate) {
    foreach (["\x81\x60", "\xA6", "\x81\x7F"] as $bytes)
        var_dump(mb_detect_encoding($bytes, $candidate, true));
}

foreach (['JIS', 'ISO-2022-JP'] as $candidate) {
    foreach (["\x1b\x24B\x24\x22\x1b(B"] as $bytes) {
        var_dump(mb_detect_encoding($bytes, $candidate, true));
        var_dump(mb_detect_encoding($bytes, [$candidate, 'ASCII']));
    }
}
