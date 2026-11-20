<?php
class E extends Exception {function __toString(): string {throw new ErrorException('formatting',0,1,'other.php',42);}}
throw new E('original');
