<?php
foreach ([0,1,2] as $kind) {
    try {
        if ($kind === 0) preg_match(pattern:"/a/", subject:"a", flags:PREG_SET_ORDER);
        elseif ($kind === 1) preg_match_all(pattern:"/a/", subject:"a", flags:99);
        else str_pad(string:"a", length:4, pad_type:99);
    } catch (Throwable $error) { echo $error, "\n"; }
}
try {array_keys(array:[1,2], strict:true);} catch(Throwable $error){echo $error, "\n";}
try {str_pad(string:"a",length:4,pad_string:null,pad_type:99);} catch(Throwable $error){echo $error, "\n";}
try {preg_match('/a/','a',$matches,'2');} catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try {preg_match('/a/','a',flags:'2');} catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try {str_pad('a','3',2,'99');} catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try {str_pad('a',length:'3',pad_type:99.0);} catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
try {json_decode('[]',depth:'0');} catch(Throwable $e){echo $e->getTraceAsString(),"\n";}
