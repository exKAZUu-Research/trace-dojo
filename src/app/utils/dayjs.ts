import { extend, locale } from 'dayjs';
import ja from 'dayjs/locale/ja';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';

locale(ja);
extend(duration);
extend(relativeTime);

export { default as dayjs } from 'dayjs';
