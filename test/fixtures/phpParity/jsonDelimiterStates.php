<?php
foreach (['[1}', '{"a":1]', '[}', '{]', '[1,2}', '[[1}]', '[1,]', '{"a":]', '{"a"]', '[1,}', '{"a":1,]', '{', '[1]'] as $json) {
    json_decode($json);
    echo json_last_error(), "|", json_last_error_msg(), "\n";
    var_dump(json_validate($json));
    try { json_decode($json, false, 512, JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { echo $error->getCode(), "|", $error->getMessage(), "\n"; }
}
