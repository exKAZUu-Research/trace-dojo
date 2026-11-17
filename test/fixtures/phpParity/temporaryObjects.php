<?php
class N { function __construct(public $v) {} }
var_dump(new N(1) < new N(2)); var_dump(spl_object_id(new N(0)));
echo "--\n";
$x = new N(1) == new N(2); var_dump(spl_object_id(new N(0)), spl_object_id(new N(0)));
echo "--\n";
var_dump(new N(1) < new N(2), new N(3) == new N(4)); var_dump(spl_object_id(new N(0)));
