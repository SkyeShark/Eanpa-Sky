// Compare source revisions in the same owned page without a checkout/server.
import {connect}from'./cdp.mjs';
import{execFileSync}from'node:child_process';
const [revision='current',quality='performance',weather='rain',sky='earth']=process.argv.slice(2);
if(revision!=='current'&&!/^[a-f0-9]{7,40}$/i.test(revision))throw Error('Use current or a commit hash');
if(!['performance','balanced','high'].includes(quality)||!['rain','none'].includes(weather)
 ||!['earth','ringworld','shieldworld'].includes(sky))throw Error('Invalid fixture options');
const origin='http://127.0.0.1:8378',base='31a107fae72a61adcd392440d6f7bdc5a6fb986e';
const git=['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`];
const changed=execFileSync('git',[...git,'diff','--name-only',base,'--','src','engine','vendor'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).filter(f=>f.endsWith('.js'));
const sources=new Map();
if(revision!=='current')for(const file of changed){
 try{sources.set('/'+file,execFileSync('git',[...git,'show',revision+':'+file],{maxBuffer:12e6,windowsHide:true,stdio:['ignore','pipe','ignore']}));}catch{}
}
const c=await connect(),errors=[];let remove;
try{
 await c.send('Network.setCacheDisabled',{cacheDisabled:true});
 if(sources.size){
  remove=c.on('Fetch.requestPaused',async r=>{try{
   const body=sources.get(new URL(r.request.url).pathname);
   if(!body)return await c.send('Fetch.continueRequest',{requestId:r.requestId});
   await c.send('Fetch.fulfillRequest',{requestId:r.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/javascript'},{name:'Cache-Control',value:'no-store'}],body:body.toString('base64')});
  }catch(e){errors.push(String(e));}});
  await c.send('Fetch.enable',{patterns:[...sources.keys()].map(f=>({urlPattern:origin+f+'*',requestStage:'Request'}))});
 }
 const url=`${origin}/qa/sky-fixture.html?sky=${sky}&quality=${quality}&weather=${weather}&tod=11`;
 await c.send('Page.navigate',{url});const start=Date.now();let ready=false;
 while(Date.now()-start<240000){
  await new Promise(r=>setTimeout(r,1000));
  const state=await c.evaluate('({ready:globalThis.__skyFixture?.ready===true,errors:globalThis.__skyFixture?.errors??[],early:document.getElementById("error")?.textContent})').catch(()=>null);
  if(errors.length||state?.errors.length||state?.early)throw Error(JSON.stringify({errors,state}));
  if(state?.ready){ready=true;break;}
 }
 if(!ready)throw Error('Initialization timed out');
 await c.evaluate(`globalThis.__sourceRevision=${JSON.stringify(revision==='current'?'working tree':revision)};`);
 console.log(JSON.stringify({source:revision,bootMs:Date.now()-start,overrides:[...sources.keys()],url}));
}finally{await c.send('Fetch.disable').catch(()=>{});remove?.();c.close()}
