<?php
$a=1; function &get(){global $a; return $a;} function inc(&$x){$x++;} inc(get()); var_dump($a);
$a=[1]; $b=$a; inc(...$a); var_dump($a,$b);
$a=['x'=>5]; $b=$a; inc(...$a); var_dump($a,$b);
class Holder { public int $value=1; public static int $staticValue=2; function &get(){return $this->value;} static function &getStatic(){return self::$staticValue;} }
$h=new Holder; inc($h->get()); inc(Holder::getStatic()); var_dump($h->value, Holder::$staticValue);
