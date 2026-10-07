const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context={URL,URLSearchParams};vm.createContext(context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../review_desk/static/navigation.js'),'utf8'),context);
test('each real subpage has its own complete purpose and route identity',()=>{
 const pages=[['production.approach','','故事创作方法'],['production.approach','tab=materials','生产制作方法'],['story.sources','','故事采编'],['story.outline','','故事结构'],['story.script','','剧本集场阅读与审阅'],['settings.workspace','','制作拆解'],['settings.workspace','production_tab=entities','实体管理'],['materials.workspace','','素材管理'],['production.workspace','production_tab=history','页面已退役'],['project.configuration','','故事项目配置'],['project.configuration','config_section=SYSTEM','系统与 AI'],['project.configuration','config_section=CODES','编号前缀']];
 const purposes=new Set();for(const [workspace,query,title] of pages){const parts=context.workspacePageDescriptor(workspace,new URLSearchParams(query));assert.equal(parts[1],title);assert.equal(parts.length,3);assert.ok(parts.every(v=>typeof v==='string'&&v.length>0));purposes.add(parts[2])}assert.equal(purposes.size,pages.length);
});
test('legacy entity and material routes describe the resolved subpage',()=>{
 assert.equal(context.workspacePageDescriptor('settings.workspace',new URLSearchParams('production_entity=entity-old'))[1],'实体管理');
 assert.equal(context.workspacePageDescriptor('settings.workspace',new URLSearchParams('production_tab=materials'))[1],'素材管理');
 assert.equal(context.workspacePageDescriptor('production.workspace',new URLSearchParams('production_tab=invalid'))[1],'制作拆解');
});
