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
foreach (['(?-1', '(?-1a)', '(a)(?-1a)', '(?+1a)', 'a{ 2,1 }', 'a{ 70000 }', 'a{ 2,99999 }'] as $source) {
    var_dump(preg_match('~' . $source . '~', 'ab'));
}
foreach (['\g<-1', '\g<-1a>', "\\g'-1a'", '(a)\g<-2', '\g{-1a}', '(a)\g{-2',
          '(a)\g{-1', '\g{+1', '\g{1', '\g{1a}', '\g{ 70000 }',
          '(?+1(a)', '(?+2(a)', '(a)(?-1(a)', '(?+1(1)', '(?-a', '(?aD', '(?aX)'] as $source) {
    var_dump(preg_match('~' . $source . '~', 'ab'));
}
foreach (['(?R(a)', '(?R(', '(?R(1)', '(?R(1))', '(?&n(a)', '(?P>n(a)', '(?<n>x)(?&n(a)', '(?<n>x)(?P>n(2))'] as $source) {
    var_dump(preg_match('~' . $source . '~', 'ab'));
}
echo "continued\n";

foreach (['(?R(<n>))', "(?R('n'))", '(?&n(1))', '(?P>n(1))', '(?<n>x)(?&n(<m>))'] as $source) {
    preg_match('/'.$source.'/', 'x');
}

foreach (['(x)(?2(1))', '(x)(?2(<n>))', '(x)(?+1(1))', '(?2(1))(x)'] as $source) {
    preg_match('/'.$source.'/', 'x');
}
