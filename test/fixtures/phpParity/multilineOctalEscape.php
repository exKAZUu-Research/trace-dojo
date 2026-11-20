<?php
$object = new stdClass;
$object->Array = 'name';
echo $object->{[]}, ':', (integer) "\461", "\n";
$text = "start
\400 middle
say \777";
echo strlen($text), "\n";
$heredoc = <<<TEXT
    start
    \401 middle
    say \775
    TEXT;
echo strlen($heredoc), "\n";
