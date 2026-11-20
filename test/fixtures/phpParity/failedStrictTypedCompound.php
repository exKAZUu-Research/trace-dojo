<?php
declare(strict_types=1);
class Typed {
    public ?int $value = 7;
}
$object = new Typed;
try { $object->value /= 0; }
catch (Throwable $error) { echo $error->getMessage(), "\n"; }
var_dump($object->value);
$ref = &$object->value;
try { $ref /= 0; }
catch (Throwable $error) { echo $error->getMessage(), ' / ', $error->getPrevious()->getMessage(), "\n"; }
var_dump($object->value);
