<?php
var_dump(substr_replace(["abcdef", "abcdef"], "X", [1, 1], [null, 0]));
var_dump(substr_replace(["abcdef", "abcdef"], "X", [1, 1], [null]));
var_dump(substr_replace(["abcdef", "abcdef"], "X", [1, 1], []));
var_dump(substr_replace("abcdef", "X", 1, null));
