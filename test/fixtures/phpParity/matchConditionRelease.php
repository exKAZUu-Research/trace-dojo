<?php
class MatchItem {
    function __construct(public int $id) {}
    function __destruct() { echo "drop $this->id\n"; }
}
function selected() { echo "selected\n"; return true; }
$item = new MatchItem(1);
$value = match ($item) {
    new MatchItem(2) => false,
    new MatchItem(3), $item => selected(),
};
var_dump($value);
