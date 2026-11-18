<?php
foreach (["/(?#oops/", "/a(?#oops/", "/(?#done)a/"] as $pattern) { var_dump(preg_match($pattern, "a")); }
foreach ([0, 1, 2, 3, -1, 257] as $flags) { var_dump(preg_grep('/a/', ["a", "b"], $flags)); }
