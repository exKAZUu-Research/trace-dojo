<?php
foreach (['/\p{Xwd}/u','/\P{Xwd}/u','/\p{sc=Greek}/u','/\p{Script=Greek}/u','/\p{scx=Greek}/u','/\p{Script_Extensions=Greek}/u','/\p{sc=Han}/u','/\p{scx=Han}/u'] as $pattern) foreach (["\u{301}","\u{203f}","\u{ff3f}",'α','、','a'] as $text) var_dump(preg_match($pattern,$text));
preg_match('/./u',"\xFF");var_dump(preg_last_error(),preg_grep('/a/',[]),preg_last_error());
preg_match('/a/','a',$m,0,9);var_dump(preg_last_error(),preg_grep('/a/',[]),preg_last_error());
preg_match('/(α)(😀)(b)/u','xα😀b',$m,PREG_OFFSET_CAPTURE);var_dump($m);
preg_match_all('/(α)|(😀)/u','α😀α',$m,PREG_OFFSET_CAPTURE|PREG_UNMATCHED_AS_NULL);var_dump($m);
