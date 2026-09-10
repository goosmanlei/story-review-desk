import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {configuredBasePath,deploymentMode} from '../host/instance-runtime/deployment-http.mjs';

const contract={schemaVersion:'1.0',basePath:configuredBasePath(),deploymentMode:deploymentMode(),softwareCommit:process.env.REVIEW_SOFTWARE_COMMIT||'UNVERSIONED'};
await writeFile(path.resolve('.review-build-contract.json'),JSON.stringify(contract,null,2)+'\n',{mode:0o444});
