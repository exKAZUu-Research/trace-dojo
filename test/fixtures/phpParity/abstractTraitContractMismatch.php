<?php
trait T{abstract function f(int $x):int;}class A{use T;function f(string $x):int{return 1;}}echo 'never';
