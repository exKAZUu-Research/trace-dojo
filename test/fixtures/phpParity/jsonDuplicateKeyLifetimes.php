<?php
foreach (['{"a":{},"a":{},"b":{}}','{"a":{},"a":1,"b":{}}','{"a":[{},{}],"a":{},"b":{}}','{"a":{"x":{},"x":{},"b":{}},"b":{}}','[{"a":{},"a":{}} ,{}]'] as $text) {var_dump(json_decode($text),new stdClass);}
foreach (['{"a":{},"b":', '{"a":[{},{}],"a":{},"b":', '[{}, {"a":{},"b":'] as $text) var_dump(json_decode($text),new stdClass);
