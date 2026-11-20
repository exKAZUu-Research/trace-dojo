<?php
set_error_handler(function($level,$message){echo $level,':',$message,"\n";});
var_dump(E_STRICT,constant('E_STRICT'));
restore_error_handler();
foreach ([4294967296,PHP_INT_MIN,4294967298,-4294967294,4294967332,4294967306,10] as $base) {
    var_dump(intval('10',$base),intval('1e2',$base),intval(5,$base));
}
var_dump(preg_match('/[\8]/','8'),preg_match('/[\9]/u','9'),preg_match('/[\8-\9]/','7'));
