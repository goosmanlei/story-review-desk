import type { ReactNode } from 'react';

export function StoryWorkspaceHeading({ children }: { children: ReactNode }) {
  return <header className="section-heading story-workspace-heading">
    <div><p>STORY → SCREENPLAY</p><h2>从来源核对、结构理解到分集与逐场成稿</h2></div>
    {children}
  </header>;
}
