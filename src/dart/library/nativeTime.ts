import { define } from './nativeSupport';

define('Stopwatch._now', (runtime) => runtime.events.elapsedNanoseconds());

/** Locales whose short time zone names are the abbreviations of their regions' zones. */
const TIME_ZONE_NAME_LOCALES = ['en-US', 'ja-JP', 'en-GB', 'en-AU', 'en-IN', 'de-DE', 'fr-FR', 'ko-KR', 'zh-CN'];

// The local time zone is the host's, as the VM's is the machine's.
define('DateTime._getCurrentMicros', (runtime) => runtime.events.currentMicroseconds());
define('DateTime._timeZoneOffsetInSecondsForClampedSeconds', (_runtime, _self, [seconds]) =>
  BigInt(-new Date(Number(seconds) * 1000).getTimezoneOffset() * 60)
);
define('DateTime._timeZoneNameForClampedSeconds', (_runtime, _self, [seconds]) => {
  const date = new Date(Number(seconds) * 1000);
  const names = TIME_ZONE_NAME_LOCALES.map(
    (locale) =>
      new Intl.DateTimeFormat(locale, { timeZoneName: 'short' })
        .formatToParts(date)
        .find((part) => part.type === 'timeZoneName')?.value ?? ''
  );
  // The OS names a zone by its abbreviation, as JST or PST, which Intl gives only in the zone's own locales.
  return names.find((name) => !/^(?:GMT|UTC)[+-]/u.test(name)) ?? names[0];
});
