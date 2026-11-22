import { screen, waitFor } from '@testing-library/react';

export async function waitForProblemPreparation(): Promise<void> {
  await waitFor(() => {
    if (screen.queryByText('問題を準備しています')) throw new Error('The problem is still being prepared');
  });
}
