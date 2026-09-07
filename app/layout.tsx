import type { Metadata } from 'next';
import './globals.css';
import './closed-comment-history.css';
import './narrative-reading.css';
import './episode-scene-navigator.css';
import { CodexConversationDock } from './codex-conversation-dock';
import { RuntimeModeProvider } from './runtime-mode';
import { AssistantContextProvider } from './assistant/context-provider';
import { InstanceProfileProvider } from './instance-context';

const siteBaseUrl = process.env.SITE_BASE_URL ?? 'http://localhost:3000';
const hostedReadOnly = process.env.REVIEW_REMOTE_READ_ONLY === '1';

export const metadata: Metadata = {
  metadataBase: new URL(siteBaseUrl),
  title: '制作审阅台',
  description: '故事创作、素材审阅与全剧制作。',
  alternates: { canonical: '/' },
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
    <html lang="zh-CN" data-runtime-mode={hostedReadOnly ? 'hosted-read-only' : 'local-write'}>
      <body><RuntimeModeProvider hostedReadOnly={hostedReadOnly}><InstanceProfileProvider><AssistantContextProvider><div className="assistant-page">{children}</div><CodexConversationDock /></AssistantContextProvider></InstanceProfileProvider></RuntimeModeProvider></body>
    </html>
  );
}
