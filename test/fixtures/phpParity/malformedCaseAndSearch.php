<?php
foreach([97,65,'none'] as $sub){mb_substitute_character($sub);foreach(['ff','e381','61ff5a','efbfbd'] as $hex){$s=hex2bin($hex);echo bin2hex(mb_strtoupper($s)),':',bin2hex(mb_strtolower($s)),"\n";foreach(range(0,7) as $mode)echo bin2hex(mb_convert_case($s,$mode)),',';echo "\n";}}
foreach(['mb_strpos','mb_strrpos','mb_stripos','mb_strripos'] as $fn){var_dump($fn(hex2bin('e381'),hex2bin('efbfbd')),$fn(hex2bin('efbfbd'),hex2bin('ff')),$fn(hex2bin('ff'),hex2bin('e381')),$fn('aA','A'));}
foreach(['UTF-16LE','ASCII'] as $encoding){mb_substitute_character(97);$s=$encoding==='ASCII'?hex2bin('ff'):hex2bin('00d8');echo bin2hex(mb_strtoupper($s,$encoding)),':',bin2hex(mb_strtolower($s,$encoding)),"\n";}
