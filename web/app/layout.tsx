import type {Metadata} from 'next';
import './style.css';
export const metadata:Metadata={title:'故事审阅台',description:'故事创作、素材审阅与全剧制作',robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
