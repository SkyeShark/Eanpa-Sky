// Reuse the one owned page; never creates another browser or tab.
import {connect} from './cdp.mjs';
const [sky='earth',quality='balanced',weather='rain',hours='11']=process.argv.slice(2);
if(!['earth','ringworld','shieldworld'].includes(sky)||!['performance','balanced','high'].includes(quality))throw new Error('Unknown fixture preset');
const c=await connect();
try{
    const url=new URL('http://127.0.0.1:8378/qa/sky-fixture.html');
    for(const [key,value]of Object.entries({sky,quality,weather,tod:hours}))url.searchParams.set(key,value);
    await c.send('Page.navigate',{url:url.href});
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){
        await new Promise(r=>setTimeout(r,1500));
        const state=await c.evaluate(`({ready:globalThis.__skyFixture?.ready===true,
            errors:globalThis.__skyFixture?.errors??[],stage:globalThis._frameStage,
            pointerLocked:!!document.pointerLockElement,progress:document.getElementById('progress')?.textContent,
            earlyError:document.getElementById('error')?.textContent})`).catch(()=>null);
        if(!state)continue;
        if(state.errors.length||state.earlyError)throw new Error(JSON.stringify(state));
        if(state.ready){console.log(JSON.stringify({url:url.href,...state}));process.exitCode=0;break;}
        if(Date.now()>=deadline)throw new Error('Fixture initialization timed out');
    }
}finally{c.close()}
