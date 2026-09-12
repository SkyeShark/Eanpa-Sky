// Reuse the single owned browser. Preserve complete evidence without dumping
// image payloads or thousands of receiver rows into the terminal.
import {connect} from './cdp.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
const [file,out]=process.argv.slice(2);
if(!file||!out)throw new Error('Use <browser-contract.js> <result.json>');
const c=await connect();
try{
    const response=await c.send('Runtime.evaluate',{
        expression:await readFile(file,'utf8'),awaitPromise:true,returnByValue:true,
    },180000);
    if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);
    const result=response.result.value,pass=result?.pass??result?.passed;
    await mkdir(dirname(out),{recursive:true});
    await writeFile(out,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({file,out,pass,checks:result?.checks?.length,
        failures:result?.checks?.filter(check=>check.pass===false),errors:result?.errors}));
    if(pass!==true)process.exitCode=1;
}finally{c.close();}
