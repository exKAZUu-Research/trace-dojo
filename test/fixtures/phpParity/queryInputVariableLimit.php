<?php
foreach ([999,1000,1001,1002] as $n) {parse_str(http_build_query(array_fill(0,$n,1)),$a);echo count($a),"\n";}
parse_str(str_repeat('&&',1001).'a=1',$a);var_dump($a);
parse_str(str_repeat('a=1&',1000).'a=2',$a);var_dump($a);
