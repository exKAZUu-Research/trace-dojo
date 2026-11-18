<?php
class A {
 final private function __construct(){}
 final private static function s(){}
}
trait T{final private function t(){}}
echo 'ok';
