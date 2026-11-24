<?php
$d = new DateTime('2024-01-31 10:20:30.25');
var_dump($d);
print_r($d); echo "\n";
echo json_encode($d), "\n";
var_export($d); echo "\n";
var_dump((array)$d);
var_dump(get_object_vars($d));
foreach ($d as $k => $v) echo "$k=$v\n";
var_dump(new DateTime('2024-01-31 10:20:30+09:00'));
var_dump(new DateTime('2024-01-31 10:20:30Z'));
var_dump(new DateTime('2024-01-31 10:20:30 UTC'));
var_dump(new DateTime('2024-01-31 10:20:30 GMT'));
var_dump(new DateTime('@86400'));
var_dump(new DateTimeImmutable('2024-01-31', new DateTimeZone('Asia/Tokyo')));
var_dump(new DateTimeZone('Asia/Tokyo'));
var_dump(new DateTimeZone('+09:00'));
var_dump(new DateTimeZone('utc'));
var_dump(new DateTimeZone('asia/tokyo'));
$i = (new DateTime('2024-01-01'))->diff(new DateTime('2024-03-15 12:00'));
var_dump($i);
print_r($i); echo "\n";
echo json_encode($i), "\n";
var_dump(new DateInterval('P1Y2M3DT4H5M6S'));
try { new DateTime('helloworld'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new DateTime('invalid date'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new DateTime('2024-13-45'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new DateTimeZone('Mars/Base'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
try { new DateInterval('P1X'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(date_create('helloworld'));
$m = new DateTime('2024-01-31');
try { $m->modify('garbage text'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
var_dump(date_modify($m, 'nonsense'));
var_dump(DateTime::createFromFormat('Y-m-d', '2024-02-30x'));
var_dump(DateTime::getLastErrors());
$c = DateTime::createFromFormat('Y-m-d H:i:s', '2024-02-10 11:12:13');
var_dump($c);
$c = DateTime::createFromFormat('d/m/Y', '15/08/2024');
echo $c->format('Y-m-d'), "\n";
