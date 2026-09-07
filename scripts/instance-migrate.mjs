/** Migration only reads a frozen verified SQLite backup; live authority is never changed. */
import {parseArgs} from 'node:util';
import {migrateSQLiteBackup} from './instance-transfer.mjs';
const {values}=parseArgs({options:{backup:{type:'string'},output:{type:'string'}}});
if(!values.backup||!values.output)throw new Error('Usage: instance-migrate --backup VERIFIED_SQLITE_BACKUP --output NEW_POSTGRES_INSTANCE');
console.log(JSON.stringify(await migrateSQLiteBackup(values.backup,values.output),null,2));
