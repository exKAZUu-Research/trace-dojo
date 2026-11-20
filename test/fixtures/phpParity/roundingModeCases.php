<?php
foreach (RoundingMode::cases() as $mode) {
    echo $mode->name, ':';
    var_dump(round(1.25, 1, $mode), round(-1.25, 1, $mode));
}
var_dump(round(1.25, mode: RoundingMode::HalfEven, precision: 1));
var_dump(round(-1.2, 0, RoundingMode::TowardsZero), round(1.25, 1, PHP_ROUND_HALF_DOWN));
