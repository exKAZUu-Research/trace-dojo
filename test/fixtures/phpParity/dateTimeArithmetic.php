<?php
$d = new DateTime('2024-01-31 10:00:00');
echo $d->modify('+1 month')->format('Y-m-d H:i:s'), "\n";
$d = new DateTime('2024-01-31');
$d->add(new DateInterval('P1M'));
echo $d->format('Y-m-d'), "\n";
$d->sub(new DateInterval('P1Y2M3DT4H5M6S'));
echo $d->format('Y-m-d H:i:s'), "\n";
$im = new DateTimeImmutable('2024-03-15 08:30:00', new DateTimeZone('Asia/Tokyo'));
$im2 = $im->add(new DateInterval('PT36H'));
echo $im->format(DATE_ATOM), ' ', $im2->format(DateTimeInterface::ATOM), ' ', $im2->format('T e P'), "\n";
echo $im->getTimestamp(), ' ', $im->getOffset(), ' ', $im->getTimezone()->getName(), "\n";
$u = $im->setTimezone(new DateTimeZone('UTC'));
echo $u->format('Y-m-d H:i:s T'), "\n";
$ny = $im->setTimezone(new DateTimeZone('America/New_York'));
echo $ny->format('Y-m-d H:i:s T I'), "\n";
$a = new DateTime('2024-01-01');
$b = new DateTime('2024-12-25 15:30:00');
$diff = $a->diff($b);
echo $diff->days, ' ', $diff->format('%y %m %d %h %i %s %a %R %r %% %Y-%M-%D %H:%I:%S %F %f %x'), "\n";
echo $b->diff($a)->format('%R%a days'), ' ', $b->diff($a)->invert, "\n";
var_dump($a < $b, $a == $b, $a > $b, $a == new DateTime('2024-01-01'), max($a, $b)->format('Y'));
$c = clone $a;
$c->modify('+1 day');
echo $a->format('Y-m-d'), ' ', $c->format('Y-m-d'), "\n";
$s = new DateTime('2024-05-05 12:00');
$s->setDate(2023, 2, 29)->setTime(25, 61, 61);
echo $s->format('Y-m-d H:i:s'), "\n";
$s->setTimestamp(86400 * 365);
echo $s->format('c'), "\n";
$s->setISODate(2024, 1, 1);
echo $s->format('Y-m-d l W o'), "\n";
foreach (['2000-02-29', '1999-12-31 23:59:59', '2024-03-31'] as $x) {
  $t = new DateTime($x);
  foreach (['+1 day', '-1 month', '+1 year', 'last day of next month', 'first monday of january', 'next sunday', 'midnight', 'noon', '+1 week 2 days 4 hours'] as $m) {
    echo $x, ' | ', $m, ' => ', (clone $t)->modify($m)->format('Y-m-d H:i:s D'), "\n";
  }
}
$birth = new DateTime('2000-04-15');
$today = new DateTime('2024-04-14');
echo 'age ', $birth->diff($today)->y, "\n";
echo (new DateTime('2024-03-31'))->diff(new DateTime('2024-02-29'))->format('%R %m %d %a'), "\n";
echo (new DateTime('2024-01-31'))->diff(new DateTime('2024-03-01'))->format('%R %m %d %a'), "\n";
echo (new DateTime('2024-03-01'))->diff(new DateTime('2024-01-31'))->format('%R %m %d %a'), "\n";
echo (new DateTime('2024-01-01 10:00', new DateTimeZone('Asia/Tokyo')))->diff(new DateTime('2024-01-01 10:00'))->format('%R %d %h %i %a'), "\n";
$i = new DateInterval('P2W3D');
echo $i->d, ' ', $i->format('%d days'), "\n";
$i->invert = 1;
echo (new DateTime('2024-01-10'))->add($i)->format('Y-m-d'), "\n";
echo date_create('2024-07-04')->format('l'), ' ', date_format(date_create('@0'), 'Y'), "\n";
$dd = date_create('2024-01-01');
date_add($dd, date_interval_create_from_date_string('10 days'));
echo date_format($dd, 'Y-m-d'), "\n";
var_dump(date_diff(date_create('2024-01-01'), date_create('2024-02-01'))->days);
echo json_encode(['when' => new DateTime('2024-01-02 03:04:05')]), "\n";
print_r(new DateTimeZone('Europe/Paris'));
echo "\n";
var_dump(new DateTime('2024-06-15 12:00', new DateTimeZone('+05:30')));
var_dump(DateTime::createFromFormat('!d/m/Y', '15/08/2024'));
var_dump(DateTimeImmutable::createFromFormat('Y-m-d H:i', '2024-13-01 10:00')->format('Y-m-d'));
var_dump(DateTime::createFromFormat('Y-m-d', 'abc'), DateTime::getLastErrors());
$x = DateTime::createFromFormat('j-M-Y', '15-Feb-2009');
echo $x->format('Y-m-d'), "\n";
echo DateTime::createFromFormat('U', '1718454225')->format('c'), "\n";
echo DateTime::createFromFormat('Y-m-d H:i:s.u', '2024-01-02 03:04:05.123456')->format('u v'), "\n";
echo DateTime::createFromFormat('g:i A', '3:15 PM')->format('H:i'), "\n";
class MyDate extends DateTime { public function hi() { return 'hi ' . $this->format('Y'); } }
$md = new MyDate('2030-01-01');
echo $md->hi(), ' ', get_class($md->modify('+1 day')), "\n";
var_dump($md instanceof DateTimeInterface);
echo get_class(DateTimeImmutable::createFromMutable(new DateTime('2020-01-01'))), "\n";
echo (new DateTimeZone('Asia/Tokyo'))->getOffset(new DateTime('2024-01-01')), "\n";
echo (new DateTime('2024-01-15'))->format('L t z N jS'), "\n";
var_dump(date_interval_create_from_date_string('xyzzyx'));
try { DateInterval::createFromDateString('xyzzyx'); } catch (Exception $e) { echo get_class($e), ': ', $e->getMessage(), "\n"; }
