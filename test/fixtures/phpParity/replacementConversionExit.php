<?php
class ExitOnConversion {
    function __toString(): string { echo 'cast;'; exit; }
}
class ReportReplacementCount {
    function __destruct() { echo $GLOBALS['count']; }
}
$count = 99;
$observer = new ReportReplacementCount;
str_replace([new ExitOnConversion, 'a'], ['', 'b'], 'aaa', $count);
echo 'never';
