<?php
$subject = str_repeat("あああああああああz", 5000);
echo preg_match_all('/(?<=(あ))z/u', $subject, $matches), "\n";
echo count($matches[1]), " ", $matches[1][4999], "\n";
preg_match_all('/(?<=(😀))z/u', '😀z😀z', $matches, PREG_OFFSET_CAPTURE);
var_export($matches);
echo "\n";
