<?php
$object=json_decode('{"1":"one","01":"zero","-2":"negative","+3":"plus"}');
$values=get_object_vars($object);var_dump($values,isset($values[1]),isset($values[-2]));
$object=new stdClass;$object->{'1'}='one';$object->{'01'}='zero';var_dump(get_object_vars($object));
