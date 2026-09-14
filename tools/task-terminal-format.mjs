import stringWidth from './vendor/terminal-width/string-width.mjs';

const segments = new Intl.Segmenter(undefined, {granularity:'grapheme'});
const entities = {amp:'&',lt:'<',gt:'>','#92':'\\','#124':'|','#96':'`','#91':'[','#93':']','#42':'*','#95':'_'};
// Decode exactly one layer of the shared renderer's escaping. Literal user
// "<br>" stays one cell value; only the renderer's trusted separators split it.
const plainCell = value => value.replace(/&(amp|lt|gt|#92|#124|#96|#91|#93|#42|#95);/g,(_,key)=>entities[key]);
const visible = value => value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const logicalLines = value => value.split('<br>').map(v=>visible(plainCell(v)));
const cellWidth = value => Math.max(0,...logicalLines(value).map(v=>stringWidth(v)));
export function wrapTerminalText(value,width) {
  const lines=[];let line='',used=0;
  for(const {segment} of segments.segment(value)) {
    const size=stringWidth(segment);
    if(used+size>width&&line){lines.push(line);line='';used=0;}
    line+=segment;used+=size;
  }
  lines.push(line);return lines;
}
function columnWidths(headers,rows,width) {
  const natural=headers.map((h,i)=>Math.max(cellWidth(h),...rows.map(r=>cellWidth(r[i]))));
  const title=headers.indexOf('任务标题');
  const flexible=title>=0?title:headers.length-1;
  const caps=title>=0?[14,Infinity,8,14,6,10,14]:headers.map((_,i)=>i===flexible?Infinity:20);
  const widths=natural.map((n,i)=>i===flexible?2:Math.max(2,Math.min(n,caps[i])));
  const available=width-(3*headers.length+1),reserve=Math.min(12,available-2*(headers.length-1));
  while(widths.reduce((a,b)=>a+b,0)-widths[flexible]+reserve>available) {
    const candidates=widths.map((size,i)=>({size,i})).filter(x=>x.i!==flexible&&x.size>2).sort((a,b)=>b.size-a.size||a.i-b.i);
    if(!candidates.length)throw Error('终端宽度不足以保留所有列');
    widths[candidates[0].i]--;
  }
  widths[flexible]=available-widths.reduce((a,b)=>a+b,0)+widths[flexible];
  return widths;
}
function terminalTable(headers,rows,width) {
  if(rows.some(r=>r.length!==headers.length))throw Error('共享表格列数不一致');
  const widths=columnWidths(headers,rows,width);
  const border='+'+widths.map(w=>'-'.repeat(w+2)).join('+')+'+';
  const physical=row=>{
    const cells=row.map((cell,i)=>logicalLines(cell).flatMap(line=>wrapTerminalText(line,widths[i])));
    return Array.from({length:Math.max(...cells.map(c=>c.length))},(_,n)=>
      '| '+cells.map((c,i)=>{const s=c[n]||'';return s+' '.repeat(Math.max(0,widths[i]-stringWidth(s)));}).join(' | ')+' |');
  };
  return [border,...physical(headers),border,...rows.flatMap(row=>[...physical(row),border])].join('\n');
}
/** Adapt the exact shared Markdown tables for terminals that cannot render HTML
 * cell breaks. No separate task selection, values, identifiers or numbering. */
export function formatTaskTerminal(markdown,{width=120}={}) {
  if(!Number.isSafeInteger(width)||width<40||width>400)throw Error('终端宽度须为40到400的整数');
  const lines=markdown.split('\n'),output=[];
  for(let i=0;i<lines.length;) {
    if(lines[i].startsWith('| ')&&lines[i].endsWith(' |')&&/^\|(?: --- \|)+$/.test(lines[i+1]||'')) {
      const fields=line=>line.slice(2,-2).split(' | ');
      const headers=fields(lines[i]),rows=[];i+=2;
      while(i<lines.length&&lines[i].startsWith('| ')&&lines[i].endsWith(' |'))rows.push(fields(lines[i++]));
      output.push(terminalTable(headers,rows,width));
    } else output.push(...wrapTerminalText(visible(lines[i++]),width));
  }
  return output.join('\n');
}
