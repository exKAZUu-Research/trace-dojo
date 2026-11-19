<?php
foreach(["a\xe3\x81","a\xf0\x9f\x98","\xe3\x81x","\xf0\x9f\x98x","\xc0\xaf","\xe0\x80","\xf4\x90"] as $s){
 echo bin2hex($s),':',mb_strlen($s),'/',bin2hex(mb_substr($s,1)),'/';
 foreach(mb_str_split($s) as $p)echo bin2hex($p),',';
 var_dump(mb_strpos($s,'x'),mb_strpos($s,'?'));
}
foreach([63,9731,'none','long','entity'] as $sub){mb_substitute_character($sub);foreach(['mb_strtoupper','mb_strtolower'] as $fn)echo bin2hex($fn("a\xe3\x81")),"\n";foreach([MB_CASE_UPPER,MB_CASE_TITLE,MB_CASE_FOLD] as $mode)echo bin2hex(mb_convert_case("a\xe3\x81",$mode)),"\n";}

mb_substitute_character(63);
foreach ([
    ['UTF-16', 'feff00410042', '002a002b'],
    ['UTF-16', 'fffe41004200', 'fffe2a002b00'],
    ['UTF-32', '0000feff00000041', '0000002a0000002b'],
    ['UTF-8', '41e282', 'e382a2ff'],
    ['ASCII', '41ff', 'ff2a'],
] as [$encoding, $input, $pattern]) {
    $text = hex2bin($input);
    $padding = hex2bin($pattern);
    foreach ([-1, 2, 3, 7] as $length) {
        foreach ([STR_PAD_LEFT, STR_PAD_RIGHT, STR_PAD_BOTH] as $type) {
            echo bin2hex(mb_str_pad($text, $length, $padding, $type, $encoding)), ' ';
        }
        echo "\n";
    }
}
try { mb_str_pad('', 1, encoding: 'UTF-32'); }
catch (ValueError $error) {echo $error->getMessage(), "\n";}
