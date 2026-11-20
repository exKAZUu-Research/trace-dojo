<?php
foreach([63,97,'none','long'] as $substitute){
    mb_substitute_character($substitute);
    foreach(['UTF-8','ASCII','ISO-8859-1'] as $encoding){
        foreach(["a\xFF","A\xFF","\xFFa","1\xFF","é\xFF","É\xFF",'ßx',''] as $text){
            echo $encoding,':',bin2hex($text),':',bin2hex(mb_ucfirst($text,$encoding)),':',bin2hex(mb_lcfirst($text,$encoding)),"\n";
        }
    }
    foreach(["\x00a\xD8\x00","\x00A\xD8\x00","\xD8\x00\x00a"] as $text){
        echo 'UTF-16BE:',bin2hex($text),':',bin2hex(mb_ucfirst($text,'UTF-16BE')),':',bin2hex(mb_lcfirst($text,'UTF-16BE')),"\n";
    }
}
