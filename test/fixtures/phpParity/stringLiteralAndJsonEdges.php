<?php
$name = 'PHP';
var_dump(b"binary", B"hello $name", b"", B'bytes', b"\u{000041}");
var_dump("literal \\u{not an escape}", "unknown \u", (binary)123);
var_dump((1 < 2) < 3, 1 == 2 < 3, match (2) { 1, 2 => 'yes', default => 'no' });
foreach (['"', '"open', '{"key":"', '"escape' . chr(92), '"bad' . chr(92) . 'x', '"closed"'] as $json) {
    var_dump(json_decode($json), json_last_error(), json_last_error_msg());
    try { json_decode($json, flags: JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { echo $error->getCode(), ': ', $error->getMessage(), "\n"; }
}
