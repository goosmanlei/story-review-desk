// Load the real shared presentation helpers without replacing a fixture's card/router stubs.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'../review_desk/static');
const navigationModule=fs.readFileSync(path.join(root,'navigation.js'),'utf8');
const navigation=navigationModule.slice(0,navigationModule.indexOf('const workspaceRoutes='));
const cards=fs.readFileSync(path.join(root,'unified-cards.js'),'utf8');
const smallCardStart=cards.indexOf('function reviewSmallCard(');
const smallCard=cards.slice(smallCardStart,cards.indexOf('\nfunction ',smallCardStart+1));
const breakdown=fs.readFileSync(path.join(root,'production-breakdown.js'),'utf8');
const titles=['breakdownSceneTitle','breakdownShotTitle'].map(name=>{const start=breakdown.indexOf('function '+name+'(');return [name,breakdown.slice(start,breakdown.indexOf('\nfunction ',start+1))]});
const presentation=['productionButton','reviewChoiceButtons','materialModelCode'].map(name=>{const source=fs.readFileSync(path.join(root,name==='productionButton'?'production.js':'material-review.js'),'utf8'),start=source.indexOf('function '+name+'(');return [name,source.slice(start,source.indexOf('\nfunction ',start+1))]});
module.exports=context=>{
  for(const [name,source] of presentation)if(typeof context[name]!=='function')vm.runInContext(source,context,{filename:name});
  if(typeof context.businessTitle!=='function')vm.runInContext(navigation.slice(0,navigation.indexOf('/* View labels')),context,{filename:'navigation.js:business-codes'});
  if(typeof context.reviewPositionLabel!=='function')vm.runInContext(navigation,context,{filename:'navigation.js'});
  for(const [name,source] of titles)if(typeof context[name]!=='function')vm.runInContext(source,context,{filename:'production-breakdown.js:'+name});
  if(typeof context.reviewSmallCard!=='function')vm.runInContext(smallCard,context,{filename:'unified-cards.js:reviewSmallCard'});
};
