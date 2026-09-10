'use client';


import {runtimePath} from './runtime-path';
import { createContext, useContext, type ReactNode } from 'react';

type RuntimeMode = {
  hostedReadOnly: boolean;
  vpsWritable: boolean;
};

const RuntimeModeContext = createContext<RuntimeMode>({ hostedReadOnly: false, vpsWritable:false });

export function RuntimeModeProvider({ hostedReadOnly, vpsWritable, children }: RuntimeMode & { children: ReactNode }) {
  return <RuntimeModeContext.Provider value={{ hostedReadOnly, vpsWritable }}>
    {hostedReadOnly && <aside className="runtime-mode-banner" role="status">
      <div><b>远端只读同步镜像</b><span>可浏览当前快照并在本浏览器保存草稿；正式裁决、生成授权、运行登记、原音与SHA原件核验只在本地审阅台执行。</span></div>
      <a href={runtimePath("http://localhost:3000")}>打开本地正式入口</a>
    </aside>}
    {vpsWritable && <aside className="runtime-mode-banner" role="status"><div><b>VPS 私有可写审阅台</b><span>本次修改只保存在当前远端运行期；下一次发布或回滚会恢复本地生成的干净基线，不回传本地母本。</span></div></aside>}
    {children}
  </RuntimeModeContext.Provider>;
}

export function useRuntimeMode() {
  return useContext(RuntimeModeContext);
}
