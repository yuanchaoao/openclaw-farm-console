const $ = id => document.getElementById(id);
let savedConfig, activePort;
const fields={consolePort:'consolePort',relayHost:'relay.host',relayUser:'relay.user',sshPort:'relay.sshPort',identityFile:'relay.identityFile',podPort:'bridge.podPort',workspace:'bridge.workspace'};
function message(value){$('setupStatus').textContent=value;}
async function api(path, body){
  const response=await fetch(path,{headers:{'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw Error(result.error || '操作失败');return result;
}
function configFromForm(){return {consolePort:Number($('consolePort').value),relay:{host:$('relayHost').value.trim(),user:$('relayUser').value.trim(),sshPort:Number($('sshPort').value),identityFile:$('identityFile').value.trim(),portRange:[Number($('portMin').value),Number($('portMax').value)]},bridge:{podPort:Number($('podPort').value),workspace:$('workspace').value.trim()}};}
function dirty(){for(const id of ['createKey','showAuthorization','checkRelay','finishSetup'])$(id).disabled=true;message('配置已修改，请先保存。');}
for(const id of [...Object.keys(fields),'portMin','portMax'])$(id).addEventListener('input',dirty);
async function busy(id,task){$(id).disabled=true;try{await task();}catch(error){message(error.message);}finally{$(id).disabled=false;}}
$('setupForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{
    const initialUrl=$('initialUrl').value.trim(),token=$('initialToken').value;
    if(Boolean(initialUrl)!==Boolean(token))throw Error('登记首个实例时，请同时填写链接和完整 Token。');
    const result=await api('/api/setup',{config:configFromForm(),...(initialUrl?{initialInstance:{url:initialUrl,token,name:$('initialName').value.trim(),replace:true}}:{})});
    $('initialToken').value='';savedConfig=result.config;
    for(const id of ['createKey','showAuthorization','checkRelay'])$(id).disabled=false;
    $('finishSetup').disabled=true;
    message('配置已保存。'+(result.registration?'首个实例凭据已进入系统密钥库。':'')+(result.restartRequired?`端口将在重新启动管理台后改为 ${result.config.consolePort}；当前页面可继续完成配置。`:''));
  }catch(error){message(error.message);}finally{button.disabled=false;}
});
$('createKey').addEventListener('click',()=>busy('createKey',async()=>{const result=await api('/api/setup/ssh-key',{});$('publicKey').value=result.publicKey;message(result.created?'专用密钥已生成，请生成中继授权命令。':'已读取现有密钥的公钥，请生成中继授权命令。');}));
$('showAuthorization').addEventListener('click',()=>busy('showAuthorization',async()=>{const result=await api('/api/setup/relay-authorization');$('publicKey').value=result.publicKey;$('authorizationScript').value="python3 - <<'OPENCLAW_RELAY_AUTH'\n"+result.script+"\nOPENCLAW_RELAY_AUTH\n";$('authorizationBox').hidden=false;message(`请以 ${result.user} 账户登录 ${result.host} 并执行授权命令。`);}));
$('copyAuthorization').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('authorizationScript').value);message('授权命令已复制。');}catch{$('authorizationScript').select();message('请复制已选中的授权命令。');}});
$('checkRelay').addEventListener('click',()=>busy('checkRelay',async()=>{const result=await api('/api/setup/check-relay',{});$('finishSetup').disabled=false;message(result.message);}));
$('finishSetup').addEventListener('click',()=>busy('finishSetup',async()=>{await api('/api/setup',{config:savedConfig,complete:true});location.href='/connections.html';}));
try{const result=await api('/api/setup');savedConfig=result.config;activePort=result.activePort;for(const [id,key] of Object.entries(fields))$(id).value=key.split('.').reduce((v,k)=>v[k],savedConfig);[$('portMin').value,$('portMax').value]=savedConfig.relay.portRange;if(savedConfig.relay.host&&savedConfig.relay.user){for(const id of ['createKey','showAuthorization','checkRelay'])$(id).disabled=false;}message(result.configured?'已完成首次配置。可在这里调整并重新验证。':'先保存本机与中继设置，然后生成 SSH 公钥。');}catch(error){message(error.message);}
