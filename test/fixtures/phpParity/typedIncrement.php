<?php
class T { public int $i = PHP_INT_MAX; public ?int $n = PHP_INT_MIN; public int|float $f = PHP_INT_MAX; public static int $s = PHP_INT_MAX; public $u = PHP_INT_MAX; }
$t = new T;
try { $t->i++; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { --$t->n; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$t->f++; var_dump($t->f);
try { T::$s++; } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
$t->u++; var_dump($t->u, $t->i);
