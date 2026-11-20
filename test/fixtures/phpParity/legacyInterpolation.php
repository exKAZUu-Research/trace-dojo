<?php
$i = 6; $a = [1 => 'x', 'k' => 'y'];
echo "${a[1]} ${a['k']}\n";
echo <<<EOT
${i}
EOT;
$keys = [0 => 'zero', '-0' => 'negative zero', '00' => 'padded', -1 => 'negative'];
echo "$keys[-0];$keys[0];$keys[00];$keys[-1]\n";
$keys = [0 => 'zero'];
echo "a$keys[-0]b\n";
