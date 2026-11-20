<?php
foreach (["caf\xe9", "\xe9cole", "na\xefve", "\xe0la", "fa\xe7ade", "ni\xf1o", "\xdfx", "x\xc0y", "caf\xc3\xa9", "na\xc3\xafve"] as $w) echo bin2hex($w), " => ", metaphone($w), "\n";
setlocale(LC_CTYPE, "C");
foreach (["caf\xe9", "\xe9cole", "na\xefve"] as $w) echo bin2hex($w), " => ", metaphone($w), "\n";
var_dump(setlocale(LC_CTYPE, ''), nl_langinfo(CODESET), ctype_alpha("\xc3"));
var_dump(setlocale(LC_ALL, ''), setlocale(LC_ALL, '0'));
foreach (['C.UTF-8', 'C', ''] as $locale) {
    setlocale(LC_ALL, $locale);
    foreach ([["\xc9", "\xe9"], ["\xc3", "\xe3"], ["\xde", "\xfe"], ["\xdf", "\xe9"], ["\xa0a", 'a']] as [$a, $b]) {
        echo strnatcasecmp($a, $b), ':', strnatcmp($a, $b), ';';
    }
    $words = ["\xe9" . '10', "\xc9" . '2', "\xdf" . '1'];
    sort($words, SORT_NATURAL | SORT_FLAG_CASE);
    echo bin2hex(implode(';', $words)), "\n";
}
