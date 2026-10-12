/* Novel reading reuses the original source identities, blocks and comments. */
function novelChapterForBlock(source,blockId){
  const index=source?.blocks.findIndex(block=>block.id===blockId)??-1;
  return sourceChapters(source).filter(chapter=>source.blocks.findIndex(block=>block.id===chapter.id)<=index).at(-1);
}
function novelChapterBlocks(source,chapter){
  if(!chapter)return source?.blocks||[];
  const chapters=sourceChapters(source),position=chapters.findIndex(item=>item.id===chapter.id);
  const start=source.blocks.findIndex(block=>block.id===chapter.id),next=chapters[position+1];
  return source.blocks.slice(start,next?source.blocks.findIndex(block=>block.id===next.id):undefined);
}
function novelVersionLabel(source,index){
  return '第'+(source.title.match(/^故事精修([一二三四五六七八九十百零〇\d]+)/u)?.[1]||source.order||index+1)+'版';
}
function renderNovelIndex(){
  const versions=$('#novel-index'),nav=$('#source-list');if(!versions)return;
  versions.hidden=false;const scroll=versions.scrollLeft;versions.replaceChildren();nav.replaceChildren();
  const novels=state.sources.filter(source=>source.group==='story-refinements');
  for(const [index,source] of novels.entries()){
    const active=source.id===state.current?.id,button=nodeText('button','screenplay-version source-button'+(active?' active':''),novelVersionLabel(source,index),versions);
    button.type='button';button.title=source.title;button.setAttribute('aria-current',active?'page':'false');
    button.onclick=()=>{if(!active)chooseSource(source.id)};
  }
  versions.scrollLeft=scroll;
  const chapters=sourceChapters(state.current);
  if(!chapters.some(chapter=>chapter.id===state.sourceChapter))state.sourceChapter=chapters[0]?.id||null;
  for(const chapter of chapters){
    const button=nodeText('button','source-chapter-button screenplay-scene-button'+(chapter.id===state.sourceChapter?' active':''),'',nav);
    button.type='button';button.dataset.sourceId=state.current.id;button.dataset.blockId=chapter.id;
    button.setAttribute('aria-current',chapter.id===state.sourceChapter?'location':'false');
    button.setAttribute('aria-controls','source-view');nodeText('strong',null,chapter.title,button);
    const blocks=new Set(novelChapterBlocks(state.current,chapter).map(block=>block.id));
    const count=state.comments.filter(comment=>(comment.target_object_id||comment.source_id)===state.current.id&&comment.target_revision_id===state.current.target_revision_id&&textAnchorSegments(comment.anchor).some(anchor=>blocks.has(anchor.block_id)||blocks.has(anchor.end_block_id))).length;
    commentCountLabel(button,count);button.onclick=()=>jumpSourceChapter(state.current.id,chapter.id);
  }
  if(!novels.length)nodeText('p','source-no-results','尚未发布小说。',nav);
  else if(!chapters.length)nodeText('p','source-no-results','本版按完整正文阅读。',nav);
}
function renderNovelDocument(){
  hideSelectionAction();const source=state.current,root=$('#source-view');root.replaceChildren();
  const chapter=sourceChapters(source).find(item=>item.id===state.sourceChapter);
  $('#reader-kind').textContent='小说正文';
  $('#reader-head-title').textContent=chapter?.title||source?.title||'尚未发布小说';
  $('#reader-head-detail').textContent=source?source.title.replace(/^故事精修[一二三四五六七八九十百零〇\d]+\s*[：:·—-]?\s*/u,''):'';
  if(!source){nodeText('p','empty','发布后可在这里按版本和章节阅读小说。',root);return}
  const doc=el('article','document'),text=el('section','source-text');text.id='source-text';text.setAttribute('aria-label','小说正文');
  for(const block of novelChapterBlocks(source,chapter))text.append(renderBlock(source,block,source.blocks.indexOf(block)));
  reviewSurface(text);doc.append(text);root.append(doc);
}
