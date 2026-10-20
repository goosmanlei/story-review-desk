// Repository URLs are public instance metadata, never relative application routes.
function githubRepository(value){
  if(typeof value!=='string')return null;
  const match=value.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  if(!match||['.','..'].includes(match[2]))return null;
  return {url:`https://github.com/${match[1]}/${match[2]}`,name:match[2]};
}
function renderRepositoryLinks(instance){
  for(const [id,value] of [['story-repository',instance.repository],['desk-repository',instance.review_desk_repository??'https://github.com/goosmanlei/story-review-desk']]){
    const link=document.getElementById(id),repository=githubRepository(value);
    link.hidden=!repository;
    if(repository){link.href=repository.url;link.querySelector('span').textContent=repository.name+' ↗'}
    else link.removeAttribute('href');
  }
  return instance;
}
renderRepositoryLinks({});
// A wrapped mobile header must not overlap the sticky subnavigation or comments.
new ResizeObserver(([entry])=>{
  document.documentElement.style.setProperty('--review-sidebar-height',entry.target.getBoundingClientRect().height+'px');
}).observe(document.querySelector('.sidebar'));
