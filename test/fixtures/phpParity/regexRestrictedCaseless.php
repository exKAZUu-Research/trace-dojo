<?php
var_dump(preg_match('/abc/ir', 'ABC'));
var_dump(preg_match('/k/ir', 'K'), preg_match('/s/ir', 'ſ'));
var_dump(preg_match('/K/ur', 'K'), preg_match('/K/ur', 'k'));
