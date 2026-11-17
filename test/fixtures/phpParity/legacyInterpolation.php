<?php
$i = 6; $a = [1 => 'x', 'k' => 'y'];
echo "${a[1]} ${a['k']}\n";
echo <<<EOT
${i}
EOT;
