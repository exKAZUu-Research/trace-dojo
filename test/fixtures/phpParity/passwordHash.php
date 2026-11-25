<?php
$h = password_hash("secret", PASSWORD_DEFAULT);
var_dump(strlen($h), substr($h, 0, 7), password_verify("secret", $h), password_get_info($h));
$h4 = password_hash("secret", PASSWORD_BCRYPT, ["cost" => 4]);
var_dump(password_verify("wrong", $h4), password_needs_rehash($h4, PASSWORD_DEFAULT), password_needs_rehash($h4, PASSWORD_BCRYPT, ["cost" => 4]));
var_dump(password_verify("rasmuslerdorf", '$2y$10$.vGA1O9wmRjrwAVXD98HNOgsNpDczlqm3Jq7KnEd1rVAGv3Fykk1a'));
var_dump(password_verify("x", "notahash"), password_get_info("notahash"));
try { password_hash("x", PASSWORD_BCRYPT, ["cost" => 3]); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
try { password_hash("a\0b", PASSWORD_BCRYPT); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
