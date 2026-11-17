<?php
foreach (["caf\xe9", "\xe9cole", "na\xefve", "\xe0la", "fa\xe7ade", "ni\xf1o", "\xdfx", "x\xc0y", "caf\xc3\xa9", "na\xc3\xafve"] as $w) echo bin2hex($w), " => ", metaphone($w), "\n";
setlocale(LC_CTYPE, "C");
foreach (["caf\xe9", "\xe9cole", "na\xefve"] as $w) echo bin2hex($w), " => ", metaphone($w), "\n";
