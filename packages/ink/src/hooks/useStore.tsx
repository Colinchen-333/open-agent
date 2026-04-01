import React, { createContext, useContext, useEffect, useState } from 'react';
import type { Store } from '@open-agent/state';

const StoreContext = createContext<Store<any> | null>(null);

export function StoreProvider({ store, children }: { store: Store<any>; children?: React.ReactNode }) {
  return React.createElement(StoreContext.Provider, { value: store }, children);
}

export function useStore<T, R>(selector: (state: T) => R): R {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used within StoreProvider');

  const [value, setValue] = useState(() => selector(store.getState()));

  useEffect(() => {
    setValue(selector(store.getState()));
    return store.subscribe(() => {
      const next = selector(store.getState());
      setValue(next);
    });
  }, [store]);

  return value;
}
