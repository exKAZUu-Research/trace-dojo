<?php
foreach ([STDOUT, [STDOUT], (object)["value" => STDOUT]] as $value) {
    var_dump(json_encode($value), json_last_error_msg());
    var_dump(json_encode($value, JSON_PARTIAL_OUTPUT_ON_ERROR), json_last_error_msg());
    try { json_encode($value, JSON_THROW_ON_ERROR); } catch (Throwable $error) { echo $error->getCode(), "|", $error->getMessage(), "\n"; }
}
foreach (["\xE2\x82", "\xF0\x9F\x98", "\xE2\x82A", "\xED\xA0\x80", "\xE0\x80\x80", "\xE2\x82\xFF"] as $value) {
    foreach ([JSON_INVALID_UTF8_SUBSTITUTE, JSON_INVALID_UTF8_IGNORE] as $flags) var_dump(json_encode($value, $flags));
    var_dump(json_decode('"'.$value.'"', false, 512, JSON_INVALID_UTF8_SUBSTITUTE));
}
