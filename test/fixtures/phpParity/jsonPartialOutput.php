<?php
var_dump(json_encode(NAN, JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
var_dump(json_encode([NAN, "a\xffb", ["\xff" => 1], 2], JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
var_dump(json_encode([NAN, 1]), json_last_error());
var_dump(json_encode([NAN, "\xff"]), json_last_error());
var_dump(json_encode([[["\xff"]]], 0, 1), json_last_error());
var_dump(json_encode([[[1]], 2], JSON_PARTIAL_OUTPUT_ON_ERROR, 1), json_last_error());
$r = [1]; $r[] = &$r; var_dump(json_encode($r, JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
$o = new stdClass; $o->a = $o; $o->b = 2; var_dump(json_encode($o, JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
json_decode('{');
try { json_encode(NAN, JSON_THROW_ON_ERROR); } catch (JsonException $e) { echo $e->getMessage(), "\n"; }
var_dump(json_last_error());
var_dump(json_encode(NAN, JSON_THROW_ON_ERROR | JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
var_dump(json_decode('"\ud800"'), json_last_error(), json_last_error_msg());
var_dump(json_decode('"\udc00"'), json_last_error(), json_decode('"\ud800A"'), json_last_error(), json_decode('"\ud800\uzz"'), json_last_error());
var_dump(json_decode('{"\u0000a":1}'), json_last_error(), json_last_error_msg(), json_decode('{"\u0000a":1}', true), json_last_error());
var_dump(json_decode('{"\u0000":1}'), json_last_error());
var_dump(JSON_ERROR_INVALID_PROPERTY_NAME, JSON_ERROR_UTF16);
var_dump(json_decode('', true, 0), json_last_error());
json_decode('{');
try { json_decode('{', false, 512, JSON_THROW_ON_ERROR); } catch (JsonException $e) { echo $e->getMessage(), "\n"; }
var_dump(json_last_error());
