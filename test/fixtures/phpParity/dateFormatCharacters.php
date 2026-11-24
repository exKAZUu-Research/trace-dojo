<?php
$ts = [0, 1718454225, -1, 951782400, 1704067199, 1735603200, 253402300799];
$all = 'd D j l N S w z W F m M n t L o X x Y y a A B g G h H i s u v e I O P p T Z c r U';
foreach (['UTC', 'Asia/Tokyo', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Sydney', 'Europe/Paris'] as $z) {
  date_default_timezone_set($z);
  foreach ($ts as $t) echo date($all, $t), "\n";
}
date_default_timezone_set('UTC');
echo date('\Y\-m \\\\ \d', 0), "|", date('Y\\', 0), "|\n";
echo date("l jS \of F Y h:i:s A", 1718454225), "\n";
foreach ([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31] as $d) echo date('jS ', mktime(0, 0, 0, 1, $d, 2024));
echo "\n";
var_dump(mktime(0, 0, 0, 2, 30, 2024), mktime(25, 70, 70, 13, 1, 2023), mktime(0,0,0,1,1,70), mktime(0,0,0,1,1,69), mktime(0,0,0,1,1,100));
var_dump(gmmktime(0, 0, 0, 1, 1, 2000));
var_dump(checkdate(2, 29, 2024), checkdate(2, 29, 2023), checkdate(13, 1, 2023), checkdate(1, 1, 0), checkdate(1, 1, 32767), checkdate(1,1,32768));
var_dump(idate('Y', 1718454225), idate('y', 1718454225), idate('B', 1718454225), idate('U', 5));
print_r(getdate(1718454225));
print_r(localtime(1718454225));
print_r(localtime(1718454225, true));
var_dump(cal_days_in_month(CAL_GREGORIAN, 2, 2024), cal_days_in_month(CAL_GREGORIAN, 2, 2023));
var_dump(date_default_timezone_set('Mars/Base'));
var_dump(date_default_timezone_get());
var_dump(date_default_timezone_set('asia/tokyo'));
var_dump(date_default_timezone_get());
date_default_timezone_set('Asia/Tokyo');
echo date('Y-m-d H:i:s T e', 0), "\n";
date_default_timezone_set('UTC');
var_dump(is_string(microtime()), preg_match('/^0\.\d{8} \d+$/', microtime()), is_float(microtime(true)), is_array(hrtime()), is_int(hrtime(true)));
var_dump(gmdate('Y-m-d H:i:s', 1718454225));
var_dump(date('Y', 0.5 + 1));
var_dump(DATE_ATOM, DateTimeInterface::RFC2822, DATE_COOKIE, DATE_RSS, DATE_W3C, DATE_ISO8601, DATE_RFC3339_EXTENDED, DateTime::ATOM, DATE_RFC7231, DATE_ISO8601_EXPANDED);
var_dump(cal_days_in_month(CAL_GREGORIAN, 13, 2023));
