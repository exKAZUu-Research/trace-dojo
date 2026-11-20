<?php
foreach (['md5','sha1','sha224','sha256','sha384','sha512','sha512/224','sha512/256','sha3-224','sha3-256','sha3-384','sha3-512','ripemd160','SHA256'] as $a) {
  echo $a, " ", hash($a, "hello"), " ", hash_hmac($a, "data", "secret"), " ", bin2hex(hash_hmac($a, "data", "k\xff", true)), " ", bin2hex(hash($a, "\xff", true)), "\n";
}
echo hash('crc32b', 'hello'), " ", bin2hex(hash('crc32b', 'hello', true)), "\n";
echo hash_hmac('sha256', '', ''), "\n", hash_hmac('sha256', 'x', str_repeat('k', 200)), "\n";
foreach (['crc32b', 'adler32', 'nope', 'xxh3'] as $a) { try { hash_hmac($a, 'x', 'y'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; } }
try { hash('nope', 'x'); } catch (ValueError $e) { echo $e->getMessage(), "\n"; }
