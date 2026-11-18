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
