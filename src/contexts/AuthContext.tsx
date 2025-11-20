'use client';

import type React from 'react';
import { createContext, useContextSelector } from 'use-context-selector';

interface Value {
  currentUserId: string;
  currentEmail?: string;
  isAdmin: boolean;
}

const Context = createContext<Value>(undefined as unknown as Value);

export function useAuthContextSelector<Selected>(selector: (value: Value) => Selected): Selected {
  return useContextSelector(Context, selector);
}

export interface Props {
  children: React.ReactNode;
  currentUserId: string;
  currentEmail?: string;
}

export const AuthContextProvider: React.FC<Props> = (props) => {
  return (
    <Context.Provider
      value={{
        currentUserId: props.currentUserId,
        currentEmail: props.currentEmail,
        isAdmin:
          (process.env.NEXT_PUBLIC_BASE_URL ?? '').includes('//localhost:') ||
          !!props.currentEmail?.endsWith('@internet.ac.jp'),
      }}
    >
      {props.children}
    </Context.Provider>
  );
};
