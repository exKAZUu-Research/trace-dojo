import { registerSourceModule } from '../sourceModules';

// The parts of CPython's private `_colorize` that `argparse`, `unittest`, and `doctest` use. Output never goes to a terminal here, so, as
// `_colorize.can_colorize()` decides for CPython's piped output, it is never colored.
const COLORIZE_SOURCE = String.raw`
class _ArgparseNoColor:
    usage = prog = prog_extra = heading = ''
    summary_long_option = summary_short_option = summary_label = summary_action = ''
    long_option = short_option = label = action = reset = ''


class _UnittestNoColor:
    passed = warn = fail = fail_info = reset = ''


class _ThemeNoColor:
    argparse = _ArgparseNoColor()
    unittest = _UnittestNoColor()


theme_no_color = _ThemeNoColor()


class ANSIColors:
    RESET = "\x1b[0m"
    RED = "\x1b[31m"
    GREEN = "\x1b[32m"
    YELLOW = "\x1b[33m"
    BOLD_RED = "\x1b[1;31m"
    BOLD_GREEN = "\x1b[1;32m"


COLORIZE = True


class _NoColors:
    def __getattr__(self, name):
        return ''


NoColors = _NoColors()


def get_colors(colorize=False, *, file=None):
    if colorize or can_colorize(file=file):
        return ANSIColors()
    return NoColors


def can_colorize(*, file=None):
    return False


def decolor(text):
    return text


def get_theme(*, tty_file=None, force_color=False, force_no_color=False):
    return theme_no_color
`;

registerSourceModule('_colorize', COLORIZE_SOURCE);
