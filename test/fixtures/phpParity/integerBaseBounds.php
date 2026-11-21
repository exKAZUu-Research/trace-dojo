<?php
foreach ([-10, -1, 0, 1, 2, 36, 37, 38, 999] as $base) {
    var_dump(intval("10", $base), intval("-10", $base), intval(10, $base));
}
