import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {docker,POSTGRES_IMAGE} from '../../scripts/instance-postgres.mjs';

// Only this disposable test database exposes an ephemeral loopback port so the
// host Vite test can exercise pg.Pool. Production databases retain private ports.
export async function sharedStoryPostgres(instance) {
 const key=randomUUID().replaceAll('-',''),name='review-comments-test-'+key,volume='review_comments_test_'+key;
 const secret=path.join(instance,'runtime/private/postgres-password');
 await mkdir(path.dirname(secret),{recursive:true,mode:0o700});await writeFile(secret,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
 const cleanup=async()=>{await docker(['rm','-f',name]).catch(()=>{});await docker(['volume','rm',volume]).catch(()=>{});};
 try {
  await docker(['volume','create','--label','review.test=shared-story-comments',volume]);
  await docker(['run','-d','--name',name,'--label','review.test=shared-story-comments','--publish','127.0.0.1::5432','--mount',`type=volume,source=${volume},target=/var/lib/postgresql`,'--mount',`type=bind,source=${secret},target=/run/secrets/password,readonly`,'--env','POSTGRES_USER=review','--env','POSTGRES_DB=review','--env','POSTGRES_PASSWORD_FILE=/run/secrets/password',POSTGRES_IMAGE]);
  let ready=false;for(let n=0;n<60;n++){try{await docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','review','-d','review']);ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}if(!ready)throw new Error('Disposable comments PostgreSQL did not start');
  const inspect=JSON.parse(await docker(['inspect',name]))[0],bindings=inspect.NetworkSettings.Ports['5432/tcp'];
  if(bindings.length!==1||bindings[0].HostIp!=='127.0.0.1')throw new Error('Test PostgreSQL must bind only loopback');
  Object.assign(process.env,{REVIEW_POSTGRES_HOST:'127.0.0.1',REVIEW_POSTGRES_PORT:bindings[0].HostPort,REVIEW_POSTGRES_PASSWORD_FILE:secret,REVIEW_POSTGRES_PASSWORD:'',REVIEW_POSTGRES_USER:'review'});
  return {database:{kind:'postgres',database:'review',service:'postgres',volume:'review_pg_'+key.slice(0,20)},cleanup};
 }catch(error){await cleanup();throw error;}
}
