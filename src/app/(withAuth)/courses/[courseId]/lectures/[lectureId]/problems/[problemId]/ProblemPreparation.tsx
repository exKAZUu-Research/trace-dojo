'use client';

import { Center, Spinner } from '@/infrastructures/useClient/chakra';

import { ReloadNotice } from './ReloadNotice';

/** Stands in for a problem while the browser generates it, or after it failed to. */
export const ProblemPreparation: React.FC<{ status: 'loading' | 'failed' }> = ({ status }) =>
  status === 'failed' ? (
    <ReloadNotice
      message="プログラムを実行する環境を読み込めませんでした。ページを再読み込みしてください。"
      title="問題を準備できませんでした"
    />
  ) : (
    <Center py={10}>
      <Spinner label="問題を準備しています" />
    </Center>
  );
