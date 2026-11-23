<?php
$GLOBALS['inc']++;
$GLOBALS['cat'] .= 'x';
$GLOBALS['add'] += 2;
$GLOBALS['dec']--;
$a = [];
$a['k']['m']['n'] .= 'x';
$missing['outer']['inner']++;
$GLOBALS['nested']['one']['two'] += 4;
$a['write']['quiet'] = 5;
$a['coalesce']['quiet'] ??= 6;
class UpdateValues { public array $items = []; }
$obj = new UpdateValues;
$obj->items['outer']['inner']++;
var_dump($a, $obj->items, $missing, $GLOBALS['nested']);
var_dump(isset($this), empty($this));
foreach ([fn() => $this ?? 'fallback', fn() => $this->property ?? 'fallback', fn() => isset($this->property), fn() => empty($this['key'])] as $call) {
    try { var_dump($call()); }
    catch (Error $error) { echo $error->getMessage(), "\n"; }
}
