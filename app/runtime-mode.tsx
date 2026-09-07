'use client';

import { createContext, useContext, type ReactNode } from 'react';

type RuntimeMode = {
  hostedReadOnly: boolean;
};

const RuntimeModeContext = createContext<RuntimeMode>({ hostedReadOnly: false });

export function RuntimeModeProvider({ hostedReadOnly, children }: RuntimeMode & { children: ReactNode }) {
  return <RuntimeModeContext.Provider value={{ hostedReadOnly }}>
    {hostedReadOnly && <aside className="runtime-mode-banner" role="status">
      <div><b>远端只读同步镜像</b><span>可浏览当前快照并在本浏览器保存草稿；正式裁决、生成授权、运行登记、原音与SHA原件核验只在本地审阅台执行。</span></div>
      <a href="http://localhost:3000">打开本地正式入口</a>
    </aside>}
    {children}
  </RuntimeModeContext.Provider>;
}

export function useRuntimeMode() {
  return useContext(RuntimeModeContext);
}
