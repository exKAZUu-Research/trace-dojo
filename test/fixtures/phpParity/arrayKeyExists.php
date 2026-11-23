<?php
try { var_dump(array_map('array_key_exists', [[]], [[]])); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
try { var_dump(array_key_exists(new stdClass, [])); } catch (TypeError $e) { echo $e->getMessage(), "\n"; }
var_dump(call_user_func('array_key_exists', null, ['' => 1]));
