<?php
$x = json_decode('{"a":{"b":{}},"c":{"d":1,"e":{}}}');
var_dump($x);
$y = json_decode('[{"p":1},{"q":{}}]'); var_dump($y);
