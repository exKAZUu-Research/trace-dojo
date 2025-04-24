'use server';

import { revalidatePath } from 'next/cache';

// eslint-disable-next-line @typescript-eslint/require-await
export async function clearAllCaches(): Promise<void> {
  revalidatePath('/', 'layout');
}
