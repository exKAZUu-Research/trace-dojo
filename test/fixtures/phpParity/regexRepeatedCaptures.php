<?php
foreach ([
    ['~^/([a-z]+(-[a-z]+)?/)+$~i', '/learn/basic-code/'],
    ['~^([a-z]+([.-][a-z]+)?)+$~i', 'hello-world'],
    ['/(a|(b))+/', 'aab'],
    ['/(?:a|(b))+/', 'aab'],
    ['/(?>(a)|b)+/', 'bba'],
    ['/(?:page\K[0-9] )+/', 'page1 page2 '],
] as [$pattern, $subject]) {
    var_dump(preg_match($pattern, $subject, $matches, PREG_OFFSET_CAPTURE), $matches);
}
