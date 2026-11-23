<?php
interface Contract { function process(int $value); }
class Incorrect implements Contract {
    function process(string $value = null) {}
}
