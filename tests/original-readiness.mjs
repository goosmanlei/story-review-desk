export const originalModules = [
  ['overview', '当前工作', '.workflow-work-center'],
  ['story', '故事创作', '#story'],
  ['settings', '故事设定', '.settings-workspace'],
  ['materials', '素材管理', '#materials'],
  ['pipeline', '全剧制作', '.pipeline-view'],
  ['system', '系统管理', '.system-management'],
];

// A selected navigation button is not sufficient: its necessary content and
// controls must be visible, and every mounted version-bound read must settle.
export async function originalReady(page, view, sceneId) {
  const [,label,selector] = originalModules.find(row=>row[0]===view);
  await page.waitForFunction(({label,selector,sceneId})=>{
    const visible=e=>e && !e.closest('[hidden]') && e.getClientRects().length>0;
    const selected=document.querySelector('.workspace-nav [aria-current="page"]');
    const root=document.querySelector(selector);
    if(!selected?.textContent.includes(label)||!visible(root)) return false;
    if([...document.querySelectorAll('.production-view-loading,.workspace-read-boundary[aria-busy="true"],.review-bootstrap-state')].some(visible))return false;
    if([...root.querySelectorAll('[role="status"],.workflow-refresh-time,.management-readiness strong')].some(e=>visible(e)&&/正在读取|读取中|正在装入|正在核对/.test(e.textContent)))return false;
    if(![...root.querySelectorAll('button,input,select,a')].some(e=>visible(e)&&!e.disabled))return false;
    if(sceneId){
      const reader=root.querySelector('.episode-scene-reader[data-scene-id="'+CSS.escape(sceneId)+'"]');
      if(!visible(reader)||!/^[a-f0-9]{64}$/.test(reader.dataset.sceneContentHash))return false;
      if(!root.querySelector('button[data-scene-id="'+CSS.escape(sceneId)+'"][aria-pressed="true"]'))return false;
    }
    return true;
  },{label,selector,sceneId});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

export async function timedInteraction(page, locator, ready) {
  await page.evaluate(()=>{window.__reviewClickAt=0;document.addEventListener('click',()=>{window.__reviewClickAt=performance.now();},{capture:true,once:true});});
  await locator.click();
  await ready();
  return page.evaluate(()=>performance.now()-window.__reviewClickAt);
}
