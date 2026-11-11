import { registerSourceModule } from '../sourceModules';
import { DOCTEST_SOURCE } from './doctestSource';

registerSourceModule('doctest', DOCTEST_SOURCE, undefined, {
  unsupported: {
    testfile: 'ファイルから読み込む doctest（doctest.testfile）',
    DocFileSuite: 'ファイルから読み込む doctest（doctest.DocFileSuite）',
    debug: 'デバッガ（doctest.debug）',
    debug_src: 'デバッガ（doctest.debug_src）',
    debug_script: 'デバッガ（doctest.debug_script）',
  },
});
