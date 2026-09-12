import type { ImageTechnicalSpec,ImageTechnicalFacts } from '../presentation/image-technical-spec.mjs';

const purposes = {BASE_REFERENCE:'基础参考图',PREVIS_STILL:'粗分镜图',PRODUCTION_FRAME:'正式关键帧'};
export function ImageTechnicalSpecPanel({spec,hash,facts,versionSha256}:{spec?:ImageTechnicalSpec;hash?:string;facts?:ImageTechnicalFacts;versionSha256?:string|null}) {
 if (!spec || !hash) return null;
 return <section aria-label="此图的制作规格" className="configuration-card">
  <h4>{purposes[spec.purpose]}规格</h4>
  <p>{spec.dimensionPolicy==='NATIVE_ORIGINAL'
   ? '保留生成原图的实际像素尺寸；验收时核对原文件及画面内容。'
   : `目标画布 ${spec.canvas?.width ?? '待确认'} × ${spec.canvas?.height ?? '待确认'} 像素，画幅 ${spec.canvas?.aspectRatio ?? '待确认'}。`}</p>
  <p>单张 PNG 静态图片，无自身帧率。{spec.canvas && `进入 ${spec.canvas.fps==='UNKNOWN'?'待确认帧率':spec.canvas.fps+' fps'} 时间线。`}</p>
  {facts&&facts.sha256===versionSha256&&<p>本版本原图：{facts.width} × {facts.height} 像素，{facts.format}。{spec.dimensionPolicy==='EXACT_PROJECT_CANVAS'&&(facts.width!==spec.canvas?.width||facts.height!==spec.canvas?.height)&&'与固定画布不符，尚不能通过正式帧验收。'}</p>}
  <details><summary>规格凭据</summary><code>{hash}</code></details>
 </section>;
}
