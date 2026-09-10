import ts from 'typescript';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Mechanical migration and regression gate: intrinsic URL attributes are the
// HTTP boundary. Custom props and business JSON deliberately remain untouched.
const fix=process.argv.includes('--fix');
let count=0;
async function visit(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  const filename=path.join(directory,entry.name);
  if(entry.isDirectory()){await visit(filename);continue;}
  if(!filename.endsWith('.tsx'))continue;
  let source=await readFile(filename,'utf8');
  let tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const client=tree.statements.find(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use client');
  if(client&&tree.statements[0]!==client){
   count++;if(!fix)console.error(filename+': displaced client directive');
   else{source="'use client';\n"+source.slice(0,client.getStart(tree))+source.slice(client.end);tree=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);await writeFile(filename,source);}
  }
  const edits=[];
  function walk(node){
   if(ts.isJsxAttribute(node)&&['href','src','poster','action'].includes(node.name.getText(tree))&&node.initializer){
    const element=node.parent.parent,tag=element.tagName?.getText(tree);
    if(tag&&/^[a-z]/.test(tag)){
     const initial=node.initializer;
     const expression=ts.isJsxExpression(initial)?initial.expression:initial;
     if(expression&&!expression.getText(tree).startsWith('runtimePath(')){
      // Relative and absolute strings can also be wrapped: the helper is a
      // no-op for non-root URLs and preserves optional attribute types.
      edits.push({start:initial.getStart(tree),end:initial.end,text:'{runtimePath('+expression.getText(tree)+')}'});
     }
    }
   }
   ts.forEachChild(node,walk);
  }
  walk(tree);if(!edits.length)continue;
  count+=edits.length;
  if(!fix){console.error(filename+': '+edits.length+' unbound HTTP attributes');continue;}
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  if(!/import\s*\{[^}]*\bruntimePath\b/.test(source)){
   let relative=path.relative(path.dirname(filename),'app/runtime-path').split(path.sep).join('/');if(!relative.startsWith('.'))relative='./'+relative;
   const first=tree.statements[0];
   const offset=first&&ts.isExpressionStatement(first)&&ts.isStringLiteral(first.expression)&&first.expression.text==='use client'?first.end:0;
   source=source.slice(0,offset)+`\nimport {runtimePath} from '${relative}';\n`+source.slice(offset);
  }
  await writeFile(filename,source);
 }
}
await visit('app');
if(count&&!fix)process.exitCode=1;
console.log(JSON.stringify({attributes:count,fixed:fix}));
