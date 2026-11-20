<?php
$number = 1;
$object = new stdClass;
$items = [null];
try { $number->value = $absent; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
try { $neverDeclared->value = $absent; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
try { $items[0]->value = $absent; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
try { $object[0] = $absent; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
try { stdClass::$missing = $absent; } catch (Throwable $error) { echo $error->getMessage(), "\n"; }
class UnsetValues {
    public $untyped = [];
    public ?array $typed = [];
    public $object;
}
$state = new UnsetValues;
unset($state->untyped, $state->typed, $state->object);
unset($state->untyped['key'], $state->typed['key'], $state->object->property);
var_dump($state);
