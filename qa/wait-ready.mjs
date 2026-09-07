import {connect} from './cdp.mjs';
const cdp=await connect();
try{
    const deadline=Date.now()+180000;
    while(!await cdp.evaluate("document.getElementById('boot')?.style.display==='none'")){
        if(Date.now()>deadline) throw new Error('Scene build timed out');
        await new Promise(r=>setTimeout(r,1000));
    }
    console.log('Scene ready');
}finally{cdp.close();}
