import type { Metadata } from 'next';
import './globals.css';
import './closed-comment-history.css';
import './narrative-reading.css';
import './episode-scene-navigator.css';
import { CodexConversationDock } from './codex-conversation-dock';
import { RuntimeModeProvider } from './runtime-mode';
import { AssistantContextProvider } from './assistant/context-provider';
import { InstanceProfileProvider } from './instance-context';
import { RuntimeRequestBoundary } from './runtime-request-boundary';

const siteBaseUrl = process.env.SITE_BASE_URL ?? 'http://localhost:3000';
const hostedReadOnly = process.env.REVIEW_REMOTE_READ_ONLY === '1';
const vpsWritable = process.env.REVIEW_DEPLOYMENT_MODE === 'VPS';

export const metadata: Metadata = {
  metadataBase: new URL(siteBaseUrl),
  title: '制作审阅台',
  description: '故事创作、素材审阅与全剧制作。',
  alternates: { canonical: siteBaseUrl },
  icons: { icon: (process.env.REVIEW_BASE_PATH || '') + '/favicon.svg' },
  openGraph: {
    title: '制作审阅台',
    description: '故事 · 素材 · 目标 · 进展，一页审阅完整制作证据链。',
    url: siteBaseUrl,
    siteName: '制作审阅台',
    type: 'website',

  },
  twitter: {
    card: 'summary',
    title: '制作审阅台',
    description: '故事 · 素材 · 目标 · 进展，一页审阅完整制作证据链。',
  },
  robots: { index: false, follow: false, noarchive: true, nocache: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-runtime-mode={hostedReadOnly ? 'hosted-read-only' : vpsWritable?'vps-write':'local-write'}>
      <body><RuntimeRequestBoundary><RuntimeModeProvider hostedReadOnly={hostedReadOnly} vpsWritable={vpsWritable} publicDemo={process.env.REVIEW_VPS_ACCESS_MODE==='PUBLIC_DEMO'}><InstanceProfileProvider><AssistantContextProvider><div className="assistant-page">{children}</div><CodexConversationDock /></AssistantContextProvider></InstanceProfileProvider></RuntimeModeProvider></RuntimeRequestBoundary></body>
    </html>
  );
}
