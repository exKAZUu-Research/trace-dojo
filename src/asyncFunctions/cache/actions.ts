'use server';

import { revalidatePath } from 'next/cache';

export async function clearAllCaches(): Promise<void> {
  revalidatePath('/', 'layout');
}
