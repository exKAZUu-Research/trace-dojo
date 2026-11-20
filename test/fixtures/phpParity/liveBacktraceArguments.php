<?php
function traced($first,&$second,...$rest){
    $first='changed';$second=8;$rest[0]=9;
    debug_print_backtrace();
}
$value=2;traced('original',$value,3);
