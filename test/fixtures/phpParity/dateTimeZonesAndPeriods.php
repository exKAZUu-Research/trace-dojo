<?php
foreach (['2024-01-01 10:00 +09:00', '2024-01-01 10:00 utc', '2024-01-01 10:00 GMT', '2024-01-01T10:00:00Z', '@1700000000', '2024-01-01 10:00 Europe/Berlin'] as $s) {
  $d = new DateTime($s);
  echo $d->format('Y-m-d H:i:s T e P p O Z I U'), "\n";
}
$ny = new DateTimeZone('America/New_York');
$d = new DateTime('2024-03-10 01:30', $ny);
echo $d->modify('+1 hour')->format('c T'), "\n";
$d = new DateTime('2024-03-10 02:30', $ny);
echo $d->format('c T'), "\n";
$d = new DateTime('2024-11-03 01:30', $ny);
echo $d->format('c T U'), "\n";
$d->add(new DateInterval('PT1H'));
echo $d->format('c T U'), "\n";
$a = new DateTimeImmutable('2024-01-01');
$b = new DateTime('2024-01-01');
var_dump($a == $b, $a <=> $b, $a < new DateTime('2024-01-02'));
var_export(new DateTimeImmutable('2024-01-01 00:00:00'));
echo "\n";
var_dump((array) new DateTimeZone('+01:00'));
$i = new DateInterval('P1D');
var_dump(get_object_vars($i));
$i->d = 5;
echo (new DateTime('2024-01-01'))->add($i)->format('Y-m-d'), "\n";
echo strtotime('2024-02-29 +1 year'), ' ', date('Y-m-d', strtotime('2024-02-29 +1 year')), "\n";
echo date('Y-m-d', strtotime('last day of february 2023')), "\n";
var_dump(strtotime('2024-01-01 00:00:00') - strtotime('2023-01-01 00:00:00'));
date_default_timezone_set('Asia/Tokyo');
echo date('Y-m-d H:i:s', 0), ' ', mktime(0, 0, 0, 1, 1, 2024), ' ', strtotime('2024-01-01'), "\n";
$t = new DateTime('2024-01-01');
var_dump($t);
echo $t->getTimezone()->getName(), "\n";
var_dump(date_default_timezone_get());
echo (new DateTime('@0'))->getTimezone()->getName(), "\n";
class Broken extends DateTime { public function __construct() {} }
try { (new Broken())->format('Y'); } catch (Error $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
$p = new DatePeriod(new DateTime('2024-01-01'), new DateInterval('P1M'), new DateTime('2024-04-01'));
foreach ($p as $k => $m) echo $k, $m->format(' M'), ',';
echo "\n";
echo $p->getEndDate()->format('Y-m-d'), "\n";
var_dump($p->getRecurrences());
