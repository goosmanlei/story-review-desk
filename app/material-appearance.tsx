'use client';
import type {CSSProperties} from 'react';
import {CanvasSymbol,canvasTone,type CanvasIcon} from './free-canvas';
import {entityCanvasIcon} from './entity-canvas-appearance';
import type {MaterialCreatorStage} from './material-taxonomy';
import './material-appearance.css';

export const materialMediaAppearance:Record<string,{icon:CanvasIcon;tone:string}>={IMAGE:{icon:'image',tone:'#426b78'},AUDIO:{icon:'audio',tone:'#796187'},VIDEO:{icon:'video',tone:'#846230'},TEXT:{icon:'text',tone:'#596f51'},UNKNOWN:{icon:'unknown',tone:'#6c6d63'}};
export const materialProgressAppearance:Record<string,{icon:CanvasIcon;tone:string;label:string}>={INITIAL:{icon:'defined',tone:'#626b78',label:'已定义'},PRODUCTION_READY:{icon:'generate',tone:'#22678a',label:'待生成'},PENDING_REVIEW:{icon:'review',tone:'#9a6416',label:'待审阅'},APPROVED:{icon:'approved',tone:'#357052',label:'已通过'}};
export function materialStageAppearance(stage:MaterialCreatorStage|string){return materialProgressAppearance[stage]||materialProgressAppearance.INITIAL;}
export function materialCategoryAppearance(type:string){return {icon:entityCanvasIcon(type),tone:canvasTone(type)};}
export function MaterialAppearanceIcon({kind,value}:{kind:'media'|'category'|'stage';value:string}){
 const appearance=kind==='media'?materialMediaAppearance[value]||materialMediaAppearance.UNKNOWN:kind==='category'?materialCategoryAppearance(value):materialStageAppearance(value);
 return <span className="material-appearance-icon" data-material-icon-kind={kind} data-material-icon-value={value} style={{color:appearance.tone} as CSSProperties}><CanvasSymbol kind={appearance.icon}/></span>;
}
export function MaterialProgressBadge({stage}:{stage:MaterialCreatorStage|string}){
 const appearance=materialStageAppearance(stage);
 return <span className="material-progress-badge" data-material-progress={stage} style={{'--material-progress-tone':appearance.tone} as CSSProperties}><MaterialAppearanceIcon kind="stage" value={stage}/>{appearance.label}</span>;
}
