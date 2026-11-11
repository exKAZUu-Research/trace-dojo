// CPython's unittest package, whose modules run CPython's own code.
import { virtualNanoseconds } from '../../clock';
import { builtin } from '../../define';
import type { Runtime } from '../../runtime';
import { registerSourceModule } from '../../sourceModules';
import type { PyValue } from '../../values';
import { ASYNC_CASE_SOURCE } from './asyncCaseSource';
import { CASE_SOURCE } from './caseSource';
import { INIT_SOURCE } from './initSource';
import { LOADER_SOURCE } from './loaderSource';
import { LOG_SOURCE } from './logSource';
import { MAIN_SOURCE } from './mainSource';
import { RESULT_SOURCE } from './resultSource';
import { RUNNER_SOURCE } from './runnerSource';
import { SIGNALS_SOURCE } from './signalsSource';
import { SUITE_SOURCE } from './suiteSource';
import { UTIL_SOURCE } from './utilSource';

/**
 * The clock tests are timed by: the run's virtual time, which only sleeping advances, so that "Ran 3 tests in 0.000s"
 * does not depend on how fast the host runs the tests, as it rarely does for CPython's quick tests.
 */
function timingNatives(runtime: Runtime): Map<string, PyValue> {
  return new Map([
    [
      '_virtual_perf_counter',
      builtin('_virtual_perf_counter', 'none', 0, 0, () => Number(virtualNanoseconds(runtime)) / 1e9),
    ],
  ]);
}

registerSourceModule('unittest', INIT_SOURCE);
registerSourceModule('unittest.util', UTIL_SOURCE);
registerSourceModule('unittest.result', RESULT_SOURCE);
registerSourceModule('unittest.case', CASE_SOURCE, timingNatives);
registerSourceModule('unittest.suite', SUITE_SOURCE);
registerSourceModule('unittest.loader', LOADER_SOURCE);
registerSourceModule('unittest.main', MAIN_SOURCE);
registerSourceModule('unittest.runner', RUNNER_SOURCE, timingNatives);
registerSourceModule('unittest.signals', SIGNALS_SOURCE);
registerSourceModule('unittest._log', LOG_SOURCE);
registerSourceModule('unittest.async_case', ASYNC_CASE_SOURCE);
