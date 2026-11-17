<?php
foreach(["a\xe3\x81","a\xf0\x9f\x98","\xe3\x81x","\xf0\x9f\x98x","\xc0\xaf","\xe0\x80","\xf4\x90"] as $s){
 echo bin2hex($s),':',mb_strlen($s),'/',bin2hex(mb_substr($s,1)),'/';
 foreach(mb_str_split($s) as $p)echo bin2hex($p),',';
 var_dump(mb_strpos($s,'x'),mb_strpos($s,'?'));
}
foreach([63,9731,'none','long','entity'] as $sub){mb_substitute_character($sub);foreach(['mb_strtoupper','mb_strtolower'] as $fn)echo bin2hex($fn("a\xe3\x81")),"\n";foreach([MB_CASE_UPPER,MB_CASE_TITLE,MB_CASE_FOLD] as $mode)echo bin2hex(mb_convert_case("a\xe3\x81",$mode)),"\n";}
