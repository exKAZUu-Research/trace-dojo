<?php
foreach ([
    '[:digit:]', '[.a.]', '[=a=]', '[[.a.]]', '[[=a=]]',
    '[[:bad-name:]]', '[[:d:foo:]]', '[[:digit:]]', '[:digit]',
    '(?<=a+)b', 'x(?<!a*)b', 
    '(?<=a{1,3})a', '(?<=a{256}|b)x', '(?<a-b>a)', '(?<>a)', '(?<a', '(?<1>a)',
    "(?'a-b'a)", '(?P<a', '(?Pa)', '(?P=a-b)', '\k<>', '\k<a-b>',
    '\g0', '\g{0}', '\g{ 0 }', '\g{-1}', '\g{+0}', '\g-1',
    '\x{41', '\x{', '\x{z}', '\o{400', '\N{U+41}', '\N{U+zz}', '\N{U+}', '\N{x}'
] as $pattern) {
    echo $pattern, "\n";
    var_dump(preg_match("~$pattern~", "aab1"));
}
foreach (['a + ?', 'a{2} +', 'a+(?#comment)?', "a + # comment\n ?", '(?xx)[a b]', '(?xx)[ ]', '(?xx)[ \ta - z]', '(?xx)[ ^a]',
    '(?xx)[\ a]', '(?xx)[# ]', '(?xx)(?x)[ ]', '(?xx)(?-x)[ ]', '(?xx:[a b])[ ]', '(?x)(?xx)[ ]'
] as $pattern) {
    $matches = [];
    var_dump(preg_match_all("~$pattern~x", 'aa abz #', $matches), $matches);
}
foreach (['(?<é>a)\k<é>', '(?<é>a)\g{é}', '(?<é>a)(?P=é)', '\N{U+61}', '\N{U+zz}', 'é(?<=a+)b'] as $pattern) {
    $matches = [];
    var_dump(preg_match("~$pattern~u", 'aa', $matches), $matches);
}
echo "done\n";
