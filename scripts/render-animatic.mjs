#!/usr/bin/env node
import {renderAnimatic} from '../server/production/animatic-render.mjs';
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>8*1024*1024)throw Error('预演任务输入过大');}
const value=await renderAnimatic(JSON.parse(input));process.stdout.write(JSON.stringify({type:'answer',value})+'\n');
