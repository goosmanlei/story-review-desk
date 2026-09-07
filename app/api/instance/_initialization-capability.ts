let cached:{until:number;value:{initialize:boolean;reason?:string}}|null=null;
export async function initializationCapability(){
  if(cached&&cached.until>Date.now())return cached.value;
  let ready=false;
  try{
    const url=new URL(process.env.MATERIAL_REVIEW_WORKER_URL||'');
    if(url.protocol!=='http:'||!['material-review-worker','127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('worker unavailable');
    const response=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(1200)});
    const body=await response.json() as {initialization?:boolean};ready=response.ok&&body.initialization===true;
  }catch{}
  const value=ready?{initialize:true}:{initialize:false,reason:'AI 初始化服务尚未就绪；仍可准备草稿并手动编辑。'};
  cached={until:Date.now()+10000,value};return value;
}
