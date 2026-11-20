<?php
class Operations {
    public $items = [1];
    function rate() { return 2; }
    function process() {
        try { echo $this->items * $this->rate(); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
    }
}
(new Operations)->process();
$bad = [];
$string = '5a';
$float = 2.5;
foreach ([fn() => $string * $bad, fn() => $string + $bad, fn() => $float | $bad, fn() => $float << $bad] as $calculate) {
    try { $calculate(); } catch (TypeError $error) { echo $error->getMessage(), "\n"; }
}
