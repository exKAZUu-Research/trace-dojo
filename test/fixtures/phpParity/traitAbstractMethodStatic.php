<?php
trait TraitContract { abstract function run(); }
class Implementation {
    use TraitContract;
    static function run() {}
}
