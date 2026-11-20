<?php
foreach ([
    ['~^/([a-z]+(-[a-z]+)?/)+$~i', '/learn-code/basic/'],
    ['~^([a-z]+([.-][a-z]+)?)+$~i', 'hello-world'],
    ['/(a|(b))+/', 'aba'],
    ['/(?:a|(b))+/', 'aba'],
    ['/(?>(a)|b)+/', 'aba'],
    ['/(a*)+/', 'aaa'],
    ['/(a?){0,3}/', 'a'],
    ['/()*/', ''],
    ['/(?:|a){0,3}/', 'aa'],
    ['/(?:a*?)*/', 'aa'],
    ['/(?:x*|a)+/', 'aa'],
    ['/(?:page\K[0-9] )+/', 'page1 page2 '],
] as [$pattern, $subject]) {
    var_dump(preg_match($pattern, $subject, $matches, PREG_OFFSET_CAPTURE), $matches);
}
echo preg_replace('/(?:b?|a)*/', 'X', 'aa'), "\n";
