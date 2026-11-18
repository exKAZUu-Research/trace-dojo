<?php
$previous = null;
for ($i = 0; $i < 70; $i++) {
    $previous = new Exception("entry-$i", 0, $previous);
}
$text = (string) $previous;
$table = (array) $previous;
var_dump(
    str_contains($text, 'Exception: entry-0 in '),
    str_contains($text, 'Exception: entry-69 in '),
    $table["\0Exception\0string"] === $text,
);
$error = new Error('message');
$text = $error->__toString();
var_dump(((array) $error)["\0Error\0string"] === $text);
