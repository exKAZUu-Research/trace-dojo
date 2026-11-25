<?php
$base = 1718454225; // 2024-06-15 12:23:45 UTC (Saturday)
$list = ['now','today','midnight','noon','tomorrow','yesterday','2024-01-31','2024-01-31 10:20','2024-01-31 10:20:30',
'2024/01/31','01/31/2024','31-01-2024','31.01.2024','@86400','@-1','2024-01-31T10:20:30Z','2024-01-31T10:20:30+09:00',
'2024-01-31T10:20:30.123456+0900','2024-01-31 10:20:30 UTC','2024-01-31 10:20:30 Asia/Tokyo',
'+1 day','-2 weeks','+1 month','1 month ago','+1 week 2 days','+1 hour','-30 minutes','+90 seconds','next monday','last friday','this friday',
'next week','last week','this week','next month','last year','first day of next month','last day of this month','first day of january 2024',
'last day of february','monday this week','sunday this week','monday next week','friday last week','monday','saturday','sun',
'1 January 2024','January 1, 2024','Jan 1 2024','1 Jan 2024 10:00','January 2024','Feb 29','tomorrow noon','today 15:30','10:30','10:30pm','3pm','3:15 PM',
'2024-02-30','2024-02-32','2024-13-01','invalid date','','  ','2024-01-31 25:00','24:00','+1 month','next day','last day','2 days ago',
'third friday of january 2024','first monday of next month','last sunday of march 2024','+2 weekdays','noon tomorrow','midnight +1 day',
'2024-W05','2024-W05-2','20240131','20240131T102030','2024-01-31 10:20:30.5','yesterday 14:00','tomorrow +2 hours','+1 year -1 day','next year','2024','1999','12/25','25 December','Dec 25','10/30/2024 3:45pm',
'Z','2024-1-5','2024-01-05 9:05','5 days','+1 days','+ 1 day','-1 day 3 hours','last monday of this month','first sat of July 2024', 'tue', 'next tue', 'saturday this week', 'this saturday', 'last saturday','next saturday', 'saturday next week'];
foreach ($list as $s) { $t = strtotime($s, $base); echo str_pad(var_export($s, true), 40), ' => ', $t === false ? 'false' : gmdate('D Y-m-d H:i:s', $t), "\n"; }
