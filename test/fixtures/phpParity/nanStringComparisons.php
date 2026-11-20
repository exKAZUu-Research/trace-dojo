<?php
$nan = (-1) ** 0.5;
foreach (["NAN", "x", "", "1x", "INF", 0, 1.0] as $other) {
    var_dump($nan == $other, $other == $nan, $nan != $other, $nan < $other, $nan <= $other, $nan > $other, $nan >= $other, $other < $nan, $other <= $nan, $nan <=> $other, $other <=> $nan);
}
