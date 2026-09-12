'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import './system-configuration.css';

const ConfigurationWorkspace = dynamic(
  () => import('./system-configuration-workspace').then((module) => module.SystemConfigurationWorkspace),
  { loading: () => <p role="status">正在读取系统配置…</p> },
);

export function SystemConfigurationSection() {
  const section = useRef<HTMLDetailsElement>(null);
  const [hasOpened, setHasOpened] = useState(false);
  useEffect(() => {
    const openFromLink = () => {
      if (window.location.hash !== '#system-configuration' || !section.current) return;
      section.current.open = true;
      section.current.scrollIntoView({ block: 'start' });
    };
    openFromLink();
    window.addEventListener('hashchange', openFromLink);
    return () => window.removeEventListener('hashchange', openFromLink);
  }, []);
  return <details
    ref={section}
    id="system-configuration"
    className="system-configuration-section"
    onToggle={(event) => { if (event.currentTarget.open) setHasOpened(true); }}
  >
    <summary><b>系统配置</b><span>审阅标准、素材分类、流程与制作设置</span></summary>
    {hasOpened && <ConfigurationWorkspace />}
  </details>;
}
