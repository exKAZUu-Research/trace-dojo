<?php
foreach ([
    ['(a)\1|^$', ''],
    ['(a)?\1|^$', ''],
    ['(a)?\1', ''],
    ['(a*)\1', ''],
    ['(a*)?\1', ''],
    ['(?!(a))\1|^$', ''],
    ['(?<name>a*)\k<name>', ''],
    ['(?<name>a)?\k<name>|^$', ''],
    ['(x)\1|^$', 'xx'],
    ['\N{2}', "ab\na"],
    ['\N{1,2}', "ab\na"],
    ['\N{,2}', "ab\na"],
    ['\N{2,}+', "ab\na"],
    ['[[:<:]]b', 'a b'],
    ['a[[:>:]]', 'a b'],
    ['[[:<:]]+b', 'a b'],
    ['[[:<:]]b[[:>:]]', 'abc'],
] as [$source, $subject]) {
    var_dump(preg_match('~' . $source . '~', $subject, $matches, PREG_UNMATCHED_AS_NULL), $matches);
}

var_dump(preg_match('~\N{2}~u', '猫犬', $matches), $matches);
var_dump(preg_match('~[[:<:]]猫[[:>:]]~u', '猫 犬', $matches), $matches);
var_dump(preg_replace('~(a)\1|^$~', 'replacement', ''));
var_dump(preg_match_all('~(a*)\1~', '', $matches), $matches);

foreach (['\N{name}', '(?P>)', '(?P>a', '(?P>a)', '\g<a', "\\g'a", '\g<1', '\g<a>', '\g<-1>', '\g<+1>', '(?<=\X)b', '(?<=(?R))a'] as $source) {
    var_dump(preg_match('~' . $source . '~', 'ab'));
}
foreach (['\N{2,1}', '\N{70000}', '(?+)', '(?+a)', '(?+', '(?P>a b)', '(?&a b)'] as $source) {
    var_dump(preg_match('~' . $source . '~', 'ab'));
}
echo "continued\n";
