<?php
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
