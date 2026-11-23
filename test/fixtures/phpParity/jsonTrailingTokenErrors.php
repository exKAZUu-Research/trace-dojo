<?php
foreach (['1"a', '[1"a', '1"\uD800"', "1\"\xFF\"", '{"a" "bad', '{"a":0 "bad', '1"valid"', '[1 "valid"]'] as $json) {
    var_dump(json_validate($json), json_last_error());
    try {
        json_decode($json, flags: JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        echo $error->getCode(), ' ', $error->getMessage(), "\n";
    }
}
