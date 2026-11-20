<?php
foreach(['é','aé','éé',"\xC3\xFF","a\x80b","\xE2\x82",'👩a',''] as $text){
    foreach([substr('é',1),"\xC3","\xFF","\x82",'', 'é','a','?'] as $needle){
        echo bin2hex($text),'/',bin2hex($needle),':';
        try{var_dump(mb_substr_count($text,$needle));}catch(Throwable $e){echo 'count-error;';}
        foreach([-2,-1,0,1,2] as $offset){foreach(['mb_strpos','mb_strrpos','mb_stripos','mb_strripos'] as $function){
            try{var_dump($function($text,$needle,$offset));}catch(Throwable $e){echo 'offset-error;';}
        }}
    }
}
