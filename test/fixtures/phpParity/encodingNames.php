<?php
var_dump(bin2hex(mb_convert_encoding("\xe9\x00A", "UTF-8", " ")), bin2hex(mb_convert_encoding("\xe9\x00A", "UTF-8", ",")), mb_detect_encoding("\xe9", ",ISO-8859-1"), mb_detect_encoding("\xe9", "ISO-8859-1,"), mb_detect_encoding("\xe9", ",,,"), mb_detect_encoding("\xe9", " "));
try { mb_detect_encoding("\xe9", ["", "ISO-8859-1"]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
