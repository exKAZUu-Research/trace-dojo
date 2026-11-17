<?php
class A{}function foo(){}foreach([foo(...),strlen(...)] as $f){foreach([A::class,new A] as $scope){var_dump($f->bindTo(null,$scope));var_dump(Closure::bind($f,null,$scope));}var_dump($f->bindTo(new A));}
