<?php
foreach ([
    '~[\Qa\E-z]~',
    '~[\Qabc\E-\Qxyz\E]~',
    '~[a-\Q\E]~',
    '~[a\Q\E-z]~',
    '~[\Q\E^a]~',
    '~[\Q^\Ea]~',
    '~[\Qa-z\E]~',
    '~[\Q a\E - \Q z\E]~xx',
    '~[^\Qα\E-\Qω\E]~u',
    '~[\Qz\E-a]~',
] as $pattern) {
    var_dump(preg_replace($pattern, '*', 'am-^xz αμω'));
}
