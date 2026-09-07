import assert from 'node:assert/strict';
import test from 'node:test';
import {configureClientStorage,instanceLocalStorage,instanceSessionStorage} from '../app/client-storage.ts';
function memoryStorage(){const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};}
test('browser drafts migrate only into the configured original instance and never cross stories',()=>{
 globalThis.window={localStorage:memoryStorage(),sessionStorage:memoryStorage()};
 const a={instanceId:'instance-a',capabilities:{browserStorageMigration:{prefix:'legacy.',unprefixedKeys:true}}};
 const b={instanceId:'instance-b',capabilities:{}};
 window.localStorage.setItem('legacy.reviewDraft','original review');
 window.localStorage.setItem('assistant-input','original unsent message');
 window.sessionStorage.setItem('assistant-requests','original request ID');
 configureClientStorage(a);
 assert.equal(instanceLocalStorage.getItem('review.reviewDraft'),'original review');
 assert.equal(instanceLocalStorage.getItem('assistant-input'),'original unsent message');
 assert.equal(instanceSessionStorage.getItem('assistant-requests'),'original request ID');
 configureClientStorage(b);
 assert.equal(instanceLocalStorage.getItem('review.reviewDraft'),null);
 assert.equal(instanceLocalStorage.getItem('assistant-input'),null);
 assert.equal(instanceSessionStorage.getItem('assistant-requests'),null);
 instanceLocalStorage.setItem('review.reviewDraft','second story');
 configureClientStorage(a);
 assert.equal(instanceLocalStorage.getItem('review.reviewDraft'),'original review');
 instanceLocalStorage.setItem('review.reviewDraft','updated first story');
 assert.equal(window.localStorage.getItem('legacy.reviewDraft'),'original review');
 configureClientStorage(b);
 assert.equal(instanceLocalStorage.getItem('review.reviewDraft'),'second story');
});
