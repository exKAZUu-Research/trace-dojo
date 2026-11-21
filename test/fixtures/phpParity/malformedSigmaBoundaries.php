<?php
foreach([97,65,'none','long','entity'] as $sub){mb_substitute_character($sub);foreach(['ce91ffcea3','ce91cea3ffce92','ce91ffcea320','ce91edb080cea3'] as $hex){$s=hex2bin($hex);echo bin2hex(mb_strtolower($s)),':';foreach([MB_CASE_LOWER,MB_CASE_TITLE,MB_CASE_LOWER_SIMPLE,MB_CASE_TITLE_SIMPLE] as $mode)echo bin2hex(mb_convert_case($s,$mode)),':';echo "\n";}}
