'use client';

import React from 'react';
import { createContext, useContextSelector } from 'use-context-selector';

type Value = {
  currentUserId: string;
  currentEmail?: string;
  isAdmin: boolean;
};

const Context = createContext<Value>(undefined as unknown as Value);

export function useAuthContextSelector<Selected>(selector: (value: Value) => Selected): Selected {
  return useContextSelector(Context, selector);
}

export type Props = {
  children: React.ReactNode;
  currentUserId: string;
  currentEmail?: string;
};

export const AuthContextProvider: React.FC<Props> = (props) => {
  return (
    <Context.Provider
      value={{
        currentUserId: props.currentUserId,
        currentEmail: props.currentEmail,
        isAdmin: !!props.currentEmail?.endsWith('@internet.ac.jp'),
      }}
    >
      {props.children}
    </Context.Provider>
  );
};
