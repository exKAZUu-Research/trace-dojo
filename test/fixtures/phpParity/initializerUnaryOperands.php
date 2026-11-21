<?php
class UnaryInitializer {
    public $value = +[1];
}
function defaultUnary($value = -[1]) {}
try { new UnaryInitializer(); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
try { defaultUnary(); }
catch (TypeError $error) { echo $error->getMessage(), "\n"; }
const KeepsNegativeZero = +(-0.0);
var_dump(KeepsNegativeZero);
const InvalidGlobalInitializer = -"word";
