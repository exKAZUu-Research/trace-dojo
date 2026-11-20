<?php
function target(){echo 'rhs;';return 'stdClass';}
var_dump(null instanceof(target()), true instanceof(target()), false instanceof(target()));
var_dump(1 instanceof(target()), 1.5 instanceof(target()), 'x' instanceof(target()));
var_dump([] instanceof(target()), [1] instanceof(target()), (1+2) instanceof(target()));
var_dump(('x'.'y') instanceof(target()), PHP_EOL instanceof(target()));
var_dump((int)'1' instanceof(target()));
$value=null;var_dump($value instanceof(target()));
