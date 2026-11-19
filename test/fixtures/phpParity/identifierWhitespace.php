<?php
namespace Wide \Name　;
function hello　() { return __FUNCTION__; }
class Box  {
    public string $value　 = 'property';
    public function method () { return $this->value　; }
}
var_dump(function_exists(__NAMESPACE__ . '\hello'), function_exists(__NAMESPACE__ . '\hello　'));
var_dump(hello　(), (new Box )::class, (new Box )->method ());
$box = new namespace\Box ;
var_dump($box->value　);
