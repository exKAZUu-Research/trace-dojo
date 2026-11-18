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
