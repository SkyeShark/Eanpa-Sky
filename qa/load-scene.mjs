// Navigate the existing owned page to a reproducible scene URL.
import {connect} from './cdp.mjs';
const [sky='earth',hours='10.5',quality='balanced']=process.argv.slice(2);
if(!['earth','ringworld','shieldworld'].includes(sky))throw new Error('Unknown sky');
const c=await connect();
try{
    const url=new URL('http://127.0.0.1:8378/');
    for(const [key,value]of Object.entries({benchmark:1,automated:1,skybox:sky,tod:hours,quality}))url.searchParams.set(key,value);
    await c.send('Page.navigate',{url:url.href});
    await new Promise(r=>setTimeout(r,1000));
    const deadline=Date.now()+240000;
    while(Date.now()<deadline){
        let state;try{state=await c.evaluate(`({boot:document.getElementById('boot')?.style.display,
            sky:document.getElementById('skybox')?.value,ready:!!globalThis._reflectionPipeline,
            errors:[...document.body.children].filter(e=>e.style?.zIndex==='99').map(e=>e.textContent).join('')})`)}catch{continue}
        if(state.ready&&state.boot==='none'){
            console.log(JSON.stringify(state));if(state.errors)throw new Error(state.errors);if(state.sky!==sky)throw new Error('Preset injection did not persist');break;
        }
        if(state.errors)throw new Error(state.errors);
        await new Promise(r=>setTimeout(r,2000));
    }
    if(Date.now()>=deadline)throw new Error('Sky initialization timed out');
}finally{c.close()}
