<?php
class J implements JsonSerializable { public function jsonSerialize(): mixed { return [$this]; } }
var_dump(json_encode(new J, JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error());
var_dump(json_encode(new J), json_last_error());
var_dump(json_encode(["1e1000", "12"], JSON_NUMERIC_CHECK));
echo json_encode(['a' => NAN, "b\xff" => [1, [2]]], JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_PRETTY_PRINT, 1), "\n";
var_dump(json_last_error());
var_dump(json_validate('[]', 0));
