<?php
$s="\u{FEFF}a"; preg_match('/^./u', $s, $m); echo bin2hex($m[0]), "\n", $s, "\n";
$a=[1,2]; $b=$a; next($a); var_dump(current($a),current($b)); end($b); var_dump(current($a),current($b)); reset($a); var_dump(current($a),current($b));
$a=new ArrayObject([[1]]); $a[0][0]=2; var_dump($a[0]);
$a=new ArrayIterator([[1]]); $a[0][0]=2; var_dump($a[0]);
for($i=0;$i<2;$i++){ goto done; echo 'skip'; done: echo $i; }
