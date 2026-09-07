import {publishedInitializationProjection} from '../_published-initialization';
import {initializationCapability} from '../_initialization-capability';
import {getInitialization} from '../../../../host/instance-runtime/domain-service.mjs';
import {defaultDomainConfiguration} from '../../../../host/instance-runtime/domain-defaults.mjs';
import {hostedReadOnlyMode,reviewData} from '../../v8/_store';
import {domainRepository,domainMutation,domainError,jsonResponse,HttpError} from '../_domain';
export async function GET(){try{if(hostedReadOnlyMode()){const data=await reviewData(),projection=publishedInitializationProjection(data.productionModel);return jsonResponse({releaseId:'HOSTED_READ_ONLY',state:projection.state,sourceCount:projection.sourceCount,draft:null,published:projection.published,aiTask:null,defaults:defaultDomainConfiguration(),readOnly:true});}const repo=await domainRepository(),capabilities=await initializationCapability();return await repo.readTransaction(async tx=>jsonResponse({...await getInitialization(tx),capabilities}));}catch(e){return domainError(e);}}
export async function POST(request:Request){try{await domainMutation(request);throw new HttpError(409,'系统初始化不再确认业务内容。请分别核对系统配置、故事设定及素材需求。旧初始化记录继续只读保留。');}catch(e){return domainError(e);}}
