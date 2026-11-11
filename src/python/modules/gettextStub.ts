import { registerSourceModule } from '../sourceModules';

// The parts of `gettext` that `argparse`, `optparse`, and `getopt` call. CPython finds no message catalog for them,
// since finding one reads the environment and the file system, so it returns each message untranslated as these do.
const GETTEXT_SOURCE = String.raw`
def gettext(message):
    return message


def ngettext(msgid1, msgid2, n):
    if n == 1:
        return msgid1
    return msgid2
`;

registerSourceModule('gettext', GETTEXT_SOURCE);

// The parts of CPython's private `_colorize` that `argparse` calls. Output never goes to a terminal here, so, as
// `_colorize.can_colorize()` decides for CPython's piped output, it is never colored.
const COLORIZE_SOURCE = String.raw`
class _ArgparseNoColor:
    usage = prog = prog_extra = heading = ''
    summary_long_option = summary_short_option = summary_label = summary_action = ''
    long_option = short_option = label = action = reset = ''


class _ThemeNoColor:
    argparse = _ArgparseNoColor()


theme_no_color = _ThemeNoColor()


def can_colorize(*, file=None):
    return False


def decolor(text):
    return text


def get_theme(*, tty_file=None, force_color=False, force_no_color=False):
    return theme_no_color
`;

registerSourceModule('_colorize', COLORIZE_SOURCE);
