import test from 'node:test';
import {failedRemakeApiCase} from './fixtures/material-native-failed-remake.mjs';

for(const referenceInput of [false,true])test('native material failed unmaterialized V002 remakes as V003 with actual V001 parent and immutable failure history'+(referenceInput?' with an adopted image input':' without reference input'),
 {skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000},t=>failedRemakeApiCase(t,{referenceInput}));
